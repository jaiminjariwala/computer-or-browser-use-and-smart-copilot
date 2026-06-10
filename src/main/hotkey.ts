/**
 * Hotkey Manager.
 *
 * Registers the system-wide `Global_Hotkey` via Electron's `globalShortcut` and
 * toggles the Sidebar_Panel when it fires. Because `globalShortcut` registers
 * the accelerator with the operating system, the hotkey fires regardless of
 * which application currently has OS focus (Req 1.6) — Glass does not need to be
 * the foreground app to respond.
 *
 * This module implements the happy path for task 6.1:
 *   - register the default hotkey on `app.whenReady` (Req 1.1)
 *   - toggle Sidebar visibility when it fires: show+focus when hidden, hide when
 *     visible (Req 1.2, 1.3)
 *   - respond while another app is focused (Req 1.6)
 *
 * The registration result also reports *why* registration failed (conflict vs.
 * other) so the conflict/failure fallback + tray handling in task 6.2 can build
 * on it without re-deriving the cause.
 *
 * See design.md "Hotkey + Tray Manager", "Error model", and the
 * "Error, Permission, and Edge Handling matrix".
 *
 * Requirements: 1.1, 1.2, 1.3, 1.6
 */

import { globalShortcut } from 'electron'
import type { GlassError } from '../shared/types'

/**
 * The default `Global_Hotkey` accelerator. `CommandOrControl+Shift+Space` maps
 * to ⌘⇧Space on macOS and is unlikely to collide with common app shortcuts.
 * The user can choose a different accelerator if this one conflicts (task 6.2).
 */
export const DEFAULT_GLOBAL_HOTKEY = 'CommandOrControl+Shift+Space'

/**
 * The minimal surface the Hotkey Manager needs to toggle the sidebar. The
 * WindowManager satisfies this directly via its `toggleSidebar()` method, but
 * keeping it as a tiny interface lets the manager be unit-tested without a real
 * window and decouples it from the full WindowManager.
 */
export interface SidebarToggler {
    /** Show+focus the Sidebar when hidden, hide it when visible (Req 1.2, 1.3). */
    toggleSidebar(): void
}

/** The reason a registration attempt failed. */
export type HotkeyFailureReason = 'conflict' | 'failed'

/**
 * The outcome of attempting to register the `Global_Hotkey`.
 *
 * On success, `success` is true and `error`/`reason` are undefined. On failure,
 * `reason` distinguishes a conflict (another app already holds the accelerator,
 * Req 1.4) from any other failure (Req 1.5), and `error` carries the typed
 * `GlassError` for task 6.2 to surface.
 */
export interface HotkeyRegistrationResult {
    /** Whether the OS accepted the registration. */
    success: boolean
    /** The accelerator the attempt was made with. */
    accelerator: string
    /** Present on failure: why it failed, for the 6.2 fallback. */
    reason?: HotkeyFailureReason
    /** Present on failure: the typed, user-facing error for 6.2. */
    error?: GlassError
}

/**
 * Build the typed `GlassError` for a failed registration.
 *
 * A conflict is recoverable by choosing a different hotkey (Req 1.4); any other
 * failure is recoverable via the tray fallback that opens the sidebar (Req 1.5).
 * Both are consumed by task 6.2.
 */
export function buildHotkeyError(
    reason: HotkeyFailureReason,
    accelerator: string
): GlassError {
    if (reason === 'conflict') {
        return {
            kind: 'hotkey-conflict',
            message: `The shortcut ${accelerator} is already in use by another application. Choose a different shortcut for Glass.`,
            recoverable: true,
            action: 'choose-hotkey'
        }
    }
    return {
        kind: 'hotkey-failed',
        message: `Glass could not register the shortcut ${accelerator}. Use the menu-bar icon to open Glass.`,
        recoverable: true
    }
}

/**
 * Owns the lifecycle of the `Global_Hotkey`: registration, the toggle callback,
 * and cleanup. A single instance manages one accelerator at a time.
 */
export class HotkeyManager {
    private readonly toggler: SidebarToggler
    private accelerator: string
    private registered = false

    constructor(toggler: SidebarToggler, accelerator: string = DEFAULT_GLOBAL_HOTKEY) {
        this.toggler = toggler
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
     * Register the `Global_Hotkey` with the OS (Req 1.1). The registered
     * callback toggles the Sidebar (Req 1.2, 1.3) and fires even when another
     * application has focus (Req 1.6).
     *
     * Returns a {@link HotkeyRegistrationResult} describing success or the
     * reason for failure so task 6.2 can drive the conflict/fallback flow.
     */
    register(): HotkeyRegistrationResult {
        // `globalShortcut.register` returns false when the OS rejects the
        // accelerator (most commonly because another app already holds it).
        const ok = globalShortcut.register(this.accelerator, () => {
            this.toggler.toggleSidebar()
        })

        if (ok) {
            this.registered = true
            return { success: true, accelerator: this.accelerator }
        }

        this.registered = false
        // Distinguish a conflict (accelerator already taken) from other
        // failures so 6.2 can offer the right recovery (Req 1.4 vs 1.5).
        const reason: HotkeyFailureReason = globalShortcut.isRegistered(this.accelerator)
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
     * Re-register the `Global_Hotkey` against a different accelerator after a
     * conflict (Req 1.4). Releases any currently-held binding, switches to the
     * new accelerator, and attempts registration again.
     *
     * Returns a {@link HotkeyRegistrationResult} for the new accelerator so the
     * caller can re-run the conflict/fallback flow (e.g. the new choice is
     * *also* taken, prompting the user to pick yet another).
     */
    reRegister(accelerator: string): HotkeyRegistrationResult {
        // Release the previous accelerator's binding (if any) before switching
        // so we never leave a stale OS-level registration behind.
        if (this.registered) {
            globalShortcut.unregister(this.accelerator)
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
        globalShortcut.unregisterAll()
        this.registered = false
    }
}

/**
 * Side effects the failure-handling flow performs, injected so the
 * orchestration is unit-testable without a real renderer window or `Tray`.
 */
export interface HotkeyFallbackDeps {
    /** Surface a typed error to the Sidebar (maps to the `error:show` channel). */
    emitError: (error: GlassError) => void
    /** Bring up the menu-bar (Tray) fallback that can open the Sidebar (Req 1.5). */
    showTray: () => void
}

/**
 * Drive the conflict/failure fallback for a registration attempt (task 6.2).
 *
 * - Success: nothing to do.
 * - Conflict (Req 1.4): surface the conflict message (its `action` is
 *   `'choose-hotkey'`) so the user can pick a different accelerator; no tray is
 *   created because the hotkey path is still recoverable.
 * - Other failure (Req 1.5): surface the failure message AND bring up the
 *   menu-bar (Tray) icon so the user can still open the Sidebar without a
 *   working hotkey.
 *
 * See design.md "Error, Permission, and Edge Handling matrix".
 */
export function applyRegistrationResult(
    result: HotkeyRegistrationResult,
    deps: HotkeyFallbackDeps
): void {
    if (result.success) {
        return
    }

    if (result.error) {
        deps.emitError(result.error)
    }

    // Only a non-conflict failure falls back to the tray; a conflict is
    // recovered by letting the user choose a different hotkey (Req 1.4).
    if (result.reason === 'failed') {
        deps.showTray()
    }
}
