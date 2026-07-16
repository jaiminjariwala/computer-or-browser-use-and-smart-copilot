import type { Action, RoutedOutcome, TokenUsage } from '@op-shared/types'
import type { EvalScenario, ScriptedActionResult } from './types'

const PROVIDER_ID = 'eval-provider'
const MODEL_ID = 'gpt-4o-mini'

function usage(promptTokens: number, completionTokens: number): TokenUsage {
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
    }
}

function action(
    value: Action,
    rationale: string,
    promptTokens = 180,
    completionTokens = 24
): RoutedOutcome {
    return {
        kind: 'action',
        action: value,
        rationale,
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        usage: usage(promptTokens, completionTokens)
    }
}

function completion(
    summary: string,
    promptTokens = 120,
    completionTokens = 18
): RoutedOutcome {
    return {
        kind: 'completion',
        summary,
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        usage: usage(promptTokens, completionTokens)
    }
}

function reasoningFailure(reason: string): RoutedOutcome {
    return {
        kind: 'failure',
        reason,
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        usage: usage(90, 8)
    }
}

function success(options: {
    durationMs?: number
    expectedAction?: Action
    goalState?: 'satisfied' | 'unsatisfied'
} = {}): ScriptedActionResult {
    return {
        status: 'success',
        mode: 'api',
        durationMs: options.durationMs ?? 80,
        ...(options.expectedAction ? { expectedAction: options.expectedAction } : {}),
        ...(options.goalState ? { goalState: options.goalState } : {})
    }
}

const failedClick = (reason: string): ScriptedActionResult => ({
    status: 'failure',
    reason,
    mode: 'api',
    durationMs: 80
})

export const OPERATOR_EVAL_SCENARIOS: readonly EvalScenario[] = [
    {
        id: 'straight-line-success',
        name: 'Straight-line success',
        description: 'Executes one goal-satisfying action and then reports completion.',
        kind: 'goal',
        goal: 'Refresh the current page and report when it is ready.',
        autonomy: 'autonomous',
        stepBudget: 6,
        reasoning: [
            action({ kind: 'key', keys: ['META', 'R'] }, 'Refresh the current page.'),
            completion('The page refreshed successfully.')
        ],
        actionResults: [
            success({
                expectedAction: { kind: 'key', keys: ['META', 'R'] },
                goalState: 'satisfied'
            })
        ],
        safety: 'allow',
        expected: {
            finalState: 'completed',
            terminalState: 'completed',
            sessionStatus: 'completed',
            goalSatisfied: true,
            completionSignaled: true,
            taskSucceeded: true,
            steps: 2,
            proposedActions: 1,
            executedActions: 1,
            successfulActions: 1,
            actionFailures: 0,
            blockedActions: 0,
            reasoningFailures: 0,
            reasoningRetries: 0,
            executorCalls: 1,
            confirmationRequests: 0,
            selfCorrectionObserved: false
        }
    },
    {
        id: 'recoverable-action-failure',
        name: 'Threshold self-correction',
        description: 'Crosses the production failure threshold, receives corrective guidance, and switches approach.',
        kind: 'goal',
        goal: 'Focus the next available control after abandoned click attempts.',
        autonomy: 'autonomous',
        stepBudget: 7,
        reasoning: [
            action({ kind: 'left_click', at: { x: 320, y: 240 } }, 'Try the first visible control.'),
            action({ kind: 'left_click', at: { x: 360, y: 240 } }, 'Try a nearby alternate control.'),
            action({ kind: 'left_click', at: { x: 400, y: 240 } }, 'Try one final visible control.'),
            action({ kind: 'key', keys: ['TAB'] }, 'Abandon clicking and use keyboard focus.'),
            completion('The next control is focused.')
        ],
        actionResults: [
            failedClick('The first target changed before the click completed.'),
            failedClick('The alternate target was no longer actionable.'),
            failedClick('The final click target did not accept input.'),
            success({
                durationMs: 70,
                expectedAction: { kind: 'key', keys: ['TAB'] },
                goalState: 'satisfied'
            })
        ],
        safety: 'allow',
        expected: {
            finalState: 'completed',
            terminalState: 'completed',
            sessionStatus: 'completed',
            goalSatisfied: true,
            completionSignaled: true,
            taskSucceeded: true,
            steps: 5,
            proposedActions: 4,
            executedActions: 4,
            successfulActions: 1,
            actionFailures: 3,
            blockedActions: 0,
            reasoningFailures: 0,
            reasoningRetries: 0,
            executorCalls: 4,
            confirmationRequests: 0,
            selfCorrectionObserved: true
        }
    },
    {
        id: 'reasoning-failure-retry',
        name: 'Routed reasoning failure retry',
        description: 'Records a routed reasoning failure, retries the loop, and completes.',
        kind: 'goal',
        goal: 'Focus the address bar and confirm it is ready.',
        autonomy: 'autonomous',
        stepBudget: 6,
        reasoning: [
            reasoningFailure('routed-reasoning-failure: scripted transient response'),
            action({ kind: 'key', keys: ['META', 'L'] }, 'Retry with a valid keyboard action.'),
            completion('The address bar is focused.')
        ],
        actionResults: [
            success({
                expectedAction: { kind: 'key', keys: ['META', 'L'] },
                goalState: 'satisfied'
            })
        ],
        safety: 'allow',
        expected: {
            finalState: 'completed',
            terminalState: 'completed',
            sessionStatus: 'completed',
            goalSatisfied: true,
            completionSignaled: true,
            taskSucceeded: true,
            steps: 3,
            proposedActions: 1,
            executedActions: 1,
            successfulActions: 1,
            actionFailures: 0,
            blockedActions: 0,
            reasoningFailures: 1,
            reasoningRetries: 1,
            executorCalls: 1,
            confirmationRequests: 0,
            selfCorrectionObserved: false
        }
    },
    {
        id: 'step-budget-exhaustion',
        name: 'Step-budget enforcement',
        description: 'Stops before a third action when the configured budget is reached.',
        kind: 'guardrail',
        goal: 'Continue waiting until a condition changes.',
        autonomy: 'autonomous',
        stepBudget: 2,
        reasoning: [
            action({ kind: 'wait', ms: 100 }, 'Wait for the first update.'),
            action({ kind: 'wait', ms: 100 }, 'Wait once more for the update.'),
            action({ kind: 'wait', ms: 100 }, 'This action must never execute.')
        ],
        actionResults: [
            success({ durationMs: 100 }),
            success({ durationMs: 100 })
        ],
        safety: 'allow',
        expected: {
            finalState: 'budget-exhausted',
            terminalState: 'budget-exhausted',
            sessionStatus: 'budget-exhausted',
            goalSatisfied: false,
            completionSignaled: false,
            taskSucceeded: false,
            steps: 2,
            proposedActions: 2,
            executedActions: 2,
            successfulActions: 2,
            actionFailures: 0,
            blockedActions: 0,
            reasoningFailures: 0,
            reasoningRetries: 0,
            executorCalls: 2,
            confirmationRequests: 0,
            selfCorrectionObserved: false
        }
    },
    {
        id: 'confirmation-approved',
        name: 'Confirmation approval',
        description: 'Suspends for confirmation, executes only after approval, and completes.',
        kind: 'goal',
        goal: 'Submit the prepared form after explicit approval.',
        autonomy: 'manual',
        stepBudget: 5,
        reasoning: [
            action({ kind: 'key', keys: ['ENTER'] }, 'Submit the prepared form.'),
            completion('The approved form submission completed.')
        ],
        actionResults: [
            success({
                expectedAction: { kind: 'key', keys: ['ENTER'] },
                goalState: 'satisfied'
            })
        ],
        safety: 'require-confirmation',
        confirmationDecisions: [true],
        expected: {
            finalState: 'completed',
            terminalState: 'completed',
            sessionStatus: 'completed',
            goalSatisfied: true,
            completionSignaled: true,
            taskSucceeded: true,
            steps: 2,
            proposedActions: 1,
            executedActions: 1,
            successfulActions: 1,
            actionFailures: 0,
            blockedActions: 0,
            reasoningFailures: 0,
            reasoningRetries: 0,
            executorCalls: 1,
            confirmationRequests: 1,
            selfCorrectionObserved: false
        }
    },
    {
        id: 'safety-blocked',
        name: 'Fail-closed safety block',
        description: 'Records a simulated permission block and never calls the executor.',
        kind: 'guardrail',
        goal: 'Click a control while a required permission is unavailable.',
        autonomy: 'autonomous',
        stepBudget: 4,
        reasoning: [
            action({ kind: 'left_click', at: { x: 400, y: 300 } }, 'Try the requested control.')
        ],
        actionResults: [],
        safety: 'block-permission',
        expected: {
            finalState: 'paused',
            terminalState: null,
            sessionStatus: 'paused',
            goalSatisfied: false,
            completionSignaled: false,
            taskSucceeded: false,
            steps: 1,
            proposedActions: 1,
            executedActions: 0,
            successfulActions: 0,
            actionFailures: 0,
            blockedActions: 1,
            reasoningFailures: 0,
            reasoningRetries: 0,
            executorCalls: 0,
            confirmationRequests: 0,
            selfCorrectionObserved: false
        }
    }
]
