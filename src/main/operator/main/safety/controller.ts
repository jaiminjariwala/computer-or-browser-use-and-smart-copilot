/**
 * The stateful Safety / Kill-Switch Controller (Tasks 11.3, 11.4).
 *
 * The pure {@link gate} in `gate.ts` decides safety over a plain precondition
 * struct. This class owns the parts that are inherently *stateful* and feeds
 * them into that gate:
 *
 *  - the **Emergency_Stop** flag + kill-switch behaviour (Req 7),
 *  - the **Control_Indicator** "in control / indicator available" state (Req 12),
 *  - the global Emergency_Stop **hotkey** registration result (Req 7.7, 7.8).
 *
 * It merges its owned state with the external per-request inputs the loop
 * supplies, so the loop and windows consume a single object and reach the
 * Executor ONLY through {@link SafetyController.evaluate}. That is why the gate
 * is the sole path to execution: there is no other method that says "yes".
 */

import type {
    AutonomyLevel,
    LoopState,
    OperatorError,
    PermissionSnapshot,
    SafetyEvent
} from '@op-shared/types'
import type { ClassificationContext } from '../classify'
import {
    applyRegistrationResult,
    blocksSessionStart,
    type EmergencyStopHandler,
    type HotkeyRegistrationResult
} from '../hotkey'
import { gate, type GateDecision } from './gate'
import type { ConfirmationState } from './autonomy'

/**
 * The external, per-request inputs the {@link SafetyController} does NOT itself
 * own. The loop supplies these each time it asks the controller to evaluate a
 * proposed Action; the controller merges in the Emergency_Stop and
 * Control_Indicator state it does own.
 */
export interface ExternalGateInputs {
    sessionActive: boolean
    loopState: LoopState
    permissions: PermissionSnapshot
    stepCount: number
    stepBudget: number
    autonomy: AutonomyLevel
    confirmation: ConfirmationState
    classification?: ClassificationContext
}

/**
 * Side effects the controller performs, injected so the controller is fully
 * unit-testable without a live loop, renderer, or Electron runtime.
 */
export interface SafetyControllerDeps {
    /** Injectable clock for recorded event timestamps. */
    now?: () => string
    /** Surface a typed error to the Console (maps to the `error:show` channel). */
    emitError?: (error: OperatorError) => void
    /** Cancel any in-flight Action (Req 7.3) — e.g. abort the executor. */
    cancelInFlightAction?: () => void
    /**
     * Halt the loop (Req 7.3, 12.4). `cause` distinguishes an Emergency_Stop
     * from a Control_Indicator that cannot be displayed.
     */
    haltLoop?: (cause: 'emergency-stop' | 'indicator-unavailable') => void
    /** Record a safety event in the Trajectory (Req 7.6, 14.5). */
    recordSafetyEvent?: (event: SafetyEvent) => void
    /** Ensure the always-visible on-screen Emergency_Stop control exists (Req 7.8). */
    showOnScreenFallback?: () => void
}

/**
 * The Safety / Kill-Switch Controller. Owns the Emergency_Stop flag and the
 * Control_Indicator visibility state, wires the global Emergency_Stop hotkey,
 * and exposes the single {@link SafetyController.evaluate | evaluate} gate the
 * loop routes every proposed Action through.
 *
 * It implements {@link EmergencyStopHandler}, so it can be handed directly to
 * {@link import('../hotkey').createEmergencyStopManager } — a hotkey fire calls
 * {@link SafetyController.onEmergencyStop}.
 */
export class SafetyController implements EmergencyStopHandler {
    private stopped = false
    private inControl = false
    private indicatorAvailable = true
    private hotkeyResult: HotkeyRegistrationResult | null = null
    private readonly deps: SafetyControllerDeps
    private readonly now: () => string

    constructor(deps: SafetyControllerDeps = {}) {
        this.deps = deps
        this.now = deps.now ?? (() => new Date().toISOString())
    }

    // ---- Emergency_Stop (Task 11.3, Req 7) --------------------------------

    /**
     * The Emergency_Stop handler invoked by the global hotkey (Req 7.1, 7.5) or
     * the on-screen control (Req 7.2, 7.8). Delegates to
     * {@link activateEmergencyStop}.
     */
    onEmergencyStop(): void {
        this.activateEmergencyStop()
    }

    /**
     * Activate the Emergency_Stop (Req 7.3, 7.4, 7.6): set the stop flag, cancel
     * any in-flight Action, halt the loop, drop out of control, and record the
     * stop event in the Trajectory. Idempotent — activating again while already
     * stopped keeps the system stopped and records no duplicate event, but still
     * guarantees no Action can execute.
     *
     * @returns the recorded stop {@link SafetyEvent} on the transition into the
     * stopped state, or `null` if it was already stopped.
     */
    activateEmergencyStop(): SafetyEvent | null {
        if (this.stopped) {
            // Already stopped: remain fail-closed; nothing new to record.
            return null
        }
        this.stopped = true
        this.inControl = false
        // Cancel any in-flight Action and halt the loop immediately (Req 7.3).
        this.deps.cancelInFlightAction?.()
        this.deps.haltLoop?.('emergency-stop')
        // Record the stop event in the Trajectory (Req 7.6).
        const event: SafetyEvent = {
            type: 'emergency-stop',
            reason: 'Emergency_Stop activated',
            at: this.now()
        }
        this.deps.recordSafetyEvent?.(event)
        return event
    }

    /** Whether Emergency_Stop is currently active (Req 7.4). */
    isStopped(): boolean {
        return this.stopped
    }

    /**
     * Explicit restart after an Emergency_Stop (Req 7.4). Clears the stop flag so
     * the loop may start acting again ONLY on a subsequent explicit user start —
     * this method itself starts nothing. The agent remains out of control until
     * the loop sets it back in control with the indicator displayed.
     */
    restart(): void {
        this.stopped = false
    }

    /** Alias for {@link restart} (design refers to both "reset" and "restart"). */
    reset(): void {
        this.restart()
    }

    // ---- Emergency_Stop hotkey registration (Req 7.7, 7.8) ----------------

    /**
     * Register the global Emergency_Stop hotkey and remember the result. On
     * failure the typed error is surfaced and the on-screen fallback is ensured
     * (Req 7.8); the stored result makes {@link hotkeyBlocksSessionStart} return
     * true so session start is blocked (Req 7.7).
     *
     * @param manager an object exposing `register()` — typically a
     * {@link import('../hotkey').HotkeyManager } bound to this controller.
     */
    registerHotkey(manager: { register(): HotkeyRegistrationResult }): HotkeyRegistrationResult {
        const result = manager.register()
        this.hotkeyResult = result
        applyRegistrationResult(result, {
            emitError: (error) => this.deps.emitError?.(error),
            showOnScreenFallback: () => this.deps.showOnScreenFallback?.()
        })
        return result
    }

    /**
     * Whether the Emergency_Stop hotkey state blocks starting a session (Req 7.7).
     * Fail-closed: if no registration has been attempted yet, or the attempt
     * failed, session start is blocked. (The on-screen control still exists as a
     * fallback per Req 7.8 — that does not unblock the hotkey requirement.)
     */
    hotkeyBlocksSessionStart(): boolean {
        if (!this.hotkeyResult) return true
        return blocksSessionStart(this.hotkeyResult)
    }

    /** The last hotkey registration result, if any. */
    getHotkeyResult(): HotkeyRegistrationResult | null {
        return this.hotkeyResult
    }

    // ---- Control_Indicator visibility (Task 11.4, Req 12) -----------------

    /**
     * Set whether the agent is in control. The Window Manager shows/hides the
     * Control_Indicator in lockstep with this flag (Req 12.1, 12.2). If control
     * is requested while the indicator cannot be displayed, the loop is halted
     * and `indicator-unavailable` is surfaced (Req 12.4).
     */
    setInControl(value: boolean): void {
        this.inControl = value
        if (value && !this.indicatorAvailable) {
            this.handleIndicatorUnavailable()
        }
    }

    /**
     * Report whether the Control_Indicator can currently be displayed (e.g. the
     * overlay window was created and shown). If it becomes unavailable while the
     * agent is in control, the loop halts and `indicator-unavailable` is
     * surfaced, and the agent drops out of control (Req 12.4).
     */
    setIndicatorAvailable(value: boolean): void {
        this.indicatorAvailable = value
        if (!value && this.inControl) {
            this.handleIndicatorUnavailable()
        }
    }

    /**
     * Whether the Control_Indicator is displayed right now — the gate clause 4
     * value (Req 12.3, 12.5). True only when the agent is in control AND the
     * indicator can actually be displayed, so "invisible agent action" is
     * structurally impossible.
     */
    isIndicatorDisplayed(): boolean {
        return this.inControl && this.indicatorAvailable
    }

    /** Whether the agent is currently marked in control. */
    isInControl(): boolean {
        return this.inControl
    }

    private handleIndicatorUnavailable(): void {
        const error: OperatorError = {
            kind: 'indicator-unavailable',
            message:
                'The "agent in control" indicator could not be displayed, so Computer or Browser Use halted and will execute no Action.',
            recoverable: true,
            action: 'retry'
        }
        this.deps.emitError?.(error)
        this.deps.haltLoop?.('indicator-unavailable')
        // Drop out of control so the gate (clause 4) blocks every Action.
        this.inControl = false
    }

    // ---- The gate the loop consumes ---------------------------------------

    /**
     * Evaluate a proposed Action through the fail-closed {@link gate}, merging
     * this controller's owned state (Emergency_Stop flag + Control_Indicator
     * visibility) with the external per-request inputs the loop supplies. This
     * is the single method the Agent Loop calls before ever touching the
     * Executor.
     */
    evaluate(action: unknown, external: ExternalGateInputs): GateDecision {
        return gate(action, {
            sessionActive: external.sessionActive,
            loopState: external.loopState,
            emergencyStopActive: this.stopped,
            indicatorDisplayed: this.isIndicatorDisplayed(),
            permissions: external.permissions,
            stepCount: external.stepCount,
            stepBudget: external.stepBudget,
            autonomy: external.autonomy,
            confirmation: external.confirmation,
            classification: external.classification,
            now: this.now
        })
    }
}

/** Construct a {@link SafetyController} with the given side-effect deps. */
export function createSafetyController(deps: SafetyControllerDeps = {}): SafetyController {
    return new SafetyController(deps)
}
