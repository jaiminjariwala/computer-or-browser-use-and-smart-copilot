/**
 * User-facing operator errors.
 *
 * The single {@link OperatorError} shape surfaced to the renderer, carrying the
 * fail-closed error `kind`, a human message, recoverability, and an optional
 * remediation `action`.
 */

/** A user-facing operator error surfaced to the renderer (fail-closed matrix). */
export interface OperatorError {
    kind:
    | 'hotkey-registration-failed'
    | 'capture-failed'
    | 'permission-missing'
    | 'permission-revoked'
    | 'gateway-failed'
    | 'reasoning-unparseable'
    | 'action-failed'
    | 'action-rejected'
    | 'indicator-unavailable'
    | 'credentials-missing'
    | 'association-failed'
    | 'restore-failed'
    | 'all-providers-failed'
    | 'no-provider-configured'
    /** User-facing message. */
    message: string
    recoverable: boolean
    action?:
    | 'open-screen-settings'
    | 'open-accessibility-settings'
    | 'enter-credentials'
    | 'configure-provider'
    | 'retry'
    | 'restart-session'
}
