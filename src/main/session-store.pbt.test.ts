import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SessionSummary, Turn, TurnCapture } from '@shared/types'

// Electron is unavailable in the Vitest (node) environment. The store only
// reads `app.getPath('userData')` as a default; every property run injects its
// own temp dir, so this mock just satisfies the import-time dependency.
vi.mock('electron', () => ({
    app: { getPath: () => tmpdir() }
}))

import { SessionStore, jsonSessionCodec } from './session-store'
import { SessionManager, type IdGenerator } from './session'

/**
 * Property-based tests for the persistence round-trip (task 10.3).
 *
 * Validates the design's "Persistence & Restore" guarantees directly against
 * {@link SessionStore} (and the real archive→clear lifecycle through
 * {@link SessionManager}):
 *
 *  - Persist → restore round-trip (Req 9.2, 9.3): for an arbitrary Session,
 *    `save(session)` then `load()` reproduces the turns in IDENTICAL order and
 *    content (deep equal) and an equal summary.
 *  - New-session archive-then-clear (Req 9.1): for an arbitrary non-empty
 *    session, `archive(session)` then starting fresh preserves the archived
 *    copy with no data loss, while `current.json` reflects the cleared/empty
 *    session.
 *
 * Each property run uses its own unique temp directory so concurrent shrinking
 * runs can never see each other's files; the directory is always removed.
 */

const SESSIONS_DIR = 'sessions'
const CURRENT = 'current.json'

// --- Strategies -------------------------------------------------------------

const rectArb: fc.Arbitrary<TurnCapture['rect']> = fc.record({
    x: fc.integer({ min: -10_000, max: 10_000 }),
    y: fc.integer({ min: -10_000, max: 10_000 }),
    width: fc.integer({ min: 0, max: 10_000 }),
    height: fc.integer({ min: 0, max: 10_000 })
})

const captureArb: fc.Arbitrary<TurnCapture> = fc.record({
    dataUrl: fc.string(),
    thumbnailUrl: fc.string(),
    rect: rectArb
})

/**
 * An arbitrary {@link Turn} with mixed roles, optional text, optional capture,
 * and ok/error status. Optional fields are only present when defined so the
 * generated object matches exactly what survives a JSON round-trip (the manager
 * likewise only sets `text`/`capture` when provided).
 */
const turnArb: fc.Arbitrary<Turn> = fc
    .record({
        id: fc.string(),
        role: fc.constantFrom('user' as const, 'assistant' as const),
        createdAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
        status: fc.constantFrom('ok' as const, 'error' as const),
        text: fc.option(fc.string(), { nil: undefined }),
        capture: fc.option(captureArb, { nil: undefined })
    })
    .map(({ id, role, createdAt, status, text, capture }) => {
        const turn: Turn = { id, role, createdAt, status }
        if (text !== undefined) turn.text = text
        if (capture !== undefined) turn.capture = capture
        return turn
    })

const summaryArb: fc.Arbitrary<SessionSummary> = fc.record({
    inferredIntent: fc.string(),
    completedSteps: fc.array(fc.string()),
    updatedThroughTurnId: fc.option(fc.string(), { nil: null })
})

/** An arbitrary, fully-formed {@link Session} (turns may be empty). */
const sessionArb: fc.Arbitrary<Session> = fc.record({
    id: fc.string(),
    turns: fc.array(turnArb, { maxLength: 30 }),
    summary: summaryArb,
    createdAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    updatedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString())
})

// --- Manager-driven append ops (for the archive lifecycle) ------------------

type AppendOp =
    | { kind: 'user'; text: string }
    | { kind: 'assistant'; text: string; status: 'ok' | 'error' }
    | { kind: 'capture'; text?: string }

const appendOpArb: fc.Arbitrary<AppendOp> = fc.oneof(
    fc.record({ kind: fc.constant('user' as const), text: fc.string() }),
    fc.record({
        kind: fc.constant('assistant' as const),
        text: fc.string(),
        status: fc.constantFrom('ok' as const, 'error' as const)
    }),
    fc.record({
        kind: fc.constant('capture' as const),
        text: fc.option(fc.string(), { nil: undefined })
    })
)

/** Deterministic, filesystem-safe id generator (ids become archive filenames). */
function sequentialIds(): IdGenerator {
    let n = 0
    return () => `id-${n++}`
}

/** Deterministic clock advancing one ms per call, ISO formatted. */
function steppingClock(): () => string {
    let ms = Date.UTC(2024, 0, 1, 0, 0, 0)
    return () => {
        const iso = new Date(ms).toISOString()
        ms += 1
        return iso
    }
}

function applyOp(mgr: SessionManager, op: AppendOp, index: number): void {
    switch (op.kind) {
        case 'user':
            mgr.appendUserText(op.text)
            break
        case 'assistant':
            mgr.appendAssistantText(op.text, op.status)
            break
        case 'capture':
            mgr.appendUserCapture(
                {
                    dataUrl: `data:cap-${index}`,
                    thumbnailUrl: `data:cap-${index}#thumb`,
                    rect: { x: 0, y: 0, width: 10, height: 10 }
                },
                op.text
            )
            break
    }
}

/** Run `body` against a freshly-created, unique temp dir; always clean up. */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'glass-session-pbt-'))
    try {
        return await body(dir)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}

// --- Property: persist -> restore round-trip (Req 9.2, 9.3) -----------------

describe('Persistence round-trip (Req 9.2, 9.3)', () => {
    it('save(session) then load() reproduces turns in identical order/content and an equal summary', async () => {
        await fc.assert(
            fc.asyncProperty(sessionArb, async (session) => {
                await withTempDir(async (dir) => {
                    const store = new SessionStore({ userDataDir: dir })

                    await store.save(session)
                    await store.flush()
                    const loaded = await store.load()

                    // The whole session round-trips by deep equality.
                    expect(loaded).toEqual(session)

                    // And, explicitly: turns are reproduced in IDENTICAL order
                    // and content, and the summary is equal.
                    expect(loaded).not.toBeNull()
                    expect(loaded!.turns).toEqual(session.turns)
                    expect(loaded!.turns.map((t) => t.id)).toEqual(
                        session.turns.map((t) => t.id)
                    )
                    expect(loaded!.summary).toEqual(session.summary)
                })
            })
        )
    })
})

// --- Property: new-session archive-then-clear (Req 9.1) ---------------------

describe('New-session archive-then-clear (Req 9.1)', () => {
    it('archives the prior session with no data loss while current.json reflects the cleared session', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(appendOpArb, { minLength: 1, maxLength: 30 }),
                summaryArb,
                async (ops, summary) => {
                    await withTempDir(async (dir) => {
                        const store = new SessionStore({ userDataDir: dir })
                        const mgr = new SessionManager({
                            generateId: sequentialIds(),
                            now: steppingClock()
                        })

                        // Build an arbitrary non-empty session via real appends,
                        // then set a running summary (exercises summary persistence).
                        ops.forEach((op, i) => applyOp(mgr, op, i))
                        mgr.setSummary(summary)

                        // Snapshot the live session before it is replaced.
                        const original: Session = structuredClone(mgr.getSession())
                        expect(original.turns.length).toBe(ops.length)

                        // Archive the prior session, then start fresh and persist it.
                        await store.archive(original)
                        const fresh = mgr.newSession()
                        await store.save(fresh)
                        await store.flush()

                        // The archived copy reproduces the original with no data loss.
                        const archivedRaw = await fs.readFile(
                            join(dir, SESSIONS_DIR, `${original.id}.json`),
                            'utf-8'
                        )
                        const archived = jsonSessionCodec.decode(archivedRaw)
                        expect(archived).toEqual(original)
                        expect(archived.turns).toEqual(original.turns)
                        expect(archived.summary).toEqual(original.summary)

                        // current.json now reflects the cleared/empty session.
                        const current = await store.load()
                        expect(current).toEqual(fresh)
                        expect(current!.turns).toEqual([])
                        expect(current!.summary).toEqual({
                            inferredIntent: '',
                            completedSteps: [],
                            updatedThroughTurnId: null
                        })
                        // The cleared session is a genuinely new one, not the archived id.
                        expect(current!.id).not.toBe(original.id)

                        // The archive on disk is untouched by the fresh save.
                        const archivedAfter = jsonSessionCodec.decode(
                            await fs.readFile(
                                join(dir, SESSIONS_DIR, `${original.id}.json`),
                                'utf-8'
                            )
                        )
                        expect(archivedAfter).toEqual(original)
                        // current.json and the archive are distinct files.
                        expect(
                            await fs.readFile(
                                join(dir, SESSIONS_DIR, CURRENT),
                                'utf-8'
                            )
                        ).not.toBe(archivedRaw)
                    })
                }
            )
        )
    })
})
