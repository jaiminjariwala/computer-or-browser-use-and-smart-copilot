import { describe, it, expect } from 'vitest'
import { decideCaptureTrigger } from './capture-trigger'
import type { PermissionCheckResult } from './permissions'
import type { GlassError } from '@shared/types'

/**
 * Unit tests for the capture-trigger permission gate (task 8.1).
 *
 * The gate decides what happens on `capture:trigger`: show the overlay when
 * screen-recording permission is granted (Req 4.1), or skip the overlay and
 * surface permission instructions when it is not (Req 8.1).
 *
 * Validates: Requirements 4.1, 8.1
 */

const PERMISSION_ERROR: GlassError = {
    kind: 'permission-missing',
    message: 'Glass needs Screen Recording permission to capture your screen.',
    recoverable: true,
    action: 'open-settings'
}

describe('decideCaptureTrigger', () => {
    it('shows the overlay when permission is granted (Req 4.1)', () => {
        const result: PermissionCheckResult = { status: 'granted', granted: true }
        expect(decideCaptureTrigger(result)).toEqual({ kind: 'show-overlay' })
    })

    it('surfaces the permission error and skips the overlay when not granted (Req 8.1)', () => {
        const result: PermissionCheckResult = {
            status: 'denied',
            granted: false,
            error: PERMISSION_ERROR,
            instructions: {
                title: 'Allow Screen Recording for Glass',
                steps: ['Open System Settings'],
                settingsUrl: 'x-apple.systempreferences:...'
            }
        }
        const decision = decideCaptureTrigger(result)
        expect(decision.kind).toBe('permission-error')
        if (decision.kind === 'permission-error') {
            expect(decision.error).toBe(PERMISSION_ERROR)
        }
    })

    it.each(['denied', 'restricted', 'not-determined', 'unknown'] as const)(
        'never shows the overlay for non-granted status "%s" (Req 8.1)',
        (status) => {
            const result: PermissionCheckResult = {
                status,
                granted: false,
                error: { ...PERMISSION_ERROR }
            }
            expect(decideCaptureTrigger(result).kind).toBe('permission-error')
        }
    )

    it('falls back to a permission-missing error if a non-granted result omits one', () => {
        const result: PermissionCheckResult = { status: 'denied', granted: false }
        const decision = decideCaptureTrigger(result)
        expect(decision.kind).toBe('permission-error')
        if (decision.kind === 'permission-error') {
            expect(decision.error.kind).toBe('permission-missing')
            expect(decision.error.action).toBe('open-settings')
        }
    })
})
