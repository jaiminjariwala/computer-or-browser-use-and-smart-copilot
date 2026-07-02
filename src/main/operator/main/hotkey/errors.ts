import type { OperatorError } from '@op-shared/types'

/**
 * Emergency_Stop hotkey registration errors (Task 9.1).
 *
 * When the global kill-switch cannot be registered, the Safety Controller must
 * BLOCK session start (Req 7.7). These types + the error builder produce the
 * typed, user-facing failure it surfaces; the on-screen fallback stays available
 * regardless (Req 7.8), so both classifications are recoverable.
 */

/** Why a registration attempt failed (failure classification, Req 7.7). */
export type HotkeyFailureReason = 'conflict' | 'failed'

/**
 * The outcome of attempting to register the Emergency_Stop hotkey.
 *
 * On success, `success` is true and `reason`/`error` are undefined. On failure,
 * `reason` classifies the failure (`conflict` = another app already holds the
 * accelerator; `failed` = any other rejection) and `error` is the typed,
 * user-facing {@link OperatorError} the Safety Controller surfaces while
 * blocking session start (Req 7.7).
 */
export interface HotkeyRegistrationResult {
    /** Whether the OS accepted the registration. */
    success: boolean
    /** The accelerator the attempt was made with. */
    accelerator: string
    /** Present on failure: the failure classification. */
    reason?: HotkeyFailureReason
    /** Present on failure: the typed, user-facing error (Req 7.7). */
    error?: OperatorError
}

/**
 * Build the typed {@link OperatorError} for a failed Emergency_Stop
 * registration. Both classifications use kind `hotkey-registration-failed` (the
 * fail-closed matrix entry for Req 7.7); the message and recovery action differ
 * so the UI can guide the user. Both are recoverable — the on-screen fallback
 * remains available regardless (Req 7.8).
 */
export function buildHotkeyError(
    reason: HotkeyFailureReason,
    accelerator: string
): OperatorError {
    if (reason === 'conflict') {
        return {
            kind: 'hotkey-registration-failed',
            message: `The Emergency_Stop shortcut ${accelerator} is already in use by another application. Choose a different shortcut, or use the on-screen Emergency Stop control.`,
            recoverable: true,
            action: 'retry'
        }
    }
    return {
        kind: 'hotkey-registration-failed',
        message: `Computer or Browser Use could not register the Emergency_Stop shortcut ${accelerator}. Use the on-screen Emergency Stop control instead.`,
        recoverable: true,
        action: 'retry'
    }
}
