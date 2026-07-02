import type {
    Action,
    ActionResult,
    AgentSession,
    AutonomyLevel,
    Observation,
    ReasoningStep,
    SafetyEvent,
    SessionStatus,
    TrajectoryStep,
    TrajectorySummary
} from '@op-shared/types'
import { isAction } from '@op-shared/types'

/**
 * Persisted-session codec + shape validation (Task 12.3).
 *
 * Serializes an {@link AgentSession} to a string and back. `decode` re-validates
 * the parsed object against the full session shape (including the chronological,
 * strictly-increasing Trajectory invariant, Req 14.2) and throws on any mismatch
 * so the store can treat a corrupt or foreign file exactly like a missing one
 * and require a fresh session (Req 18.6) rather than restoring garbage.
 */

/**
 * Serializes an {@link AgentSession} to a string and back. Injectable for tests;
 * the default encodes pretty-printed JSON and decodes with shape validation so a
 * corrupt or foreign file is rejected.
 */
export interface AgentSessionCodec {
    encode(session: AgentSession): string
    decode(raw: string): AgentSession
}

const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['manual', 'supervised', 'autonomous']
const SESSION_STATUSES: readonly SessionStatus[] = [
    'idle',
    'running',
    'paused',
    'awaiting-help',
    'completed',
    'failed',
    'stopped',
    'budget-exhausted'
]
const REASONING_OUTCOMES: readonly ReasoningStep['outcome'][] = [
    'action',
    'completion',
    'help',
    'failure'
]
const ACTION_RESULT_STATUSES: readonly ActionResult['status'][] = [
    'success',
    'failure',
    'blocked',
    'rejected'
]
const SAFETY_EVENT_TYPES: readonly SafetyEvent['type'][] = ['emergency-stop', 'declined', 'blocked']

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isValidSummary(value: unknown): value is TrajectorySummary {
    if (!isRecord(value)) return false
    if (typeof value.goalText !== 'string') return false
    if (typeof value.inferredProgress !== 'string') return false
    if (!isStringArray(value.completedSubSteps)) return false
    const through = value.updatedThroughIndex
    if (through !== null && typeof through !== 'number') return false
    return true
}

function isValidObservation(value: unknown): value is Observation {
    if (!isRecord(value)) return false
    return (
        typeof value.id === 'string' &&
        typeof value.screenshotDataUrl === 'string' &&
        typeof value.imageWidth === 'number' &&
        typeof value.imageHeight === 'number' &&
        typeof value.displayId === 'number' &&
        typeof value.complete === 'boolean' &&
        typeof value.capturedAt === 'string'
    )
}

function isValidReasoning(value: unknown): value is ReasoningStep {
    if (!isRecord(value)) return false
    return (
        typeof value.id === 'string' &&
        REASONING_OUTCOMES.includes(value.outcome as ReasoningStep['outcome']) &&
        typeof value.rationale === 'string' &&
        (value.providerId === null || typeof value.providerId === 'string') &&
        typeof value.createdAt === 'string'
    )
}

function isValidActionResult(value: unknown): value is ActionResult {
    if (!isRecord(value)) return false
    if (!ACTION_RESULT_STATUSES.includes(value.status as ActionResult['status'])) return false
    if (typeof value.highRisk !== 'boolean') return false
    if (typeof value.executedAt !== 'string') return false
    return true
}

function isValidSafetyEvent(value: unknown): value is SafetyEvent {
    if (!isRecord(value)) return false
    return (
        SAFETY_EVENT_TYPES.includes(value.type as SafetyEvent['type']) &&
        typeof value.reason === 'string' &&
        typeof value.at === 'string'
    )
}

function isValidStep(value: unknown): value is TrajectoryStep {
    if (!isRecord(value)) return false
    if (typeof value.index !== 'number') return false
    if (!isValidObservation(value.observation)) return false
    if (!isValidReasoning(value.reasoning)) return false
    if (value.action !== undefined && !isAction(value.action as Action)) return false
    if (value.result !== undefined && !isValidActionResult(value.result)) return false
    if (value.events !== undefined) {
        if (!Array.isArray(value.events) || !value.events.every(isValidSafetyEvent)) return false
    }
    return true
}

function isValidSession(value: unknown): value is AgentSession {
    if (!isRecord(value)) return false
    if (typeof value.id !== 'string') return false
    if (!isRecord(value.goal)) return false
    if (typeof value.goal.text !== 'string' || typeof value.goal.createdAt !== 'string') {
        return false
    }
    if (!AUTONOMY_LEVELS.includes(value.autonomy as AutonomyLevel)) return false
    if (typeof value.stepBudget !== 'number') return false
    if (!Array.isArray(value.trajectory) || !value.trajectory.every(isValidStep)) return false
    if (!isValidSummary(value.summary)) return false
    if (!SESSION_STATUSES.includes(value.status as SessionStatus)) return false
    if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false
    // Trajectory must be chronological with strictly increasing indices (Req 14.2).
    const trajectory = value.trajectory as TrajectoryStep[]
    for (let i = 1; i < trajectory.length; i += 1) {
        if (trajectory[i].index <= trajectory[i - 1].index) return false
    }
    return true
}

/**
 * Default codec: pretty-printed JSON. `decode` validates the parsed object is a
 * well-formed {@link AgentSession} and throws otherwise so a corrupt/foreign file
 * is treated the same as a missing one on restore (Req 18.6).
 */
export const jsonAgentSessionCodec: AgentSessionCodec = {
    encode: (session) => JSON.stringify(session, null, 2),
    decode: (raw) => {
        const parsed: unknown = JSON.parse(raw)
        if (!isValidSession(parsed)) {
            throw new Error('Persisted session is not a valid AgentSession')
        }
        return parsed
    }
}
