import type {
    Action,
    ActionResult,
    AutonomyLevel,
    LoopState,
    RoutedOutcome,
    SessionStatus,
    TokenUsage
} from '@op-shared/types'

export type EvalScenarioKind = 'goal' | 'guardrail'

export type EvalTerminalState = Extract<
    LoopState,
    'completed' | 'failed' | 'stopped' | 'budget-exhausted'
> | null

export type ScriptedSafetyMode = 'allow' | 'require-confirmation' | 'block-permission'

export interface ScriptedActionResult {
    status: ActionResult['status']
    reason?: string
    mode?: ActionResult['mode']
    durationMs?: number
    /** Exact action required before this result may change scripted world state. */
    expectedAction?: Action
    /** Independent scripted-world transition applied only after a matching success. */
    goalState?: 'satisfied' | 'unsatisfied'
}

export interface EvalExpectation {
    finalState: LoopState
    terminalState: EvalTerminalState
    sessionStatus: SessionStatus
    goalSatisfied: boolean
    completionSignaled: boolean
    taskSucceeded: boolean
    steps: number
    proposedActions: number
    executedActions: number
    successfulActions: number
    actionFailures: number
    blockedActions: number
    reasoningFailures: number
    reasoningRetries: number
    executorCalls: number
    confirmationRequests: number
    selfCorrectionObserved: boolean
}

export interface EvalScenario {
    id: string
    name: string
    description: string
    kind: EvalScenarioKind
    goal: string
    autonomy: AutonomyLevel
    stepBudget: number
    reasoning: readonly RoutedOutcome[]
    actionResults: readonly ScriptedActionResult[]
    safety: ScriptedSafetyMode
    confirmationDecisions?: readonly boolean[]
    expected: EvalExpectation
}

export type EvalAssertionValue = string | number | boolean | null

export interface EvalAssertion {
    metric: keyof EvalExpectation
    expected: EvalAssertionValue
    actual: EvalAssertionValue
    passed: boolean
}

export interface EvalEfficiency {
    /** Guardrails intentionally have no task-efficiency score. */
    score: number | null
    productiveStepRate: number
    actionSuccessRate: number
    budgetUtilization: number
    stepsPerSuccessfulAction: number | null
    tokensPerSuccessfulAction: number | null
}

export interface EvalMetrics {
    goalSatisfied: boolean
    completionSignaled: boolean
    taskSucceeded: boolean
    finalState: LoopState
    terminalState: EvalTerminalState
    sessionStatus: SessionStatus
    steps: number
    proposedActions: number
    executedActions: number
    successfulActions: number
    actionFailures: number
    blockedActions: number
    reasoningCalls: number
    reasoningFailures: number
    reasoningRetries: number
    perceptionCaptures: number
    executorCalls: number
    safetyEvaluations: number
    confirmationRequests: number
    confirmationsApproved: number
    confirmationsDeclined: number
    selfCorrectionObserved: boolean
    emittedErrors: number
    durationMs: number
    tokens: TokenUsage
    estimatedCostUsd: number | null
    efficiency: EvalEfficiency
}

export interface EvalScenarioResult {
    id: string
    name: string
    description: string
    kind: EvalScenarioKind
    passed: boolean
    assertions: EvalAssertion[]
    metrics: EvalMetrics
}

export interface EvalTotals {
    steps: number
    proposedActions: number
    executedActions: number
    actionFailures: number
    blockedActions: number
    reasoningFailures: number
    reasoningRetries: number
    durationMs: number
    tokens: TokenUsage
    estimatedCostUsd: number | null
}

export interface EvalSummary {
    scenarioCount: number
    passedCount: number
    passRate: number
    goalScenarioCount: number
    goalSuccessCount: number
    goalSuccessRate: number
    guardrailScenarioCount: number
    guardrailPassedCount: number
    guardrailPassRate: number
    averageGoalEfficiency: number
    totals: EvalTotals
}

export interface OperatorEvalReport {
    schemaVersion: 2
    suite: 'operator-agent-loop'
    deterministic: true
    generatedAt: string
    passed: boolean
    summary: EvalSummary
    scenarios: EvalScenarioResult[]
}
