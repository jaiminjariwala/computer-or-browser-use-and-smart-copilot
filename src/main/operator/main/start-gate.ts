import type { OperatorError, PermissionSnapshot } from '@op-shared/types'
import { evaluateStartGate as evaluatePermissionStartGate } from './permissions'
import { DEFAULT_EMERGENCY_STOP_HOTKEY, buildHotkeyError } from './hotkey'

/**
 * Operator start-gate precondition assembly (Task 16.1 — final integration).
 *
 * The design's **start gate** (design "Agent Loop State Machine", `idle →
 * perceiving`) says the run begins ONLY on an explicit user start AND when the
 * *full precondition set* holds simultaneously — otherwise the loop does NOT
 * start and the failure is surfaced (fail-closed). This module is the single,
 * PURE, Electron-free place that assembles that decision from the plain signals
 * the main process gathers, so the "no start unless every precondition holds"
 * rule is unit-testable headlessly rather than tangled into `index.ts`.
 *
 * The environmental preconditions checked here (in fail-closed priority order):
 *
 *  1. **Emergency_Stop hotkey registered** (Req 7.7). If the global kill-switch
 *     could not be registered, starting is blocked — the user must retain a
 *     working kill-switch (the on-screen fallback stays available per Req 7.8,
 *     but that does not unblock the hotkey requirement).
 *  2. **Screen Recording AND Accessibility granted** (Req 16.1, 17.1). Perception
 *     needs Screen Recording; input synthesis needs Accessibility. Both must be
 *     granted or the session cannot start.
 *  3. **A Model_Provider / credentials present** (Req 15.7, 21.10). At least one
 *     provider must be configured (and, when required, have its key) — the
 *     Config store computes this and hands us a typed error to surface.
 *  4. **The Control_Indicator can be displayed** (Req 12.4). The "agent in
 *     control" overlay is a hard precondition for any Action; if it cannot be
 *     shown, the loop must not start.
 *
 * Two preconditions from the design's list are enforced *outside* this pure gate
 * because they are owned by the Session Manager's `createSession`:
 *  - the explicit user start, and
 *  - the Autonomy_Level + Step_Budget association (Req 1.3, 1.5) plus a non-empty
 *    Goal (Req 1.2).
 * `index.ts` runs this environmental gate and `createSession` together so the
 * full precondition set is satisfied before `loop.start()` is ever called.
 */

/** The credential/provider start-gate outcome computed by the Config store. */
export type CredentialGateResult = { ok: true } | { ok: false; error: OperatorError }

/** The plain signals the environmental start gate decides over. */
export interface StartPreconditions {
    /**
     * Whether the Emergency_Stop hotkey state blocks starting (Req 7.7). This is
     * the Safety Controller's `hotkeyBlocksSessionStart()`: `true` means the
     * hotkey is NOT registered and the session must not start.
     */
    hotkeyBlocksStart: boolean
    /**
     * The typed error to surface when the hotkey blocks start. Supplied from the
     * stored {@link import('./hotkey').HotkeyRegistrationResult}'s `error`; a
     * default is synthesized when absent so the gate always has something to
     * surface.
     */
    hotkeyError?: OperatorError
    /** The accelerator used, for the default hotkey error message. */
    hotkeyAccelerator?: string
    /** Current macOS permission snapshot (Req 16.1, 17.1). */
    permissions: PermissionSnapshot
    /** Whether Screen Recording was previously granted (revoked vs missing wording). */
    screenPreviouslyGranted?: boolean
    /** Whether Accessibility was previously granted (revoked vs missing wording). */
    accessibilityPreviouslyGranted?: boolean
    /** The credential/provider gate result from the Config store (Req 15.7, 21.10). */
    credentialGate: CredentialGateResult
    /** Whether the Control_Indicator can currently be displayed (Req 12.4). */
    indicatorAvailable: boolean
}

/** The environmental start-gate decision: start, or a typed failure to surface. */
export type StartGateDecision = { ok: true } | { ok: false; error: OperatorError }

/** The typed error surfaced when the Control_Indicator cannot be displayed (Req 12.4). */
export function indicatorUnavailableError(): OperatorError {
    return {
        kind: 'indicator-unavailable',
        message:
            'The "agent in control" indicator could not be displayed, so Click Operator will not start. It is a required safety indicator.',
        recoverable: true,
        action: 'retry'
    }
}

/**
 * Evaluate the environmental start gate (Task 16.1). Returns `{ ok: true }` only
 * when EVERY environmental precondition holds; otherwise `{ ok: false, error }`
 * carrying the most fundamental missing precondition's typed error, so the run
 * never starts on a partially-satisfied precondition set (fail-closed).
 */
export function evaluateOperatorStartGate(pre: StartPreconditions): StartGateDecision {
    // 1. Emergency_Stop hotkey must be registered (Req 7.7).
    if (pre.hotkeyBlocksStart) {
        const error =
            pre.hotkeyError ??
            buildHotkeyError('failed', pre.hotkeyAccelerator ?? DEFAULT_EMERGENCY_STOP_HOTKEY)
        return { ok: false, error }
    }

    // 2. Screen Recording AND Accessibility must both be granted (Req 16.1, 17.1).
    const permissionGate = evaluatePermissionStartGate(pre.permissions, {
        screenPreviouslyGranted: pre.screenPreviouslyGranted,
        accessibilityPreviouslyGranted: pre.accessibilityPreviouslyGranted
    })
    if (!permissionGate.canStartSession) {
        const blocker = permissionGate.blockers.find((b) => b.error) ?? permissionGate.blockers[0]
        const error =
            blocker?.error ??
            ({
                kind: 'permission-missing',
                message: 'A required macOS permission is not granted.',
                recoverable: true,
                action: 'open-screen-settings'
            } satisfies OperatorError)
        return { ok: false, error }
    }

    // 3. A Model_Provider / credentials must be present (Req 15.7, 21.10).
    if (!pre.credentialGate.ok) {
        return { ok: false, error: pre.credentialGate.error }
    }

    // 4. The Control_Indicator must be displayable (Req 12.4).
    if (!pre.indicatorAvailable) {
        return { ok: false, error: indicatorUnavailableError() }
    }

    // Every environmental precondition holds → the run may start.
    return { ok: true }
}

/**
 * The typed failure surfaced when a start is refused because the Goal is empty
 * (Req 1.2). Empty Goal is a *prompt* rather than a hard error in the design,
 * but `goal:start` must return a typed {@link StartResult} failure at the main
 * boundary, so it is bridged onto the "session could not be set up" bucket with
 * a Goal-focused message and a restart action.
 */
export function emptyGoalError(): OperatorError {
    return {
        kind: 'association-failed',
        message: 'Enter a Goal before starting a session.',
        recoverable: true,
        action: 'restart-session'
    }
}
