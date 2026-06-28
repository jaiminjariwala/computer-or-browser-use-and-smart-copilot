/**
 * The single fail-closed gate (Task 11.1) — PURE, Electron-free.
 *
 * This is the ONE execution chokepoint of Click Operator. The Agent Loop never
 * calls the Action Executor directly; every proposed Action is submitted here
 * first. The default posture is **deny**: an Action is allowed to execute ONLY
 * when every safety precondition holds simultaneously; otherwise it is
 * `blocked(reason)` and the reason is recorded in the Trajectory (Req 14.5).
 * That makes "no action unless safe" a structural invariant rather than a
 * convention scattered across call sites.
 *
 * The eight fail-closed clauses (design "The fail-closed gate", Req 12.5, 13.5,
 * 20.7). An Action executes only if ALL hold, simultaneously:
 *   1. There is an active, user-started Agent_Session (Req 13.1, 13.2, 13.5).
 *   2. The loop is in a state where acting is legal (not idle/paused/stopped/
 *      awaiting-help/terminal) (Req 6, 13.4).
 *   3. Emergency_Stop is not active (Req 7.4).
 *   4. The Control_Indicator is displayed (Req 12.3, 12.5).
 *   5. Screen Recording AND Accessibility are both granted (Req 16.2, 17.2, 17.4).
 *   6. The Action is valid and in the Action_Space (Req 5.5, 5.6).
 *   7. The step counter is below the Step_Budget (Req 11.3).
 *   8. High-risk / manual confirmation has been satisfied (Req 8, 9): confirmation
 *      is required iff the Action is High_Risk OR autonomy is Manual, and when
 *      required an explicit affirmative Confirmation must have been obtained —
 *      never granted by timeout, default, or implied consent (Req 9.3, 10.1, 10.2).
 *
 * Being pure and deterministic (aside from the injectable `now`), the gate is
 * exhaustively property-tested (Property 1).
 *
 * _Requirements: 7.4, 8.1-8.6, 9.3-9.5, 10.1, 10.2, 11.3, 12.3-12.5, 13.1, 13.2,
 * 13.5, 17.4, 20.7 — Properties 1, 2, 4, 5._
 */

import type {
    Action,
    AutonomyLevel,
    LoopState,
    PermissionSnapshot,
    SafetyEvent
} from '@op-shared/types'
import { classifyHighRisk, type ClassificationContext } from '../classify'
import { validateAction } from '../validate'
import { confirmationSatisfied, type ConfirmationState } from './autonomy'

// ===========================================================================
// Loop-state legality (clause 2)
// ===========================================================================

/**
 * The loop states in which taking an Action is legal. Acting is permitted only
 * while the loop is actively progressing toward an Action; it is illegal while
 * idle, paused, stopped, awaiting-help, or in any terminal state.
 *
 * This is an explicit allowlist (fail-closed): any state not listed — including
 * `idle`, `paused`, `awaiting-help`, `stopped`, `completed`, `failed`, and
 * `budget-exhausted` — blocks execution. It is stricter than, and consistent
 * with, the design's "not stopped/paused/awaiting-help" (Property 1), so an
 * unknown or terminal state can never permit an Action.
 */
export const ACTING_LEGAL_STATES: readonly LoopState[] = [
    'perceiving',
    'reasoning',
    'awaiting-confirmation',
    'acting'
] as const

/** True iff acting is legal in the given loop state (clause 2). */
export function isActingLegalState(state: LoopState): boolean {
    return ACTING_LEGAL_STATES.includes(state)
}

// ===========================================================================
// The pure gate decision
// ===========================================================================

/**
 * The classified reason an Action was blocked. Each maps to exactly one failed
 * fail-closed clause, so the block is fully explainable in the Trajectory.
 */
export type BlockReason =
    | 'no-active-session' // clause 1 (Req 13.1, 13.2, 13.5)
    | 'illegal-loop-state' // clause 2
    | 'emergency-stop-active' // clause 3 (Req 7.4)
    | 'indicator-not-displayed' // clause 4 (Req 12.3, 12.5)
    | 'screen-recording-not-granted' // clause 5 (Req 16.2)
    | 'accessibility-not-granted' // clause 5 (Req 17.2, 17.4)
    | 'invalid-action' // clause 6 (Req 5.5, 5.6)
    | 'budget-exhausted' // clause 7 (Req 11.3)
    | 'confirmation-required' // clause 8, still pending (Req 10.1, 10.2)
    | 'confirmation-declined' // clause 8, user declined (Req 9.4, 10.5)

/** The plain precondition struct the pure {@link gate} decides over. */
export interface GateContext {
    /** Clause 1: an active, user-started Agent_Session exists (Req 13). */
    sessionActive: boolean
    /** Clause 2: the current loop state (acting must be legal). */
    loopState: LoopState
    /** Clause 3: whether Emergency_Stop is currently active (Req 7.4). */
    emergencyStopActive: boolean
    /** Clause 4: whether the Control_Indicator is displayed (Req 12.3, 12.5). */
    indicatorDisplayed: boolean
    /** Clause 5: both macOS permissions (Req 16.2, 17.2, 17.4). */
    permissions: PermissionSnapshot
    /** Clause 7: Reasoning_Steps taken so far in this session (Req 11.2). */
    stepCount: number
    /** Clause 7: the configured Step_Budget (Req 11.3). */
    stepBudget: number
    /** Clause 8: the Autonomy_Level in effect (Req 8). */
    autonomy: AutonomyLevel
    /** Clause 8: the explicit confirmation state the loop set (Req 9, 10). */
    confirmation: ConfirmationState
    /** Optional model risk hint + target context for classification (Req 9). */
    classification?: ClassificationContext
    /** Injectable clock for the recorded SafetyEvent timestamp (test seam). */
    now?: () => string
}

/** The gate allowed the Action: it may be handed to the Executor. */
export interface GateAllow {
    allow: true
    /** The validated Action (narrowed to the Action_Space). */
    action: Action
    /** Its High_Risk classification (Req 9.1), recorded with the result. */
    highRisk: boolean
}

/** The gate blocked the Action: it must NOT execute, and this is recorded. */
export interface GateBlocked {
    allow: false
    /** The single failed clause. */
    reason: BlockReason
    /** Human-readable detail for the Trajectory / activity log. */
    detail: string
    /** The High_Risk classification when determinable (fail-closed true otherwise). */
    highRisk: boolean
    /**
     * The safety event to append to the Trajectory (Req 14.5). A user decline is
     * recorded as `declined` (Req 9.4, 10.5); every other block as `blocked`.
     */
    event: SafetyEvent
}

/** The gate decision: allow (execute) or blocked (record + do not execute). */
export type GateDecision = GateAllow | GateBlocked

function isGranted(status: PermissionSnapshot['screenRecording']): boolean {
    return status === 'granted'
}

/**
 * The single fail-closed gate (Task 11.1). Returns `allow` **iff all eight
 * clauses hold**; otherwise `blocked(reason)`.
 *
 * Clauses are checked in a fail-closed priority order so the reported reason is
 * the most fundamental missing precondition; because `allow` is only returned
 * after every check passes, `allow ⇔ (clause1 ∧ … ∧ clause8)` holds exactly.
 *
 * @param action the candidate Action (validated here against the Action_Space)
 * @param ctx    the precondition struct
 */
export function gate(action: unknown, ctx: GateContext): GateDecision {
    const at = (ctx.now ?? (() => new Date().toISOString()))()

    // Clause 6 inputs: validate the Action against the fixed Action_Space, and
    // classify its risk. A malformed/out-of-space Action cannot be classified
    // meaningfully, so risk fails closed to High_Risk.
    const validation = validateAction(action)
    const validAction: Action | null = validation.ok ? validation.action : null
    const highRisk = validAction ? classifyHighRisk(validAction, ctx.classification) : true

    const blocked = (reason: BlockReason, detail: string): GateBlocked => {
        const type: SafetyEvent['type'] = reason === 'confirmation-declined' ? 'declined' : 'blocked'
        return {
            allow: false,
            reason,
            detail,
            highRisk,
            event: { type, reason: detail, at }
        }
    }

    // Clause 1 — active, user-started session (Req 13.1, 13.2, 13.5).
    if (!ctx.sessionActive) {
        return blocked('no-active-session', 'No active, user-started Agent_Session')
    }

    // Clause 2 — legal loop state (Req 6, 13.4).
    if (!isActingLegalState(ctx.loopState)) {
        return blocked('illegal-loop-state', `Acting is not legal in loop state "${ctx.loopState}"`)
    }

    // Clause 3 — Emergency_Stop not active (Req 7.4).
    if (ctx.emergencyStopActive) {
        return blocked('emergency-stop-active', 'Emergency_Stop is active')
    }

    // Clause 4 — Control_Indicator displayed (Req 12.3, 12.5).
    if (!ctx.indicatorDisplayed) {
        return blocked('indicator-not-displayed', 'Control_Indicator is not displayed')
    }

    // Clause 5 — both permissions granted (Req 16.2, 17.2, 17.4).
    if (!isGranted(ctx.permissions.screenRecording)) {
        return blocked('screen-recording-not-granted', 'Screen Recording permission is not granted')
    }
    if (!isGranted(ctx.permissions.accessibility)) {
        return blocked('accessibility-not-granted', 'Accessibility permission is not granted')
    }

    // Clause 6 — valid, in-Action_Space Action (Req 5.5, 5.6).
    if (!validAction) {
        const detail = validation.ok ? 'Invalid Action' : validation.detail
        return blocked('invalid-action', detail)
    }

    // Clause 7 — within the Step_Budget (Req 11.3).
    if (ctx.stepCount >= ctx.stepBudget) {
        return blocked(
            'budget-exhausted',
            `Step_Budget of ${ctx.stepBudget} reached (${ctx.stepCount} steps taken)`
        )
    }

    // Clause 8 — high-risk / manual confirmation satisfied (Req 8, 9, 10).
    if (!confirmationSatisfied(ctx.autonomy, highRisk, ctx.confirmation)) {
        if (ctx.confirmation === 'declined') {
            return blocked('confirmation-declined', 'User declined Confirmation for this Action')
        }
        const why = highRisk
            ? 'High_Risk_Action requires explicit Confirmation'
            : 'Manual autonomy requires explicit Confirmation for every Action'
        return blocked('confirmation-required', why)
    }

    // Every clause satisfied → allow.
    return { allow: true, action: validAction, highRisk }
}

/**
 * Convenience: turn a blocked gate decision into an {@link import('@op-shared/types').ActionResult }
 * shape for the Trajectory. A user decline or a plain block records status
 * `blocked`; a malformed/out-of-space Action records status `rejected` (Req 5.5).
 */
export function blockedActionResult(
    decision: GateBlocked,
    now: () => string = () => new Date().toISOString()
): {
    status: 'blocked' | 'rejected'
    reason: string
    highRisk: boolean
    confirmed: boolean
    executedAt: string
} {
    return {
        status: decision.reason === 'invalid-action' ? 'rejected' : 'blocked',
        reason: decision.detail,
        highRisk: decision.highRisk,
        confirmed: false,
        executedAt: now()
    }
}
