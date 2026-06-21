import type { GlassError } from '@shared/types'
import type { PermissionCheckResult } from './permissions'

/**
 * Capture-trigger permission gate (design: Flow B, "trigger capture").
 *
 * Pure decision logic for what should happen when the user triggers a region
 * capture (`capture:trigger`). Screen-recording permission is checked FIRST: if
 * it is granted the Overlay_Window is shown (Req 4.1); otherwise the overlay is
 * skipped and the System Settings instructions are surfaced as a `GlassError`
 * on `error:show` (Req 8.1).
 *
 * Kept free of any Electron import so the gate can be unit-tested directly; the
 * caller supplies a {@link PermissionCheckResult} from the Permission Service.
 *
 * Requirements: 4.1, 8.1
 */

/** What the main process should do in response to `capture:trigger`. */
export type CaptureTriggerDecision =
    | { kind: 'show-overlay' }
    | { kind: 'permission-error'; error: GlassError }

/**
 * Fallback error used only if a non-granted permission result somehow omits its
 * typed error. Mirrors the Permission Service's `permission-missing` shape so
 * the user still gets actionable instructions (Req 8.1).
 */
const FALLBACK_PERMISSION_ERROR: GlassError = {
    kind: 'permission-missing',
    message:
        'Glass needs Screen Recording permission to capture your screen. Enable it in System Settings to continue.',
    recoverable: true,
    action: 'open-settings'
}

/**
 * Decide whether to show the capture overlay or surface a permission error.
 *
 * Granted -> show the overlay (Req 4.1). Anything else -> emit the permission
 * instructions error and skip the overlay entirely (Req 8.1).
 */
export function decideCaptureTrigger(
    result: PermissionCheckResult
): CaptureTriggerDecision {
    if (result.granted) {
        return { kind: 'show-overlay' }
    }
    return {
        kind: 'permission-error',
        error: result.error ?? FALLBACK_PERMISSION_ERROR
    }
}
