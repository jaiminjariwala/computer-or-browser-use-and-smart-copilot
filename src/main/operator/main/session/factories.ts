import type {
    AgentSession,
    AutonomyLevel,
    EnvironmentId,
    Goal,
    OperatorError,
    ReasoningStep,
    Observation,
    Action,
    ActionResult,
    SafetyEvent,
    TrajectoryStep,
    TrajectorySummary
} from '@op-shared/types'

/**
 * Session inputs, validators, and value factories (Task 12.1).
 *
 * The Electron-free, class-free half of the Session Manager: the shapes a caller
 * supplies to create a session or append a step, the association validator that
 * gates creation, and the small factories the manager leans on. Kept apart from
 * the class so the pure validation/creation rules read on their own and can be
 * unit-tested directly (Req 1.1-1.5).
 */

/**
 * Most-recent Trajectory steps carried verbatim in a bounded reasoning context.
 * Older steps are represented by the running {@link TrajectorySummary} instead of
 * replayed step-by-step (Req 3.5, 4.3).
 */
export const KEEP_RECENT = 4

/** Produces a unique id for a session or a reasoning step. Injectable for tests. */
export type IdGenerator = () => string

/** Produces the current time as an ISO-8601 timestamp. Injectable for tests. */
export type Clock = () => string

/** The valid Autonomy_Level values (Req 8.1). */
const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['manual', 'supervised', 'autonomous']

/** Fields a caller supplies to create a session (Req 1.1). */
export interface CreateSessionInput {
    /** Raw goal text; empty/whitespace is rejected (Req 1.2). */
    goal: string
    /** Associated before any Action (Req 1.3). */
    autonomy: AutonomyLevel
    /** Associated before any Action (Req 1.3, 11.1). */
    stepBudget: number
    /** The Execution_Environment to run against (Req 22.2, 22.3). Defaults to local. */
    environment?: EnvironmentId
}

/** Outcome of `SessionManager.createSession`. */
export type CreateSessionResult =
    | { ok: true; session: AgentSession }
    /** Empty/whitespace Goal — no session created; prompt the user (Req 1.2, Property 25). */
    | { ok: false; reason: 'empty-goal' }
    /** Autonomy_Level/Step_Budget could not be associated (Req 1.5). */
    | { ok: false; reason: 'association-failed'; error: OperatorError }

/**
 * Validates + normalizes the Autonomy_Level and Step_Budget association. Returns
 * the associated values, or `null` when they cannot be associated (invalid
 * autonomy, or a non-finite/non-positive/non-integer budget) so the caller can
 * surface `association-failed` (Req 1.5). Injectable so tests can force the
 * failure path deterministically.
 */
export type AssociationValidator = (
    autonomy: AutonomyLevel,
    stepBudget: number
) => { autonomy: AutonomyLevel; stepBudget: number } | null

/** Default association validator (Req 1.3, 1.5). */
export function defaultValidateAssociation(
    autonomy: AutonomyLevel,
    stepBudget: number
): { autonomy: AutonomyLevel; stepBudget: number } | null {
    if (!AUTONOMY_LEVELS.includes(autonomy)) return null
    if (!Number.isFinite(stepBudget) || !Number.isInteger(stepBudget) || stepBudget <= 0) {
        return null
    }
    return { autonomy, stepBudget }
}

/** True iff `text` is empty or composed entirely of whitespace (Req 1.2, Property 25). */
export function isBlankGoal(text: string): boolean {
    return typeof text !== 'string' || text.trim().length === 0
}

/** The reasoning fields a caller supplies for a Trajectory step (ids/timestamps minted). */
export interface AppendStepReasoning {
    outcome: ReasoningStep['outcome']
    /** Human-readable rationale (Req 3.3, 14.2). */
    rationale: string
    /** Serving Model_Provider id; null when all providers failed (Req 21.9). */
    providerId?: string | null
    /** Optional explicit id/timestamp (otherwise minted). */
    id?: string
    createdAt?: string
}

/** Fields a caller supplies to append a Trajectory step (Req 14.2, 14.3, 14.5). */
export interface AppendStepInput {
    observation: Observation
    reasoning: AppendStepReasoning
    /** Chosen Action + parameters; absent for completion/help/failure (Req 3.6). */
    action?: Action
    /** Recorded outcome of the attempt (Req 5.7). */
    result?: ActionResult
    /** Blocked/declined/emergency-stop records with reasons (Req 7.6, 14.5). */
    events?: SafetyEvent[]
}

/**
 * Optional lifecycle hooks — the seams for persistence (Task 12.3) and
 * summarization (Task 12.4). They fire synchronously after a mutation is applied
 * to the in-memory session; any returned promise is intentionally not awaited so
 * the manager stays a simple synchronous state holder. The owning wiring is
 * responsible for awaiting/handling async work such as disk writes.
 */
export interface SessionManagerHooks {
    /** Fires after any mutation to the active session (create/start/append/summary/end/restore). */
    onSessionChanged?: (session: AgentSession) => void | Promise<void>
    /** Fires after a Trajectory step is appended. Summarization-trigger seam. */
    onStepAppended?: (step: TrajectoryStep, session: AgentSession) => void | Promise<void>
    /** Fires with the prior session when a new session replaces it. Archive seam (Req 18.4). */
    onArchive?: (session: AgentSession) => void | Promise<void>
}

export interface SessionManagerOptions {
    /** Id factory for sessions and reasoning steps. Defaults to a unique generator. */
    generateId?: IdGenerator
    /** Clock for timestamps. Defaults to `Date.now()` as ISO. */
    now?: Clock
    /** Association validator. Defaults to {@link defaultValidateAssociation}. */
    validateAssociation?: AssociationValidator
    /** Lifecycle hooks for persistence/summarization/archive seams. */
    hooks?: SessionManagerHooks
}

/** Build a fresh, empty running summary that preserves the Goal (Req 4.4). */
export function createEmptySummary(goalText: string): TrajectorySummary {
    return {
        goalText,
        inferredProgress: '',
        completedSubSteps: [],
        updatedThroughIndex: null
    }
}

/** Build a brand-new session for `goalText` at `timestamp`, with an empty Trajectory. */
export function createSession(
    id: string,
    goalText: string,
    autonomy: AutonomyLevel,
    stepBudget: number,
    timestamp: string
): AgentSession {
    const goal: Goal = { text: goalText, createdAt: timestamp }
    return {
        id,
        goal,
        autonomy,
        stepBudget,
        trajectory: [],
        summary: createEmptySummary(goal.text),
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp
    }
}

/**
 * Default id generator. Combines a monotonic counter with a time component and a
 * random suffix so ids stay unique even when minted within the same millisecond.
 */
export function createDefaultIdGenerator(): IdGenerator {
    let counter = 0
    return () => {
        counter += 1
        const time = Date.now().toString(36)
        const seq = counter.toString(36)
        const rand = Math.random().toString(36).slice(2, 8)
        return `${time}-${seq}-${rand}`
    }
}

/** Default clock: current time as an ISO-8601 string. */
export function defaultClock(): string {
    return new Date().toISOString()
}

/** Deep clone so callers can never mutate the manager's internal state. */
export function clone<T>(value: T): T {
    return structuredClone(value)
}
