import { describe, it, expect } from 'vitest'
import { createTurnId, isSubmittable, makeTextTurn } from './chat'

/**
 * Unit tests for the Sidebar chat helpers (task 2.1).
 *
 * Confirms typed-text submission gating (Req 2.6) and that submitted text
 * becomes a well-formed conversation turn for the conversation view (Req 2.2).
 */
describe('isSubmittable', () => {
    it('accepts non-empty text', () => {
        expect(isSubmittable('hello')).toBe(true)
    })

    it('rejects empty and whitespace-only text', () => {
        expect(isSubmittable('')).toBe(false)
        expect(isSubmittable('   \n\t ')).toBe(false)
    })
})

describe('makeTextTurn', () => {
    it('builds a user turn from typed text', () => {
        const turn = makeTextTurn('user', '  how do I do X?  ')
        expect(turn).not.toBeNull()
        expect(turn?.role).toBe('user')
        // Text is trimmed.
        expect(turn?.text).toBe('how do I do X?')
        expect(turn?.status).toBe('ok')
        expect(turn?.id).toBeTruthy()
        expect(() => new Date(turn!.createdAt).toISOString()).not.toThrow()
    })

    it('returns null for empty/whitespace input', () => {
        expect(makeTextTurn('user', '')).toBeNull()
        expect(makeTextTurn('user', '   ')).toBeNull()
    })

    it('supports assistant turns', () => {
        const turn = makeTextTurn('assistant', 'next, click Create role')
        expect(turn?.role).toBe('assistant')
    })
})

describe('createTurnId', () => {
    it('produces unique ids across calls', () => {
        const ids = new Set(Array.from({ length: 100 }, () => createTurnId()))
        expect(ids.size).toBe(100)
    })
})
