import type {
    AgentSession,
    ConfirmationRequest,
    LoopState,
    OperatorError,
    RoutedOutcome,
    TokenUsage
} from '@op-shared/types'
import { createAgentLoop } from '../main/loop'
import { SessionManager } from '../main/session'
import { addUsage, emptyUsage, estimateCostUsd } from '../shared/usage'
import {
    DeterministicClock,
    DeterministicIdGenerator,
    ScriptedExecutor,
    ScriptedPerception,
    ScriptedReasoning,
    ScriptedSafetyGate
} from './scripted-collaborators'
import { OPERATOR_EVAL_SCENARIOS } from './scenarios'
import type {
    EvalAssertion,
    EvalAssertionValue,
    EvalEfficiency,
    EvalExpectation,
    EvalMetrics,
    EvalScenario,
    EvalScenarioKind,
    EvalScenarioResult,
    EvalTerminalState,
    OperatorEvalReport
} from './types'

const EVAL_START_MS = Date.UTC(2026, 0, 1, 12, 0, 0)
const SCENARIO_TIME_OFFSET_MS = 60_000

function round(value: number, places = 4): number {
    const scale = 10 ** places
    return Math.round(value * scale) / scale
}

function terminalState(finalState: LoopState): EvalTerminalState {
    switch (finalState) {
        case 'completed':
        case 'failed':
        case 'stopped':
        case 'budget-exhausted':
            return finalState
        default:
            return null
    }
}

function aggregateUsage(session: AgentSession): TokenUsage {
    return session.trajectory.reduce(
        (total, step) => addUsage(total, step.reasoning.usage ?? emptyUsage()),
        emptyUsage()
    )
}

function aggregateCost(session: AgentSession): number | null {
    let total = 0
    for (const step of session.trajectory) {
        if (!step.reasoning.usage) continue
        const cost = estimateCostUsd(step.reasoning.model, step.reasoning.usage)
        if (cost === undefined) return null
        total += cost
    }
    return round(total, 8)
}

function countRetriedReasoningFailures(outcomes: readonly RoutedOutcome[]): number {
    return outcomes.slice(0, -1).filter((outcome) => outcome.kind === 'failure').length
}

function calculateEfficiency(
    kind: EvalScenarioKind,
    taskSucceeded: boolean,
    steps: number,
    stepBudget: number,
    executedActions: number,
    successfulActions: number,
    totalTokens: number
): EvalEfficiency {
    const actionSuccessRate = executedActions === 0
        ? taskSucceeded ? 1 : 0
        : successfulActions / executedActions
    const productiveSteps = successfulActions + (taskSucceeded ? 1 : 0)
    const productiveStepRate = steps === 0 ? 0 : Math.min(1, productiveSteps / steps)
    return {
        score: kind === 'guardrail'
            ? null
            : taskSucceeded
                ? round(productiveStepRate * actionSuccessRate * 100, 2)
                : 0,
        productiveStepRate: round(productiveStepRate),
        actionSuccessRate: round(actionSuccessRate),
        budgetUtilization: round(steps / stepBudget),
        stepsPerSuccessfulAction:
            successfulActions === 0 ? null : round(steps / successfulActions),
        tokensPerSuccessfulAction:
            successfulActions === 0 ? null : round(totalTokens / successfulActions, 2)
    }
}

function buildAssertions(expected: EvalExpectation, metrics: EvalMetrics): EvalAssertion[] {
    const actual: Record<keyof EvalExpectation, EvalAssertionValue> = {
        finalState: metrics.finalState,
        terminalState: metrics.terminalState,
        sessionStatus: metrics.sessionStatus,
        goalSatisfied: metrics.goalSatisfied,
        completionSignaled: metrics.completionSignaled,
        taskSucceeded: metrics.taskSucceeded,
        steps: metrics.steps,
        proposedActions: metrics.proposedActions,
        executedActions: metrics.executedActions,
        successfulActions: metrics.successfulActions,
        actionFailures: metrics.actionFailures,
        blockedActions: metrics.blockedActions,
        reasoningFailures: metrics.reasoningFailures,
        reasoningRetries: metrics.reasoningRetries,
        executorCalls: metrics.executorCalls,
        confirmationRequests: metrics.confirmationRequests,
        selfCorrectionObserved: metrics.selfCorrectionObserved
    }
    return (Object.keys(expected) as Array<keyof EvalExpectation>).map((metric) => ({
        metric,
        expected: expected[metric],
        actual: actual[metric],
        passed: Object.is(expected[metric], actual[metric])
    }))
}

async function resolveConfirmations(
    loop: ReturnType<typeof createAgentLoop>,
    requests: ConfirmationRequest[],
    decisions: readonly boolean[]
): Promise<{ approved: number; declined: number }> {
    let resolved = 0
    let approved = 0
    let declined = 0
    while (loop.getState() === 'awaiting-confirmation') {
        const request = requests[resolved]
        const decision = decisions[resolved]
        if (!request || decision === undefined) {
            throw new Error('Scenario suspended for confirmation without a scripted decision')
        }
        if (decision) approved += 1
        else declined += 1
        resolved += 1
        await loop.confirm({ stepId: request.stepId, approved: decision })
    }
    return { approved, declined }
}

export async function runEvalScenario(
    scenario: EvalScenario,
    scenarioIndex = 0
): Promise<EvalScenarioResult> {
    const clock = new DeterministicClock(
        EVAL_START_MS + scenarioIndex * SCENARIO_TIME_OFFSET_MS
    )
    const ids = new DeterministicIdGenerator()
    const session = new SessionManager({ now: clock.now, generateId: ids.generate })
    const created = session.createSession({
        goal: scenario.goal,
        autonomy: scenario.autonomy,
        stepBudget: scenario.stepBudget,
        environment: 'browser'
    })
    if (!created.ok) throw new Error(`Could not create eval session: ${created.reason}`)

    const perception = new ScriptedPerception(clock, ids)
    const reasoning = new ScriptedReasoning(scenario.reasoning, clock)
    const safety = new ScriptedSafetyGate(scenario.safety, clock)
    const executor = new ScriptedExecutor(scenario.actionResults, clock)
    const confirmationRequests: ConfirmationRequest[] = []
    const emittedErrors: OperatorError[] = []
    const loop = createAgentLoop({
        perception,
        reasoning,
        safety,
        executor,
        session,
        getPermissions: () => ({ screenRecording: 'granted', accessibility: 'granted' }),
        now: clock.now,
        generateId: ids.generate,
        emitters: {
            emitConfirmationRequired: (request) => confirmationRequests.push(request),
            emitError: (error) => emittedErrors.push(error)
        }
    })

    const startedAt = clock.value
    await loop.start()
    const confirmations = await resolveConfirmations(
        loop,
        confirmationRequests,
        scenario.confirmationDecisions ?? []
    )
    const completedSession = session.getSession()
    if (!completedSession) throw new Error('Eval session disappeared during execution')

    const finalState = loop.getState()
    const proposedActions = completedSession.trajectory.filter(
        (step) => step.reasoning.outcome === 'action'
    ).length
    const executedActions = executor.outcomes.length
    const successfulActions = executor.outcomes.filter(
        (outcome) => outcome.status === 'success'
    ).length
    const actionFailures = executor.outcomes.filter(
        (outcome) => outcome.status !== 'success'
    ).length
    const blockedActions = Math.max(0, proposedActions - executedActions)
    const reasoningFailures = reasoning.returnedOutcomes.filter(
        (outcome) => outcome.kind === 'failure'
    ).length
    const reasoningRetries = countRetriedReasoningFailures(reasoning.returnedOutcomes)
    const completionSignaled = completedSession.trajectory.some(
        (step) => step.reasoning.outcome === 'completion'
    )
    const goalSatisfied = executor.goalSatisfied
    const taskSucceeded = goalSatisfied && completionSignaled
    const selfCorrectionObserved = reasoning.contexts.some((context) =>
        context.guidance?.some((item) => item.includes('SELF-CORRECTION:')) === true
    )
    const tokens = aggregateUsage(completedSession)
    const metrics: EvalMetrics = {
        goalSatisfied,
        completionSignaled,
        taskSucceeded,
        finalState,
        terminalState: terminalState(finalState),
        sessionStatus: completedSession.status,
        steps: completedSession.trajectory.length,
        proposedActions,
        executedActions,
        successfulActions,
        actionFailures,
        blockedActions,
        reasoningCalls: reasoning.calls,
        reasoningFailures,
        reasoningRetries,
        perceptionCaptures: perception.captures,
        executorCalls: executor.calls,
        safetyEvaluations: safety.evaluations,
        confirmationRequests: confirmationRequests.length,
        confirmationsApproved: confirmations.approved,
        confirmationsDeclined: confirmations.declined,
        selfCorrectionObserved,
        emittedErrors: emittedErrors.length,
        durationMs: clock.value - startedAt,
        tokens,
        estimatedCostUsd: aggregateCost(completedSession),
        efficiency: calculateEfficiency(
            scenario.kind,
            taskSucceeded,
            completedSession.trajectory.length,
            scenario.stepBudget,
            executedActions,
            successfulActions,
            tokens.totalTokens
        )
    }
    const assertions = buildAssertions(scenario.expected, metrics)
    return {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        kind: scenario.kind,
        passed: assertions.every((assertion) => assertion.passed),
        assertions,
        metrics
    }
}

export async function runOperatorEvals(
    scenarios: readonly EvalScenario[] = OPERATOR_EVAL_SCENARIOS
): Promise<OperatorEvalReport> {
    const results: EvalScenarioResult[] = []
    for (const [index, scenario] of scenarios.entries()) {
        results.push(await runEvalScenario(scenario, index))
    }

    const passedCount = results.filter((result) => result.passed).length
    const goalResults = results.filter((result) => result.kind === 'goal')
    const guardrailResults = results.filter((result) => result.kind === 'guardrail')
    const goalSuccessCount = goalResults.filter(
        (result) => result.metrics.taskSucceeded
    ).length
    const guardrailPassedCount = guardrailResults.filter((result) => result.passed).length
    const goalEfficiencyScores = goalResults
        .map((result) => result.metrics.efficiency.score)
        .filter((score): score is number => score !== null)
    const totalUsage = results.reduce(
        (total, result) => addUsage(total, result.metrics.tokens),
        emptyUsage()
    )
    const knownCosts = results.map((result) => result.metrics.estimatedCostUsd)
    const totalCost = knownCosts.some((cost) => cost === null)
        ? null
        : round(knownCosts.reduce<number>((total, cost) => total + (cost ?? 0), 0), 8)

    return {
        schemaVersion: 2,
        suite: 'operator-agent-loop',
        deterministic: true,
        generatedAt: new Date(EVAL_START_MS).toISOString(),
        passed: passedCount === results.length,
        summary: {
            scenarioCount: results.length,
            passedCount,
            passRate: results.length === 0 ? 0 : round(passedCount / results.length),
            goalScenarioCount: goalResults.length,
            goalSuccessCount,
            goalSuccessRate:
                goalResults.length === 0 ? 0 : round(goalSuccessCount / goalResults.length),
            guardrailScenarioCount: guardrailResults.length,
            guardrailPassedCount,
            guardrailPassRate:
                guardrailResults.length === 0
                    ? 0
                    : round(guardrailPassedCount / guardrailResults.length),
            averageGoalEfficiency:
                goalEfficiencyScores.length === 0
                    ? 0
                    : round(
                        goalEfficiencyScores.reduce((total, score) => total + score, 0) /
                        goalEfficiencyScores.length,
                        2
                    ),
            totals: {
                steps: results.reduce((total, result) => total + result.metrics.steps, 0),
                proposedActions: results.reduce(
                    (total, result) => total + result.metrics.proposedActions,
                    0
                ),
                executedActions: results.reduce(
                    (total, result) => total + result.metrics.executedActions,
                    0
                ),
                actionFailures: results.reduce(
                    (total, result) => total + result.metrics.actionFailures,
                    0
                ),
                blockedActions: results.reduce(
                    (total, result) => total + result.metrics.blockedActions,
                    0
                ),
                reasoningFailures: results.reduce(
                    (total, result) => total + result.metrics.reasoningFailures,
                    0
                ),
                reasoningRetries: results.reduce(
                    (total, result) => total + result.metrics.reasoningRetries,
                    0
                ),
                durationMs: results.reduce(
                    (total, result) => total + result.metrics.durationMs,
                    0
                ),
                tokens: totalUsage,
                estimatedCostUsd: totalCost
            }
        },
        scenarios: results
    }
}
