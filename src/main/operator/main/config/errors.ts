import type { OperatorError } from '@op-shared/types'

/**
 * Start-gate error builders (Req 15.4, 15.7, 21.10).
 *
 * These are the two typed failures the credential/provider start-gate can
 * surface. Both are recoverable and carry an `action` so the renderer can jump
 * the user straight to the fix (configure a provider, or enter its key).
 */

/** Nothing is configured (or, with a probe, nothing is reachable) — Req 21.10. */
export function noProviderConfiguredError(): OperatorError {
    return {
        kind: 'no-provider-configured',
        message:
            'No model provider is configured or reachable. Configure a provider before starting a session.',
        recoverable: true,
        action: 'configure-provider'
    }
}

/** A configured provider still lacks a required API key — Req 15.4, 15.7. */
export function credentialsMissingError(): OperatorError {
    return {
        kind: 'credentials-missing',
        message: 'A required API key is missing. Enter the key before starting a session.',
        recoverable: true,
        action: 'enter-credentials'
    }
}
