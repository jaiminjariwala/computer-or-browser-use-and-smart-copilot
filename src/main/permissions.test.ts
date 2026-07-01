import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Unit tests for the Permission Service.
 *
 * Covers the mapping of every `getMediaAccessStatus('screen')` value to the
 * correct flow, the missing-vs-revoked classification, and the instructions
 * payload. `systemPreferences` is mocked so the tests run on any platform.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */

// Mock the electron module before importing the service.
const getMediaAccessStatus = vi.fn()
vi.mock('electron', () => ({
    systemPreferences: {
        getMediaAccessStatus: (...args: unknown[]) => getMediaAccessStatus(...args)
    }
}))

import {
    mapStatusToResult,
    checkScreenPermission,
    getScreenPermissionStatus,
    buildScreenSettingsInstructions,
    SCREEN_RECORDING_SETTINGS_URL,
    type ScreenPermissionStatus
} from './permissions'

const NON_GRANTED: ScreenPermissionStatus[] = [
    'denied',
    'restricted',
    'not-determined',
    'unknown'
]

describe('mapStatusToResult', () => {
    it('permits capture when granted (Req 8.2)', () => {
        const result = mapStatusToResult('granted')
        expect(result.granted).toBe(true)
        expect(result.status).toBe('granted')
        expect(result.error).toBeUndefined()
        expect(result.instructions).toBeUndefined()
    })

    it.each(NON_GRANTED)(
        'blocks capture and surfaces instructions when status is "%s" (Req 8.1)',
        (status) => {
            const result = mapStatusToResult(status)
            expect(result.granted).toBe(false)
            expect(result.status).toBe(status)
            expect(result.instructions).toBeDefined()
            expect(result.instructions?.settingsUrl).toBe(SCREEN_RECORDING_SETTINGS_URL)
            expect(result.instructions?.steps.length).toBeGreaterThan(0)
            expect(result.error).toBeDefined()
            expect(result.error?.action).toBe('open-settings')
            expect(result.error?.recoverable).toBe(true)
        }
    )

    it.each(NON_GRANTED)(
        'classifies "%s" as permission-missing when not previously granted (Req 8.1)',
        (status) => {
            const result = mapStatusToResult(status, { previouslyGranted: false })
            expect(result.error?.kind).toBe('permission-missing')
        }
    )

    it.each(NON_GRANTED)(
        'classifies "%s" as permission-revoked when previously granted (Req 8.3)',
        (status) => {
            const result = mapStatusToResult(status, { previouslyGranted: true })
            expect(result.error?.kind).toBe('permission-revoked')
            // Re-grant instructions should be present (Req 8.3).
            expect(result.instructions?.title.toLowerCase()).toContain('re-enable')
        }
    )

    it('defaults to permission-missing when no options are supplied', () => {
        expect(mapStatusToResult('denied').error?.kind).toBe('permission-missing')
    })
})

describe('buildScreenSettingsInstructions', () => {
    it('returns first-time grant instructions when not previously granted', () => {
        const instructions = buildScreenSettingsInstructions(false)
        expect(instructions.title.toLowerCase()).toContain('allow')
        expect(instructions.settingsUrl).toBe(SCREEN_RECORDING_SETTINGS_URL)
        expect(instructions.steps.length).toBeGreaterThan(0)
    })

    it('returns re-grant instructions when previously granted', () => {
        const instructions = buildScreenSettingsInstructions(true)
        expect(instructions.title.toLowerCase()).toContain('re-enable')
        expect(instructions.settingsUrl).toBe(SCREEN_RECORDING_SETTINGS_URL)
    })
})

describe('getScreenPermissionStatus', () => {
    beforeEach(() => {
        getMediaAccessStatus.mockReset()
    })

    it('queries systemPreferences for the screen media type', () => {
        getMediaAccessStatus.mockReturnValue('granted')
        const status = getScreenPermissionStatus()
        expect(getMediaAccessStatus).toHaveBeenCalledWith('screen')
        expect(status).toBe('granted')
    })
})

describe('checkScreenPermission', () => {
    beforeEach(() => {
        getMediaAccessStatus.mockReset()
    })

    it('permits capture when the OS reports granted (Req 8.2)', () => {
        getMediaAccessStatus.mockReturnValue('granted')
        const result = checkScreenPermission()
        expect(result.granted).toBe(true)
        expect(result.error).toBeUndefined()
    })

    it.each(NON_GRANTED)(
        'blocks capture and reports permission-missing for "%s" (Req 8.1)',
        (status) => {
            getMediaAccessStatus.mockReturnValue(status)
            const result = checkScreenPermission()
            expect(result.granted).toBe(false)
            expect(result.error?.kind).toBe('permission-missing')
            expect(result.instructions).toBeDefined()
        }
    )

    it('reports permission-revoked when permission was previously granted (Req 8.3)', () => {
        getMediaAccessStatus.mockReturnValue('denied')
        const result = checkScreenPermission({ previouslyGranted: true })
        expect(result.granted).toBe(false)
        expect(result.error?.kind).toBe('permission-revoked')
        expect(result.instructions?.title.toLowerCase()).toContain('re-enable')
    })
})
