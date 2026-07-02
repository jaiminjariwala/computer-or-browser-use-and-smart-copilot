/**
 * Accessibility permission helpers.
 *
 * Input synthesis (`AXIsProcessTrusted` / synthesized CGEvents) requires the
 * macOS Accessibility permission. Unlike Screen Recording, the trust API only
 * reports a boolean — trusted or not — so there is no rich status to normalize;
 * this module just maps that boolean into the shared {@link PermissionStatus}.
 */

import type { PermissionStatus } from '@op-shared/types'

/**
 * Map the Accessibility trust boolean to a {@link PermissionStatus}. macOS's
 * trust API only reports trusted/untrusted, so a non-trusted client is reported
 * as `not-determined` (the app may still be granted later) — which every gate
 * treats as not-granted (fail-closed).
 */
export function accessibilityTrustToStatus(trusted: boolean): PermissionStatus {
    return trusted ? 'granted' : 'not-determined'
}
