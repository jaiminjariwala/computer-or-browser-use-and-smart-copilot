import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatFlow, type ChatFlowEmitters } from './chat-flow'
import { SessionManager } from './session'
import {
    GlassErrorException,
    credentialsMissingError,
    gatewayFailedError
} from './ai'
import type { GlassError, SessionContext, TurnView, TurnCapture } from '@shared/types'

/**
 * Tests for the Flow A orchestrator (design "Flow A — User types a message").
 *
 * The orchestrator is exercised against a real {@link SessionManager} (it is
 * Electron-free) and recording emitters, so we can assert on the exact ordering
 * of events and on session state across the success and failure paths.
 */

/** A recorder that captures every emitted event in order for assertions. */
function makeRecorder(): {
    emitters: ChatFlowEmitters
    events: Array<{ type: string; payload?: unknown }>
} {
    const events: Array<{ type: string; payload?: unknown }> = []
    return {
        events,
        emitters: {
            turnAppended: (turn) => events.push({ type: 'turn', payload: turn }),
            pending: (pending) => events.push({ type: 'pending', payload: pending }),
            error: (error) => events.push({ type: 'error', payload: error }),
            credentialsRequired: () => events.push({ type: 'credentials-required' })
        }
    }
}

/** A deterministic session manager so turn ids/timestamps are predictable. */
function makeSession(): SessionManager {
    let n = 0
    return new SessionManager({
        generateId: () => `id-${++n}`,
        now: () => '2024-01-01T00:00:00.000Z'
    })
}

/** A small, valid {@link TurnCapture} fixture for the Flow B tests. */
function makeCapture(overrides: Partial<TurnCapture> = {}): TurnCapture {
    return {
        dataUrl: 'data:image/png;base64,FULLIMAGE',
        thumbnailUrl: 'data:image/png;base64,THUMB',
        rect: { x: 10, y: 20, width: 100, height: 80 },
        ...overrides
    }
}

describe('ChatFlow.handleSendMessage — success path (Flow A)', () => {
    it('emits user turn, pending true, assistant turn, pending false in order', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('Click the Add user button.') }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('how do I add a user?')

        expect(events.map((e) => e.type)).toEqual([
            'turn', // user turn appended + emitted
            'pending', // pending true
            'turn', // assistant turn appended + emitted
            'pending' // pending false
        ])

        const [userEvt, pendingOn, assistantEvt, pendingOff] = events
        expect((userEvt.payload as TurnView).role).toBe('user')
        expect((userEvt.payload as TurnView).text).toBe('how do I add a user?')
        expect(pendingOn.payload).toBe(true)
        expect((assistantEvt.payload as TurnView).role).toBe('assistant')
        expect((assistantEvt.payload as TurnView).text).toBe('Click the Add user button.')
        expect(pendingOff.payload).toBe(false)
    })

    it('builds context AFTER appending the user turn so the message is included', async () => {
        const session = makeSession()
        let seenContext: SessionContext | undefined
        const ai = {
            complete: vi.fn().mockImplementation((ctx: SessionContext) => {
                seenContext = ctx
                return Promise.resolve('ok')
            })
        }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('the new message')

        expect(ai.complete).toHaveBeenCalledOnce()
        const recent = seenContext?.recentTurns ?? []
        expect(recent.some((t) => t.role === 'user' && t.text === 'the new message')).toBe(true)
    })

    it('records both turns in the session in chronological order', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('guidance') }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('hello')

        const turns = session.getSessionView().turns
        expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        expect(turns[0].text).toBe('hello')
        expect(turns[1].text).toBe('guidance')
    })

    it('ignores blank submissions without appending turns or calling the gateway', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn() }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('   ')

        expect(ai.complete).not.toHaveBeenCalled()
        expect(events).toEqual([])
        expect(session.getSessionView().turns).toEqual([])
    })

    it('trims the submitted message before appending', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('ok') }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('  spaced  ')

        expect(session.getSessionView().turns[0].text).toBe('spaced')
    })
})

describe('ChatFlow.handleSendMessage — failure path (Req 7.3, 5.4)', () => {
    it('keeps the user turn and clears pending when the gateway fails', async () => {
        const session = makeSession()
        const glassError = gatewayFailedError(new Error('boom'))
        const ai = {
            complete: vi.fn().mockRejectedValue(new GlassErrorException(glassError))
        }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('please help')

        // User turn retained; no assistant turn appended.
        const turns = session.getSessionView().turns
        expect(turns).toHaveLength(1)
        expect(turns[0].role).toBe('user')
        expect(turns[0].text).toBe('please help')

        // Events: user turn, pending true, error, pending false.
        expect(events.map((e) => e.type)).toEqual(['turn', 'pending', 'error', 'pending'])
        expect(events[1].payload).toBe(true)
        expect((events[2].payload as GlassError).kind).toBe('gateway-failed')
        expect(events[3].payload).toBe(false)
    })

    it('wraps an untyped throw as a gateway-failed error', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockRejectedValue(new Error('network down')) }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('hi')

        const errorEvt = events.find((e) => e.type === 'error')
        expect((errorEvt?.payload as GlassError).kind).toBe('gateway-failed')
    })

    it('routes a missing-credentials failure to credentials:required (Req 7.4)', async () => {
        const session = makeSession()
        const ai = {
            complete: vi
                .fn()
                .mockRejectedValue(new GlassErrorException(credentialsMissingError()))
        }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('do the thing')

        const types = events.map((e) => e.type)
        expect(types).toContain('credentials-required')
        expect(types).not.toContain('error') // not double-surfaced as error:show
        expect(types[types.length - 1]).toBe('pending')
        expect(events[events.length - 1].payload).toBe(false)
    })

    it('falls back to error:show for missing credentials when no credentials emitter exists', async () => {
        const session = makeSession()
        const ai = {
            complete: vi
                .fn()
                .mockRejectedValue(new GlassErrorException(credentialsMissingError()))
        }
        const events: Array<{ type: string; payload?: unknown }> = []
        const emitters: ChatFlowEmitters = {
            turnAppended: (t) => events.push({ type: 'turn', payload: t }),
            pending: (p) => events.push({ type: 'pending', payload: p }),
            error: (e) => events.push({ type: 'error', payload: e })
            // no credentialsRequired
        }
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('hello')

        const errorEvt = events.find((e) => e.type === 'error')
        expect((errorEvt?.payload as GlassError).kind).toBe('credentials-missing')
    })

    it('recovers on the next message after a failure (Req 5.4 — no sticky state)', async () => {
        const session = makeSession()
        const ai = {
            complete: vi
                .fn()
                .mockRejectedValueOnce(new GlassErrorException(gatewayFailedError('first failed')))
                .mockResolvedValueOnce('here is your next step')
        }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleSendMessage('first try')
        const eventCountAfterFailure = events.length

        await flow.handleSendMessage('second try')

        // The second message produced an assistant turn despite the first failing.
        const turns = session.getSessionView().turns
        expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
            'user:first try',
            'user:second try',
            'assistant:here is your next step'
        ])

        // The second run emitted a fresh pending toggle and an assistant turn.
        const secondRun = events.slice(eventCountAfterFailure)
        expect(secondRun.map((e) => e.type)).toEqual(['turn', 'pending', 'turn', 'pending'])
        expect(secondRun[1].payload).toBe(true)
        expect(secondRun[3].payload).toBe(false)
    })
})

describe('ChatFlow.handleCapture — success path (Flow B)', () => {
    it('emits capture turn, pending true, assistant guidance, pending false in order', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('Click the Create role button.') }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleCapture(makeCapture())

        expect(events.map((e) => e.type)).toEqual([
            'turn', // capture user turn appended + emitted (thumbnail shows)
            'pending', // pending true
            'turn', // assistant guidance appended + emitted
            'pending' // pending false
        ])

        const [captureEvt, pendingOn, assistantEvt, pendingOff] = events
        const captureTurn = captureEvt.payload as TurnView
        expect(captureTurn.role).toBe('user')
        // The capture turn carries the thumbnail so the sidebar can render it (Req 4.5).
        expect(captureTurn.capture?.thumbnailUrl).toBe('data:image/png;base64,THUMB')
        expect(captureTurn.text).toBeUndefined()
        expect(pendingOn.payload).toBe(true)
        expect((assistantEvt.payload as TurnView).role).toBe('assistant')
        expect((assistantEvt.payload as TurnView).text).toBe('Click the Create role button.')
        expect(pendingOff.payload).toBe(false)
    })

    it('sends the capture as currentCapture alongside the session context (Req 3.3, 5.1)', async () => {
        const session = makeSession()
        let seenContext: SessionContext | undefined
        const ai = {
            complete: vi.fn().mockImplementation((ctx: SessionContext) => {
                seenContext = ctx
                return Promise.resolve('next step')
            })
        }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        const capture = makeCapture()
        await flow.handleCapture(capture)

        expect(ai.complete).toHaveBeenCalledOnce()
        // The image is attached as the current capture under interpretation...
        expect(seenContext?.currentCapture?.dataUrl).toBe(capture.dataUrl)
        // ...and the session context (summary + recent turns) is always present,
        // so a text-less capture is interpreted against the existing session.
        expect(seenContext?.summary).toBeDefined()
        expect(Array.isArray(seenContext?.recentTurns)).toBe(true)
        // The just-appended capture turn is part of the recent turns.
        expect(
            seenContext?.recentTurns.some((t) => t.capture?.dataUrl === capture.dataUrl)
        ).toBe(true)
    })

    it('records the capture turn then the assistant turn in chronological order', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('guidance') }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleCapture(makeCapture())

        const turns = session.getSessionView().turns
        expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        expect(turns[0].capture?.dataUrl).toBe('data:image/png;base64,FULLIMAGE')
        expect(turns[1].text).toBe('guidance')
    })

    it('attaches accompanying text to the capture turn when provided', async () => {
        const session = makeSession()
        const ai = { complete: vi.fn().mockResolvedValue('ok') }
        const { emitters } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleCapture(makeCapture(), '  what is this?  ')

        const captureTurn = session.getSessionView().turns[0]
        expect(captureTurn.text).toBe('what is this?')
        expect(captureTurn.capture?.dataUrl).toBe('data:image/png;base64,FULLIMAGE')
    })
})

describe('ChatFlow.handleCapture — failure path (Req 7.3)', () => {
    it('keeps the capture turn and clears pending when the gateway fails', async () => {
        const session = makeSession()
        const ai = {
            complete: vi
                .fn()
                .mockRejectedValue(new GlassErrorException(gatewayFailedError(new Error('boom'))))
        }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleCapture(makeCapture())

        // Capture turn retained; no assistant turn appended (Req 7.3, Property 6).
        const turns = session.getSessionView().turns
        expect(turns).toHaveLength(1)
        expect(turns[0].role).toBe('user')
        expect(turns[0].capture?.dataUrl).toBe('data:image/png;base64,FULLIMAGE')

        // Events: capture turn, pending true, error, pending false.
        expect(events.map((e) => e.type)).toEqual(['turn', 'pending', 'error', 'pending'])
        expect(events[1].payload).toBe(true)
        expect((events[2].payload as GlassError).kind).toBe('gateway-failed')
        expect(events[3].payload).toBe(false)
    })

    it('routes a missing-credentials failure to credentials:required (Req 7.4)', async () => {
        const session = makeSession()
        const ai = {
            complete: vi
                .fn()
                .mockRejectedValue(new GlassErrorException(credentialsMissingError()))
        }
        const { emitters, events } = makeRecorder()
        const flow = new ChatFlow({ session, ai, emitters })

        await flow.handleCapture(makeCapture())

        const types = events.map((e) => e.type)
        expect(types).toContain('credentials-required')
        expect(types).not.toContain('error')
        // The capture turn is still retained.
        expect(session.getSessionView().turns).toHaveLength(1)
        expect(types[types.length - 1]).toBe('pending')
        expect(events[events.length - 1].payload).toBe(false)
    })
})
