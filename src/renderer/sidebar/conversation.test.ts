import { describe, it, expect } from 'vitest'
import type { GlassError, TurnView } from '@shared/types'
import {
    addUserMessage,
    appendTurn,
    clearError,
    initialConversationState,
    setError,
    setPending
} from './conversation'

/**
 * Unit tests for the Sidebar conversation reducer (task 2.3).
 *
 * Covers optimistic user-message rendering (Req 2.2), appending turns pushed by
 * the main process incl. optimistic reconciliation (Req 2.4, 5.2), the
 * in-progress indicator toggle (Req 5.3), and the error indicator that retains
 * messages in the conversation view (Req 2.3).
 */

function assistantTurn(id: string, text: string): TurnView {
    return { id, role: 'assistant', text, createdAt: new Date().toISOString(), status: 'ok' }
}

function userTurn(id: string, text: string): TurnView {
    return { id, role: 'user', text, createdAt: new Date().toISOString(), status: 'ok' }
}

const SAMPLE_ERROR: GlassError = {
    kind: 'gateway-failed',
    message: 'The gateway request failed.',
    recoverable: true
}

describe('initialConversationState', () => {
    it('starts empty by default', () => {
        const s = initialConversationState()
        expect(s.turns).toEqual([])
        expect(s.pending).toBe(false)
        expect(s.error).toBeNull()
    })

    it('seeds restored turns without sharing the array reference', () => {
        const turns = [userTurn('u1', 'hi')]
        const s = initialConversationState(turns)
        expect(s.turns).toEqual(turns)
        expect(s.turns).not.toBe(turns)
    })
})

describe('addUserMessage (optimistic render — Req 2.2)', () => {
    it('appends a user turn and returns it for sending', () => {
        const s0 = initialConversationState()
        const { state, turn } = addUserMessage(s0, '  how do I do X?  ')
        expect(turn).not.toBeNull()
        expect(turn?.role).toBe('user')
        expect(turn?.text).toBe('how do I do X?')
        expect(state.turns).toHaveLength(1)
        expect(state.turns[0]).toBe(turn)
        // The optimistic turn is tracked as unconfirmed.
        expect(state.unconfirmedUserTurnIds).toContain(turn!.id)
    })

    it('ignores empty / whitespace input', () => {
        const s0 = initialConversationState()
        const { state, turn } = addUserMessage(s0, '   ')
        expect(turn).toBeNull()
        expect(state).toBe(s0)
    })

    it('clears a prior error indicator on a new submit but keeps turns', () => {
        let s = initialConversationState()
        s = addUserMessage(s, 'first').state
        s = setError(s, SAMPLE_ERROR)
        expect(s.error).not.toBeNull()
        s = addUserMessage(s, 'second').state
        expect(s.error).toBeNull()
        expect(s.turns.map((t) => t.text)).toEqual(['first', 'second'])
    })
})

describe('appendTurn (turns from main — Req 2.4, 5.2)', () => {
    it('appends an assistant turn in arrival order', () => {
        let s = initialConversationState()
        s = addUserMessage(s, 'hello').state
        s = appendTurn(s, assistantTurn('a1', 'next, click Create role'))
        expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        expect(s.turns[1].text).toBe('next, click Create role')
    })

    it('is idempotent by id', () => {
        let s = initialConversationState()
        const t = assistantTurn('a1', 'guidance')
        s = appendTurn(s, t)
        s = appendTurn(s, t)
        expect(s.turns).toHaveLength(1)
    })

    it('reconciles an optimistic user turn instead of duplicating it', () => {
        let s = initialConversationState()
        const { state, turn } = addUserMessage(s, 'open IAM')
        s = state
        // Main echoes the same user message with its own authoritative id.
        s = appendTurn(s, userTurn('server-1', 'open IAM'))
        expect(s.turns).toHaveLength(1)
        expect(s.turns[0].id).toBe('server-1')
        expect(s.unconfirmedUserTurnIds).not.toContain(turn!.id)
    })

    it('appends a genuinely new user turn when none is pending reconciliation', () => {
        let s = initialConversationState()
        s = appendTurn(s, userTurn('server-1', 'one'))
        s = appendTurn(s, userTurn('server-2', 'two'))
        expect(s.turns.map((t) => t.text)).toEqual(['one', 'two'])
    })

    it('does not wrongly dedupe two identical user messages sent separately', () => {
        let s = initialConversationState()
        // First message optimistic, then confirmed by an assistant turn.
        s = addUserMessage(s, 'yes').state
        s = appendTurn(s, assistantTurn('a1', 'ok'))
        // Second identical message optimistic.
        s = addUserMessage(s, 'yes').state
        const userTurns = s.turns.filter((t) => t.role === 'user')
        expect(userTurns).toHaveLength(2)
    })
})

describe('setPending (in-progress indicator — Req 5.3)', () => {
    it('toggles the pending flag', () => {
        let s = initialConversationState()
        s = setPending(s, true)
        expect(s.pending).toBe(true)
        s = setPending(s, false)
        expect(s.pending).toBe(false)
    })
})

describe('setError (error indicator retains messages — Req 2.3)', () => {
    it('surfaces the error and clears pending without dropping turns', () => {
        let s = initialConversationState()
        s = addUserMessage(s, 'do the thing').state
        s = setPending(s, true)
        s = setError(s, SAMPLE_ERROR)
        expect(s.error).toEqual(SAMPLE_ERROR)
        expect(s.pending).toBe(false)
        // The submitted message is retained in the conversation view.
        expect(s.turns).toHaveLength(1)
        expect(s.turns[0].text).toBe('do the thing')
    })

    it('clearError removes the indicator but keeps turns', () => {
        let s = initialConversationState()
        s = addUserMessage(s, 'msg').state
        s = setError(s, SAMPLE_ERROR)
        s = clearError(s)
        expect(s.error).toBeNull()
        expect(s.turns).toHaveLength(1)
    })
})
