/**
 * Emergency_Stop Hotkey Manager (Task 9.1).
 *
 * Repurposed from the Click Copilot `hotkey.ts` primitive vendored in Task 2
 * (Req 19: a one-time COPY — this module does not import from or modify the
 * `click-copilot` project). Click Operator now owns and evolves this copy as the
 * global **Emergency_Stop** kill-switch.
 *
 * Responsibilities (Req 7):
 * - Register the global Emergency_Stop accelerator with the OS via
 *   `globalShortcut` (intended to run on `app.whenReady`). Because the OS owns
 *   the binding, the hotkey fires even when another app has focus — the app need
 *   not be foreground to respond (Req 7.1, 7.5).
 * - On registration FAILURE, produce a typed {@link HotkeyRegistrationResult}
 *   (classified `conflict` vs `failed`). The Safety Controller consumes this to
 *   BLOCK session start (Req 7.7); the gate itself lives there.
 * - Keep the always-visible on-screen Emergency_Stop control available as a
 *   fallback even when the hotkey cannot be registered (Req 7.8).
 *
 * Testability: the Electron `globalShortcut` dependency is INJECTED (see
 * {@link GlobalShortcutLike}) so the manager can be unit-tested without a live
 * Electron runtime. In production, call {@link createEmergencyStopManager}.
 */

import { globalShortcut as electronGlobalShortcut } from 'electron'
import type { OperatorError } from '@op-shared/types'
import { buildHotkeyError, type HotkeyFailureReason, type HotkeyRegistrationResult } from './errors'

/**
 * The default global Emergency_Stop accelerator. `CommandOrControl+Shift+Escape`
 * maps to ⌘⇧Esc on macOS — a deliberate, hard-to-hit-by-accident combination
 * appropriate for a kill-switch, and unlikely to collide with ordinary app
 * shortcuts.
 */
export const DEFAULT_EMERGENCY_STOP_HOTKEY = 'CommandOrControl+Shift+Escape'

/**
 * The minimal slice of Electron's `globalShortcut` the manager needs. Injecting
 * this interface (rather than importing the module directly) keeps the manager
 * unit-testable with a fake. Electron's `globalShortcut` satisfies it.
 */
export interface GlobalShortcutLike {
    /** Returns false when the OS rejects the accelerator (e.g. already held). */
    register(accelerator: string, callback: () => void): boolean
    /** Whether the accelerator is currently registered (by any app). */
    isRegistered(accelerator: string): boolean
    /** Release a single accelerator binding. */
    unregister(accelerator: string): void
    /** Release all accelerators owned by this app (recommended on quit). */
    unregisterAll(): void
}

/**
 * The callback surface invoked when the Emergency_Stop hotkey fires. Kept as a
 * tiny interface so the manager can be driven in tests without the real Safety
 * Controller. In production the Safety Controller supplies `onEmergencyStop`.
 */
export interface EmergencyStopHandler {
    /** Invoked when the global Emergency_Stop hotkey fires (Req 7.3). */
    onEmergencyStop(): void
}

/**
 * Owns the lifecycle of the global Emergency_Stop hotkey: registration, the fire
 * callback, and cleanup. A single instance manages one accelerator at a time.
 */
export class HotkeyManager {
    private readonly shortcut: GlobalShortcutLike
    private readonly handler: EmergencyStopHandler
    private accelerator: string
    private registered = false

    /**
     * @param shortcut   Injected `globalShortcut` (real or fake) — enables
     *                   unit testing without Electron.
     * @param handler    Invoked when the hotkey fires (Req 7.3).
     * @param accelerator The accelerator to register (defaults to the
     *                   Emergency_Stop accelerator).
     */
    constructor(
        shortcut: GlobalShortcutLike,
        handler: EmergencyStopHandler,
        accelerator: string = DEFAULT_EMERGENCY_STOP_HOTKEY
    ) {
        this.shortcut = shortcut
        this.handler = handler
        this.accelerator = accelerator
    }

    /** The accelerator this manager currently targets. */
    getAccelerator(): string {
        return this.accelerator
    }

    /** Whether this manager currently holds a registered hotkey. */
    isRegistered(): boolean {
        return this.registered
    }

    /**
     * Register the global Emergency_Stop hotkey with the OS. The registered
     * callback invokes the handler and fires even when another application has
     * OS focus (Req 7.1, 7.5). Intended to be invoked on `app.whenReady`.
     *
     * Returns a {@link HotkeyRegistrationResult}: on success `{ success: true }`;
     * on failure a classified result carrying the typed error so the Safety
     * Controller can block session start (Req 7.7).
     */
    register(): HotkeyRegistrationResult {
        // `register` returns false when the OS rejects the accelerator (most
        // commonly because another app already holds it).
        const ok = this.shortcut.register(this.accelerator, () => {
            this.handler.onEmergencyStop()
        })

        if (ok) {
            this.registered = true
            return { success: true, accelerator: this.accelerator }
        }

        this.registered = false
        // Classify the failure: a `conflict` means the accelerator is already
        // registered (by another app); anything else is a generic `failed`.
        const reason: HotkeyFailureReason = this.shortcut.isRegistered(this.accelerator)
            ? 'conflict'
            : 'failed'
        return {
            success: false,
            accelerator: this.accelerator,
            reason,
            error: buildHotkeyError(reason, this.accelerator)
        }
    }

    /**
     * Re-register against a different accelerator after a conflict. Releases any
     * currently-held binding, switches to the new accelerator, and retries.
     */
    reRegister(accelerator: string): HotkeyRegistrationResult {
        if (this.registered) {
            this.shortcut.unregister(this.accelerator)
            this.registered = false
        }
        this.accelerator = accelerator
        return this.register()
    }

    /**
     * Release the hotkey. Uses `unregisterAll` so the OS-level binding is fully
     * cleared on app quit, matching Electron's recommended cleanup.
     */
    unregister(): void {
        this.shortcut.unregisterAll()
        this.registered = false
    }
}

/**
 * Construct a {@link HotkeyManager} bound to Electron's real `globalShortcut`.
 * Use this in the main process (wired on `app.whenReady` in the final
 * integration task); use the `HotkeyManager` constructor with a fake in tests.
 */
export function createEmergencyStopManager(
    handler: EmergencyStopHandler,
    accelerator: string = DEFAULT_EMERGENCY_STOP_HOTKEY
): HotkeyManager {
    return new HotkeyManager(
        electronGlobalShortcut as unknown as GlobalShortcutLike,
        handler,
        accelerator
    )
}

/**
 * Session-start gate input consumed by the Safety Controller (Task 11.3).
 *
 * Req 7.7: if the global Emergency_Stop hotkey cannot be registered, the app
 * SHALL NOT allow starting an Agent_Session. This pure predicate lets the gate
 * decide from the registration result without reaching into Electron.
 *
 * @returns true when the failed registration must block session start.
 */
export function blocksSessionStart(result: HotkeyRegistrationResult): boolean {
    return result.success === false
}

/**
 * Side effects the failure-handling flow performs, injected so the orchestration
 * is unit-testable without a real renderer window or tray.
 */
export interface HotkeyFallbackDeps {
    /** Surface a typed error to the console (maps to the `error:show` channel). */
    emitError: (error: OperatorError) => void
    /**
     * Ensure the always-visible on-screen Emergency_Stop control (and/or a
     * tray/menu-bar entry) is available as a fallback (Req 7.8). Idempotent.
     */
    showOnScreenFallback: () => void
}

/**
 * Drive the fallback flow for a registration attempt (Req 7.7, 7.8).
 *
 * - Success: nothing to do; the hotkey is live. (The on-screen control is still
 *   shown separately whenever the agent is in control per Req 7.2 — that is the
 *   Window Manager's job, not this fallback path.)
 * - Failure (either classification): surface the typed error AND ensure the
 *   on-screen Emergency_Stop control is available, so the user always retains a
 *   working kill-switch even though the global hotkey could not be registered.
 *
 * @returns true when the fallback was engaged (i.e. registration failed).
 */
export function applyRegistrationResult(
    result: HotkeyRegistrationResult,
    deps: HotkeyFallbackDeps
): boolean {
    if (result.success) {
        return false
    }

    if (result.error) {
        deps.emitError(result.error)
    }
    // Req 7.8: on ANY registration failure the on-screen control must remain a
    // usable fallback. (The vendored copy only fell back on non-conflict
    // failures; for a safety kill-switch we always guarantee the fallback.)
    deps.showOnScreenFallback()
    return true
}
