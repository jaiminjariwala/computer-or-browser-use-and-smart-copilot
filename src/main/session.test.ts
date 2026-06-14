import { describe, it, expect, vi } from 'vitest'
import type { Session, Turn, TurnCapture } from '@shared/types'
import {
    KEEP_RECENT,
    SessionManager,
    createEmptySession,
    createEmptySummary,
    type IdGenerator
} from './session'

// --- Helpers ----------------------------------------------------------------

const rect = { x: 0, y: 0, width: 10, height: 10 }

function capture(dataUrl: string): TurnCapture {
    return { dataUrl, thumbnailUrl: `${dataUrl}#thumb`, rect }
}

/** Deterministic, monotonic id generator: id-0, id-1, ... */
function sequentialIds(): IdGenerator {
    let n = 0
    return () => `id-${n++}`
}

/** Deterministic clock that advances one second per call, ISO formatted. */
function steppingClock(): () => string {
    let ms = Date.UTC(2024, 0, 1, 0, 0, 0)
    return () => {
        const iso = new Date(ms).toISOString()
        ms += 1000
        return iso
    }
}

function makeManager(overrides: Partial<{ keepRecent: number }> = {}): SessionManager {
    return new SessionManager({
        generateId: sequentialIds(),
        now: steppingClock(),
        keepRecent: overrides.keepRecent
    })
}

// --- Factories --------------------------------------------------------------

describe('createEmptySummary', () => {
    it('has empty intent, no steps, and null watermark', () => {
        expect(createEmptySummary()).toEqual({
            inferredIntent: '',
            completedSteps: [],
            updatedThroughTurnId: null
        })
    })
})

describe('createEmptySession', () => {
    it('mints an id and matching created/updated timestamps with no turns', () => {
        const session = createEmptySession(sequentialIds(), steppingClock())
        expect(session.id).toBe('id-0')
        expect(session.turns).toEqual([])
        expect(session.summary).toEqual(createEmptySummary())
        expect(session.createdAt).toBe(session.updatedAt)
    })
})

// --- Construction -----------------------------------------------------------

describe('SessionManager construction', () => {
    it('starts with an empty active session', () => {
        const mgr = makeManager()
        const view = mgr.getSessionView()
        expect(view.turns).toEqual([])
        expect(view.summary).toEqual(createEmptySummary())
        expect(view.id).toBe('id-0')
    })
})

// --- appendTurn ordering + minting (Req 3.2, Property 6) --------------------

describe('SessionManager.appendTurn', () => {
    it('mints id, timestamp, and defaults status to ok', () => {
        const mgr = makeManager()
        const turn = mgr.appendTurn({ role: 'user', text: 'hello' })
        expect(turn.id).toBe('id-1') // id-0 was the session id
        expect(turn.role).toBe('user')
        expect(turn.text).toBe('hello')
        expect(turn.status).toBe('ok')
        expect(turn.createdAt).toBe('2024-01-01T00:00:01.000Z')
    })

    it('preserves an explicit error status (Req 2.3)', () => {
        const mgr = makeManager()
        const turn = mgr.appendTurn({ role: 'assistant', text: 'oops', status: 'error' })
        expect(turn.status).toBe('error')
    })

    it('keeps turns in strict chronological insertion order (Req 3.2)', () => {
        const mgr = makeManager()
        mgr.appendUserText('one')
        mgr.appendAssistantText('two')
        mgr.appendUserText('three')
        const texts = mgr.getSessionView().turns.map((t) => t.text)
        expect(texts).toEqual(['one', 'two', 'three'])
    })

    it('only grows the record and never reorders earlier turns (Property 6)', () => {
        const mgr = makeManager()
        const ids: string[] = []
        for (let i = 0; i < 20; i++) {
            ids.push(mgr.appendUserText(`msg-${i}`).id)
        }
        const recorded = mgr.getSessionView().turns.map((t) => t.id)
        expect(recorded).toEqual(ids)
    })

    it('advances updatedAt to the appended turn time', () => {
        const mgr = makeManager()
        const turn = mgr.appendUserText('hi')
        expect(mgr.getSession().updatedAt).toBe(turn.createdAt)
    })

    it('returns a clone so mutating the result does not affect stored state', () => {
        const mgr = makeManager()
        const turn = mgr.appendUserText('original')
        turn.text = 'mutated'
        expect(mgr.getSessionView().turns[0].text).toBe('original')
    })

    it('appends a capture turn via appendUserCapture', () => {
        const mgr = makeManager()
        const cap = capture('data:img')
        const turn = mgr.appendUserCapture(cap, 'look here')
        expect(turn.role).toBe('user')
        expect(turn.text).toBe('look here')
        expect(turn.capture).toEqual(cap)
    })

    it('supports a text-less capture turn (Req 3.3)', () => {
        const mgr = makeManager()
        const turn = mgr.appendUserCapture(capture('data:img'))
        expect(turn.text).toBeUndefined()
        expect(turn.capture?.dataUrl).toBe('data:img')
    })
})

// --- buildContext (Req 3.1, Properties 1 & 2) -------------------------------

describe('SessionManager.buildContext', () => {
    it('always includes summary and recentTurns, even when empty (Property 1)', () => {
        const mgr = makeManager()
        const ctx = mgr.buildContext()
        expect(ctx.summary).toEqual(createEmptySummary())
        expect(ctx.recentTurns).toEqual([])
        expect(ctx.currentCapture).toBeUndefined()
    })

    it('includes all turns verbatim while under KEEP_RECENT', () => {
        const mgr = makeManager()
        mgr.appendUserText('a')
        mgr.appendAssistantText('b')
        const ctx = mgr.buildContext()
        expect(ctx.recentTurns.map((t) => t.text)).toEqual(['a', 'b'])
    })

    it('caps recentTurns at KEEP_RECENT and keeps the most recent (Property 2)', () => {
        const mgr = makeManager() // default keepRecent = KEEP_RECENT (4)
        for (let i = 0; i < 10; i++) mgr.appendUserText(`m${i}`)
        const ctx = mgr.buildContext()
        expect(ctx.recentTurns).toHaveLength(KEEP_RECENT)
        expect(ctx.recentTurns.map((t) => t.text)).toEqual(['m6', 'm7', 'm8', 'm9'])
    })

    it('honors a custom keepRecent value', () => {
        const mgr = makeManager({ keepRecent: 2 })
        for (let i = 0; i < 5; i++) mgr.appendUserText(`m${i}`)
        const ctx = mgr.buildContext()
        expect(ctx.recentTurns.map((t) => t.text)).toEqual(['m3', 'm4'])
    })

    it('returns no recent turns when keepRecent is 0', () => {
        const mgr = makeManager({ keepRecent: 0 })
        mgr.appendUserText('a')
        expect(mgr.buildContext().recentTurns).toEqual([])
    })

    it('attaches the provided currentCapture (Req 3.1)', () => {
        const mgr = makeManager()
        const cap = capture('data:current')
        const ctx = mgr.buildContext(cap)
        expect(ctx.currentCapture).toEqual(cap)
    })

    it('clones recent turns so mutating the context does not affect state', () => {
        const mgr = makeManager()
        mgr.appendUserText('keep')
        const ctx = mgr.buildContext()
        ctx.recentTurns[0].text = 'changed'
        ctx.summary.inferredIntent = 'changed'
        expect(mgr.getSessionView().turns[0].text).toBe('keep')
        expect(mgr.getSession().summary.inferredIntent).toBe('')
    })
})

// --- newSession (Req 9.1) ---------------------------------------------------

describe('SessionManager.newSession', () => {
    it('clears turns and summary and assigns a fresh id', () => {
        const mgr = makeManager()
        mgr.appendUserText('old message')
        const oldId = mgr.getSession().id
        const fresh = mgr.newSession()
        expect(fresh.id).not.toBe(oldId)
        expect(mgr.getSessionView().turns).toEqual([])
        expect(mgr.getSessionView().summary).toEqual(createEmptySummary())
    })

    it('lets the caller archive the prior session before clearing (task 10 seam)', () => {
        const mgr = makeManager()
        mgr.appendUserText('to archive')
        const archived = mgr.getSession()
        expect(archived.turns).toHaveLength(1)
        mgr.newSession()
        // The archived reference is detached from the manager's new session.
        expect(mgr.getSession()).not.toBe(archived)
    })
})

// --- restore (Req 9.3) ------------------------------------------------------

describe('SessionManager.restore', () => {
    it('adopts a loaded session as the active session', () => {
        const mgr = makeManager()
        const loaded: Session = {
            id: 'restored',
            turns: [
                {
                    id: 't1',
                    role: 'user',
                    text: 'restored message',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    status: 'ok'
                }
            ],
            summary: {
                inferredIntent: 'grant access',
                completedSteps: ['opened IAM'],
                updatedThroughTurnId: 't1'
            },
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z'
        }
        mgr.restore(loaded)
        const view = mgr.getSessionView()
        expect(view.id).toBe('restored')
        expect(view.turns[0].text).toBe('restored message')
        expect(view.summary.inferredIntent).toBe('grant access')
    })

    it('continues appending onto a restored session in order', () => {
        const mgr = makeManager()
        mgr.restore({
            id: 'restored',
            turns: [
                {
                    id: 't1',
                    role: 'user',
                    text: 'first',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    status: 'ok'
                }
            ],
            summary: createEmptySummary(),
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z'
        })
        mgr.appendUserText('second')
        expect(mgr.getSessionView().turns.map((t) => t.text)).toEqual(['first', 'second'])
    })
})

// --- Hooks (persistence/summarization seams) --------------------------------

describe('SessionManager hooks', () => {
    it('invokes onTurnAppended then onSessionChanged on append', () => {
        const order: string[] = []
        let appendedTurnId: string | undefined
        const onTurnAppended = vi.fn((turn: Turn) => {
            appendedTurnId = turn.id
            order.push('turn')
        })
        const onSessionChanged = vi.fn(() => {
            order.push('session')
        })
        const mgr = new SessionManager({
            generateId: sequentialIds(),
            now: steppingClock(),
            hooks: { onTurnAppended, onSessionChanged }
        })
        const turn = mgr.appendUserText('hi')
        expect(onTurnAppended).toHaveBeenCalledTimes(1)
        expect(appendedTurnId).toBe(turn.id)
        expect(onSessionChanged).toHaveBeenCalledTimes(1)
        expect(order).toEqual(['turn', 'session'])
    })

    it('invokes onSessionChanged on newSession and restore', () => {
        const onSessionChanged = vi.fn()
        const mgr = new SessionManager({
            generateId: sequentialIds(),
            now: steppingClock(),
            hooks: { onSessionChanged }
        })
        mgr.newSession()
        expect(onSessionChanged).toHaveBeenCalledTimes(1)
        mgr.restore({
            id: 'r',
            turns: [],
            summary: createEmptySummary(),
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z'
        })
        expect(onSessionChanged).toHaveBeenCalledTimes(2)
    })
})

// --- id uniqueness with the default generator -------------------------------

describe('default id generator', () => {
    it('mints unique ids for turns appended in a tight loop', () => {
        const mgr = new SessionManager({ now: steppingClock() })
        const ids = new Set<string>()
        for (let i = 0; i < 1000; i++) {
            ids.add(mgr.appendUserText(`m${i}`).id)
        }
        expect(ids.size).toBe(1000)
    })
})
