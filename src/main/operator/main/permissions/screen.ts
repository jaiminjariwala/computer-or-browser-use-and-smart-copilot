/**
 * Screen Recording permission — VENDORED from Click Copilot `permissions.ts`
 * (Task 2).
 *
 * Reuse rule (Req 19): a one-time COPY into the Click Operator tree; it does not
 * import from or modify the `click-copilot` project. Click Operator owns and
 * evolves this copy. This module is the ORIGINAL screen-only flow using the
 * legacy `GlassError` shape; the extended, two-permission service (Screen
 * Recording + Accessibility, using `OperatorError`) lives in `service.ts`.
 *
 * It wraps `systemPreferences.getMediaAccessStatus('screen')` and maps each
 * status to the right flow:
 *   - `granted`     -> capture may proceed
 *   - anything else -> capture is skipped and the user is shown System Settings
 *                      instructions, surfaced as `permission-missing` or
 *                      `permission-revoked`.
 *
 * The missing/revoked distinction depends on whether the permission was
 * previously granted (i.e. a capture had succeeded before).
 */

import { systemPreferences } from 'electron'
import type { GlassError } from '../vendor-types'
import type { PermissionStatus } from '@op-shared/types'
import { buildScreenSettingsInstructions, type SystemSettingsInstructions } from './instructions'

/**
 * The values `systemPreferences.getMediaAccessStatus('screen')` can return.
 * `unknown` is included defensively for non-macOS platforms or future Electron
 * values.
 */
export type ScreenPermissionStatus =
    | 'granted'
    | 'denied'
    | 'restricted'
    | 'not-determined'
    | 'unknown'

/**
 * The result of a screen permission check: the raw status, whether capture may
 * proceed, and — when it may not — the error + instructions to surface.
 */
export interface PermissionCheckResult {
    /** The raw status reported by the OS. */
    status: ScreenPermissionStatus
    /** True only when `status === 'granted'`; capture may proceed. */
    granted: boolean
    /** Present when not granted: the typed failure to surface to the user. */
    error?: GlassError
    /** Present when not granted: how to grant/re-grant in System Settings. */
    instructions?: SystemSettingsInstructions
}

/** Options influencing how a non-granted status is classified. */
export interface PermissionCheckOptions {
    /**
     * Whether screen-recording permission was previously granted (e.g. a capture
     * had already succeeded). When true, a later non-granted status is treated
     * as a revocation rather than a first-time missing permission.
     */
    previouslyGranted?: boolean
}

/**
 * Map a raw permission status to the application flow.
 *
 * Pure and side-effect free so it can be unit-tested directly: `granted` yields
 * a capture-permitted result; every other value yields a not-granted result
 * carrying a `permission-missing` / `permission-revoked` error plus System
 * Settings instructions.
 */
export function mapStatusToResult(
    status: ScreenPermissionStatus,
    options: PermissionCheckOptions = {}
): PermissionCheckResult {
    if (status === 'granted') {
        // Permission granted -> capture may proceed.
        return { status, granted: true }
    }

    const previouslyGranted = options.previouslyGranted ?? false
    const instructions = buildScreenSettingsInstructions(previouslyGranted)

    // Revoked between captures vs never granted.
    const kind = previouslyGranted ? 'permission-revoked' : 'permission-missing'

    const message = previouslyGranted
        ? 'Screen Recording permission was turned off, so Click Operator cannot capture your screen. Re-enable it in System Settings to continue.'
        : 'Click Operator needs Screen Recording permission to capture your screen. Enable it in System Settings to continue.'

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
 * The primary entry point used before a capture: reads the OS status and maps
 * it (granted -> capture, otherwise -> instructions + error).
 */
export function checkScreenPermission(
    options: PermissionCheckOptions = {}
): PermissionCheckResult {
    return mapStatusToResult(getScreenPermissionStatus(), options)
}

/**
 * Normalize any raw `getMediaAccessStatus` value to a {@link PermissionStatus}.
 * Unknown/other values fail closed to `denied` so a non-granted permission can
 * never be mistaken for granted. Used by the two-permission service's probe.
 */
export function normalizeScreenStatus(raw: string): PermissionStatus {
    switch (raw) {
        case 'granted':
        case 'denied':
        case 'restricted':
        case 'not-determined':
            return raw
        default:
            return 'denied'
    }
}
