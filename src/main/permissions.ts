/**
 * Permission Service.
 *
 * Wraps macOS screen-recording permission checks via
 * `systemPreferences.getMediaAccessStatus('screen')` and maps each possible
 * status value to the correct application flow:
 *
 *   - `granted`        -> capture may proceed
 *   - anything else    -> capture is skipped and the user is shown
 *                         System Settings instructions, surfaced as a
 *                         `permission-missing` or `permission-revoked`
 *                         `GlassError`.
 *
 * The distinction between *missing* and *revoked* depends on whether the
 * permission was previously granted (i.e. a capture had succeeded before): if
 * it was, a later non-granted status means the permission was revoked between
 * captures (Req 8.3); otherwise it was never granted (Req 8.1).
 *
 * See design.md "Permission Service", "Error model", and the
 * "Error, Permission, and Edge Handling matrix".
 *
 * Requirements: 8.1, 8.2, 8.3
 */

import { systemPreferences } from 'electron'
import type { GlassError } from '../shared/types'

/**
 * The set of values `systemPreferences.getMediaAccessStatus('screen')` can
 * return. `unknown` is included defensively for non-macOS platforms or future
 * Electron values.
 */
export type ScreenPermissionStatus =
    | 'granted'
    | 'denied'
    | 'restricted'
    | 'not-determined'
    | 'unknown'

/**
 * A user-facing payload describing how to grant (or re-grant) the
 * screen-recording permission in macOS System Settings.
 */
export interface SystemSettingsInstructions {
    /** Short heading for the instructions surface. */
    title: string
    /** Ordered, human-readable steps the user should follow. */
    steps: string[]
    /**
     * Deep link that opens the Screen Recording pane in System Settings
     * (Privacy & Security > Screen Recording).
     */
    settingsUrl: string
}

/**
 * The result of a permission check: the raw status, whether capture may
 * proceed, and — when it may not — the error + instructions to surface.
 */
export interface PermissionCheckResult {
    /** The raw status reported by the OS. */
    status: ScreenPermissionStatus
    /** True only when `status === 'granted'`; capture may proceed (Req 8.2). */
    granted: boolean
    /** Present when not granted: the typed failure to surface to the user. */
    error?: GlassError
    /** Present when not granted: how to grant/re-grant in System Settings. */
    instructions?: SystemSettingsInstructions
}

/** Options influencing how a non-granted status is classified. */
export interface PermissionCheckOptions {
    /**
     * Whether screen-recording permission was previously granted (e.g. a
     * capture had already succeeded). When true, a later non-granted status is
     * treated as a revocation (Req 8.3) rather than a first-time missing
     * permission (Req 8.1).
     */
    previouslyGranted?: boolean
}

/** Deep link to the Screen Recording pane in macOS System Settings. */
export const SCREEN_RECORDING_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/**
 * Build the System Settings instructions payload. The wording differs slightly
 * for a first-time grant versus re-granting after a revocation.
 */
export function buildScreenSettingsInstructions(
    previouslyGranted: boolean
): SystemSettingsInstructions {
    if (previouslyGranted) {
        return {
            title: 'Re-enable Screen Recording for Glass',
            steps: [
                'Open System Settings > Privacy & Security > Screen Recording.',
                'Turn the toggle for Glass back on.',
                'If prompted, quit and reopen Glass so the change takes effect.',
                'Try the capture again.'
            ],
            settingsUrl: SCREEN_RECORDING_SETTINGS_URL
        }
    }

    return {
        title: 'Allow Screen Recording for Glass',
        steps: [
            'Open System Settings > Privacy & Security > Screen Recording.',
            'Find Glass in the list and turn its toggle on.',
            'If prompted, quit and reopen Glass so the change takes effect.',
            'Trigger the capture again once enabled.'
        ],
        settingsUrl: SCREEN_RECORDING_SETTINGS_URL
    }
}

/**
 * Map a raw permission status to the application flow.
 *
 * Pure and side-effect free so it can be unit-tested directly: `granted`
 * yields a capture-permitted result; every other value yields a
 * not-granted result carrying a `permission-missing` / `permission-revoked`
 * `GlassError` plus System Settings instructions.
 */
export function mapStatusToResult(
    status: ScreenPermissionStatus,
    options: PermissionCheckOptions = {}
): PermissionCheckResult {
    if (status === 'granted') {
        // Req 8.2: permission granted -> capture may proceed.
        return { status, granted: true }
    }

    const previouslyGranted = options.previouslyGranted ?? false
    const instructions = buildScreenSettingsInstructions(previouslyGranted)

    // Req 8.3 (revoked between captures) vs Req 8.1 (never granted).
    const kind = previouslyGranted ? 'permission-revoked' : 'permission-missing'

    const message = previouslyGranted
        ? 'Screen Recording permission was turned off, so Glass cannot capture your screen. Re-enable it in System Settings to continue.'
        : 'Glass needs Screen Recording permission to capture your screen. Enable it in System Settings to continue.'

    const error: GlassError = {
        kind,
        message,
        recoverable: true,
        action: 'open-settings'
    }

    return { status, granted: false, error, instructions }
}

/**
 * Read the current screen-recording permission status from the OS.
 *
 * Wraps `systemPreferences.getMediaAccessStatus('screen')` and normalizes the
 * return value to a {@link ScreenPermissionStatus}.
 */
export function getScreenPermissionStatus(): ScreenPermissionStatus {
    const status = systemPreferences.getMediaAccessStatus('screen')
    return status as ScreenPermissionStatus
}

/**
 * Check screen-recording permission and return the flow to follow.
 *
 * This is the primary entry point used before a capture: it reads the OS
 * status and maps it (granted -> capture, otherwise -> instructions + error).
 */
export function checkScreenPermission(
    options: PermissionCheckOptions = {}
): PermissionCheckResult {
    return mapStatusToResult(getScreenPermissionStatus(), options)
}
