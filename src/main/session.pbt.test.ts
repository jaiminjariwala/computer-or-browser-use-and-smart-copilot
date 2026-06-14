import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { TurnCapture } from '@shared/types'
import { KEEP_RECENT, SessionManager, type IdGenerator } from './session'

/**
 * Property-based tests for the Session Manager invariants (task 5.3).
 *
 * These validate two of the design's Correctness Properties directly against
 * the {@link SessionManager}:
 *
 *  - Property 6 (Session integrity): turns are always kept in strict
 *    chronological insertion order and are never reordered or dropped, even
 *    when turns carry an `error` status (Req 2.3, 3.2). The interaction with
 *    real gateway failure paths is covered in `chat-flow.pbt.test.ts`.
 *  - Property 1 (Context completeness): a built `SessionContext` always carries
 *    the summary and the recent turns (bounded by KEEP_RECENT), and a capture
 *    is never sent without that context (Req 3.1, 3.3).
 *
 * The strategies build arbitrary session states by replaying random sequences
 * of append operations, which mirrors how the manager is driven in production.
 */

// --- Strategies -------------------------------------------------------------

const rect = { x: 0, y: 0, width: 10, height: 10 }

function captureFrom(seed: string): TurnCapture {
    return { dataUrl: `data:${seed}`, thumbnailUrl: `data:${seed}#thumb`, rect }
}

/** A single append operation against the manager. */
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

/** Deterministic, monotonic id generator so we can assert exact ordering. */
function sequentialIds(): IdGenerator {
    let n = 0
    return () => `id-${n++}`
}

/** Deterministic clock that advances one ms per call, ISO formatted. */
function steppingClock(): () => string {
    let ms = Date.UTC(2024, 0, 1, 0, 0, 0)
    return () => {
        const iso = new Date(ms).toISOString()
        ms += 1
        return iso
    }
}

/** Apply an op to the manager and return the id of the turn it created. */
function applyOp(mgr: SessionManager, op: AppendOp, index: number): string {
    switch (op.kind) {
        case 'user':
            return mgr.appendUserText(op.text).id
        case 'assistant':
            return mgr.appendAssistantText(op.text, op.status).id
        case 'capture':
            return mgr.appendUserCapture(captureFrom(`cap-${index}`), op.text).id
    }
}

// --- Property 6: Session integrity / strict chronological ordering ----------

describe('Property 6: Session integrity (Req 2.3, 3.2)', () => {
    it('keeps turns in strict chronological insertion order, never dropped or reordered', () => {
        fc.assert(
            fc.property(fc.array(appendOpArb, { maxLength: 60 }), (ops) => {
                const mgr = new SessionManager({
                    generateId: sequentialIds(),
                    now: steppingClock()
                })

                const expectedIds = ops.map((op, i) => applyOp(mgr, op, i))

                const recordedIds = mgr.getSessionView().turns.map((t) => t.id)

                // No turn is ever dropped: one recorded turn per append.
                expect(recordedIds).toHaveLength(ops.length)
                // Strict insertion order is preserved (ids minted sequentially,
                // so this also proves nothing was reordered).
                expect(recordedIds).toEqual(expectedIds)

                // createdAt timestamps are non-decreasing across the record.
                const times = mgr
                    .getSessionView()
                    .turns.map((t) => Date.parse(t.createdAt))
                const sorted = [...times].sort((a, b) => a - b)
                expect(times).toEqual(sorted)
            })
        )
    })

    it('never loses appended user turns regardless of error-status turns interleaved', () => {
        fc.assert(
            fc.property(fc.array(appendOpArb, { maxLength: 60 }), (ops) => {
                const mgr = new SessionManager({
                    generateId: sequentialIds(),
                    now: steppingClock()
                })

                ops.forEach((op, i) => applyOp(mgr, op, i))

                const expectedUserCount = ops.filter(
                    (op) => op.kind === 'user' || op.kind === 'capture'
                ).length
                const recordedUserCount = mgr
                    .getSessionView()
                    .turns.filter((t) => t.role === 'user').length

                expect(recordedUserCount).toBe(expectedUserCount)
            })
        )
    })
})

// --- Property 1: Context completeness ---------------------------------------

describe('Property 1: Context completeness (Req 3.1, 3.3)', () => {
    it('always includes the summary and recent turns bounded by KEEP_RECENT', () => {
        fc.assert(
            fc.property(
                fc.array(appendOpArb, { maxLength: 60 }),
                fc.integer({ min: 0, max: 8 }),
                (ops, keepRecent) => {
                    const mgr = new SessionManager({
                        generateId: sequentialIds(),
                        now: steppingClock(),
                        keepRecent
                    })
                    ops.forEach((op, i) => applyOp(mgr, op, i))

                    const ctx = mgr.buildContext()
                    const allTurns = mgr.getSessionView().turns

                    // Summary is always present.
                    expect(ctx.summary).toBeDefined()
                    expect(Array.isArray(ctx.summary.completedSteps)).toBe(true)

                    // recentTurns is always present and never exceeds keepRecent.
                    expect(Array.isArray(ctx.recentTurns)).toBe(true)
                    expect(ctx.recentTurns.length).toBeLessThanOrEqual(keepRecent)

                    // recentTurns is exactly the most-recent tail, in order.
                    const expectedTail =
                        keepRecent > 0 ? allTurns.slice(-keepRecent) : []
                    expect(ctx.recentTurns.map((t) => t.id)).toEqual(
                        expectedTail.map((t) => t.id)
                    )
                }
            )
        )
    })

    it('never sends a capture without session context (summary + recent turns present)', () => {
        fc.assert(
            fc.property(
                fc.array(appendOpArb, { maxLength: 40 }),
                fc.string(),
                (ops, capSeed) => {
                    const mgr = new SessionManager({
                        generateId: sequentialIds(),
                        now: steppingClock()
                    })
                    ops.forEach((op, i) => applyOp(mgr, op, i))

                    const currentCapture = captureFrom(`current-${capSeed}`)
                    const ctx = mgr.buildContext(currentCapture)

                    // The capture is carried...
                    expect(ctx.currentCapture).toEqual(currentCapture)
                    // ...but never alone: summary and recentTurns accompany it.
                    expect(ctx.summary).toBeDefined()
                    expect(Array.isArray(ctx.recentTurns)).toBe(true)
                    expect(ctx.recentTurns.length).toBeLessThanOrEqual(KEEP_RECENT)
                }
            )
        )
    })
})
