import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { SessionSummary, Turn, TurnCapture } from '@shared/types'
import { SessionManager, type IdGenerator } from './session'
import { Summarizer, selectTurnsToFold } from './summarizer'
import { mergeSummary } from './ai'
import type { AIClient } from './ai'

/**
 * Property-based tests for the summarization invariants (task 9.2).
 *
 * These validate two of the design's Correctness Properties end-to-end against
 * the real {@link SessionManager} + {@link Summarizer} + {@link mergeSummary}:
 *
 *  - Property 2 (bounded context / no full-history replay): across an arbitrary
 *    number of appended turns, no summarization happens at or below the
 *    threshold, folding kicks in above it, and a freshly built
 *    `SessionContext` never carries more than `KEEP_RECENT` verbatim turns —
 *    the full turn-by-turn history is never replayed (Req 6.2, 6.3).
 *  - Property 3 (summary monotonicity): the merged summary always retains the
 *    prior inferred intent when the model adds nothing, and completed steps are
 *    always a superset of the prior steps — steps are never dropped, even when
 *    the model omits or returns partial/garbage fields (Req 6.4).
 *
 * The Summarizer is driven through a real SessionManager (which is the
 * `SummaryStore` via `setSummary`) with a fake `AIClient.summarize`, mirroring
 * how it runs in production.
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

/** Apply an op to the manager (return value ignored — we only need state). */
function applyOp(mgr: SessionManager, op: AppendOp, index: number): void {
    switch (op.kind) {
        case 'user':
            mgr.appendUserText(op.text)
            return
        case 'assistant':
            mgr.appendAssistantText(op.text, op.status)
            return
        case 'capture':
            mgr.appendUserCapture(captureFrom(`cap-${index}`), op.text)
            return
    }
}

/**
 * A fake `AIClient` whose `summarize` records each call and folds the given
 * turns into the prior summary using the *real* {@link mergeSummary}, with a
 * synthetic "model output" that adds one step per fold. `complete` is unused
 * here. Resolves synchronously (microtask) so the test can `await` it.
 */
function makeFakeClient() {
    let calls = 0
    const foldedBatches: Turn[][] = []
    const client: AIClient = {
        complete: async () => '',
        summarize: async (turns: Turn[], prev: SessionSummary) => {
            calls += 1
            foldedBatches.push(turns)
            // Realistic merge: model proposes one new step; mergeSummary keeps
            // intent + unions steps (monotonic).
            return mergeSummary(
                prev,
                { completedSteps: [`folded-batch-${calls}`] },
                turns
            )
        }
    }
    return {
        client,
        get calls() {
            return calls
        },
        foldedBatches
    }
}

/**
 * Drive the manager + summarizer incrementally: append each op, then run the
 * summarization trigger against the current session (awaited, mirroring the
 * production `onTurnAppended` hook but without the fire-and-forget timing).
 */
async function driveIncrementally(
    ops: AppendOp[],
    summarizer: Summarizer,
    mgr: SessionManager
): Promise<void> {
    for (let i = 0; i < ops.length; i++) {
        applyOp(mgr, ops[i], i)
        await summarizer.maybeSummarize(mgr.getSession())
    }
}

// --- Property 2: bounded context / no full-history replay -------------------

describe('Property 2: bounded context (Req 6.2, 6.3)', () => {
    it('does not summarize when the unfolded backlog stays at or below the threshold', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 8 }), // threshold
                fc.integer({ min: 1, max: 6 }), // keepRecent
                fc.array(appendOpArb, { maxLength: 40 }),
                async (threshold, keepRecent, allOps) => {
                    // Cap the op count to the threshold so the backlog never
                    // exceeds it: summarization must never fire.
                    const ops = allOps.slice(0, threshold)

                    const mgr = new SessionManager({
                        generateId: sequentialIds(),
                        now: steppingClock(),
                        keepRecent
                    })
                    const fake = makeFakeClient()
                    const summarizer = new Summarizer({
                        client: fake.client,
                        store: mgr,
                        threshold,
                        keepRecent
                    })

                    await driveIncrementally(ops, summarizer, mgr)

                    // selectTurnsToFold is a no-op at/below threshold...
                    expect(selectTurnsToFold(mgr.getSession(), threshold, keepRecent)).toBeNull()
                    // ...and the gateway summarize was never invoked.
                    expect(fake.calls).toBe(0)
                    // The summary watermark never advanced.
                    expect(mgr.getSession().summary.updatedThroughTurnId).toBeNull()
                }
            )
        )
    })

    it('folds older turns once the backlog grows above the threshold and advances the watermark', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 6 }), // keepRecent
                fc.integer({ min: 0, max: 8 }), // threshold delta (threshold = keepRecent + delta)
                fc.integer({ min: 1, max: 30 }), // extra turns beyond threshold
                fc.array(appendOpArb, { minLength: 60, maxLength: 60 }),
                async (keepRecent, delta, extra, opsPool) => {
                    const threshold = keepRecent + delta
                    // Guarantee the backlog exceeds the threshold.
                    const count = Math.min(threshold + extra, opsPool.length)
                    const ops = opsPool.slice(0, count)

                    const mgr = new SessionManager({
                        generateId: sequentialIds(),
                        now: steppingClock(),
                        keepRecent
                    })
                    const fake = makeFakeClient()
                    const summarizer = new Summarizer({
                        client: fake.client,
                        store: mgr,
                        threshold,
                        keepRecent
                    })

                    await driveIncrementally(ops, summarizer, mgr)

                    // Folding occurred at least once.
                    expect(fake.calls).toBeGreaterThan(0)
                    // The watermark advanced to a real, folded turn id.
                    const session = mgr.getSession()
                    expect(session.summary.updatedThroughTurnId).not.toBeNull()
                    const watermarkIndex = session.turns.findIndex(
                        (t) => t.id === session.summary.updatedThroughTurnId
                    )
                    expect(watermarkIndex).toBeGreaterThanOrEqual(0)
                }
            )
        )
    })

    it('a built SessionContext never carries more than KEEP_RECENT verbatim turns, regardless of session length', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 6 }), // keepRecent
                fc.integer({ min: 0, max: 8 }), // threshold delta
                fc.array(appendOpArb, { maxLength: 60 }),
                async (keepRecent, delta, ops) => {
                    const threshold = keepRecent + delta
                    const mgr = new SessionManager({
                        generateId: sequentialIds(),
                        now: steppingClock(),
                        keepRecent
                    })
                    const fake = makeFakeClient()
                    const summarizer = new Summarizer({
                        client: fake.client,
                        store: mgr,
                        threshold,
                        keepRecent
                    })

                    await driveIncrementally(ops, summarizer, mgr)

                    const ctx = mgr.buildContext()
                    const allTurns = mgr.getSession().turns

                    // Bounded: never replays the full turn-by-turn history.
                    expect(ctx.recentTurns.length).toBeLessThanOrEqual(keepRecent)
                    if (allTurns.length > keepRecent) {
                        expect(ctx.recentTurns.length).toBeLessThan(allTurns.length)
                    }
                    // The summary is always carried alongside the recent turns.
                    expect(ctx.summary).toBeDefined()
                    // recentTurns is exactly the most-recent tail.
                    const expectedTail = allTurns.slice(-keepRecent)
                    expect(ctx.recentTurns.map((t) => t.id)).toEqual(
                        expectedTail.map((t) => t.id)
                    )
                }
            )
        )
    })
})

// --- Property 3: summary monotonicity ---------------------------------------

/** Arbitrary prior summary (intent + completed steps). */
const prevSummaryArb: fc.Arbitrary<SessionSummary> = fc.record({
    inferredIntent: fc.string(),
    completedSteps: fc.array(fc.string(), { maxLength: 12 }),
    updatedThroughTurnId: fc.option(fc.string(), { nil: null })
})

/** Arbitrary folded turns. */
const turnArb: fc.Arbitrary<Turn> = fc.record({
    id: fc.string({ minLength: 1 }),
    role: fc.constantFrom('user' as const, 'assistant' as const),
    text: fc.option(fc.string(), { nil: undefined }),
    createdAt: fc.constant(new Date(Date.UTC(2024, 0, 1)).toISOString()),
    status: fc.constantFrom('ok' as const, 'error' as const)
})

/**
 * Arbitrary "model output" parsed from a summarize response, including ones
 * that omit fields entirely, return wrong types, or supply partial data.
 */
const parsedArb = fc.record(
    {
        inferredIntent: fc.oneof(
            fc.string(),
            fc.constant(''),
            fc.constant('   '),
            fc.integer(),
            fc.constant(null),
            fc.constant(undefined)
        ),
        completedSteps: fc.oneof(
            fc.array(fc.string(), { maxLength: 8 }),
            fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 8 }),
            fc.string(),
            fc.integer(),
            fc.constant(null),
            fc.constant(undefined)
        )
    },
    { requiredKeys: [] }
)

/** True when the parsed model output supplies a usable, non-empty intent. */
function modelSuppliedIntent(parsed: { inferredIntent?: unknown }): boolean {
    return (
        typeof parsed.inferredIntent === 'string' &&
        parsed.inferredIntent.trim().length > 0
    )
}

describe('Property 3: summary monotonicity (Req 6.4)', () => {
    it('completed steps are always a superset of the prior steps — steps are never dropped', () => {
        fc.assert(
            fc.property(
                prevSummaryArb,
                parsedArb,
                fc.array(turnArb, { maxLength: 10 }),
                (prev, parsed, turns) => {
                    const merged = mergeSummary(prev, parsed, turns)

                    // Every prior step survives.
                    for (const step of prev.completedSteps) {
                        expect(merged.completedSteps).toContain(step)
                    }
                    // Count never shrinks (union only grows).
                    expect(merged.completedSteps.length).toBeGreaterThanOrEqual(
                        prev.completedSteps.length
                    )
                }
            )
        )
    })

    it('retains the prior inferred intent when the model adds nothing usable', () => {
        fc.assert(
            fc.property(
                prevSummaryArb,
                parsedArb,
                fc.array(turnArb, { maxLength: 10 }),
                (prev, parsed, turns) => {
                    const merged = mergeSummary(prev, parsed, turns)

                    if (!modelSuppliedIntent(parsed)) {
                        // Intent must be carried over verbatim.
                        expect(merged.inferredIntent).toBe(prev.inferredIntent)
                    } else {
                        // When the model does supply intent, it is adopted (trimmed).
                        expect(merged.inferredIntent).toBe(
                            (parsed.inferredIntent as string).trim()
                        )
                    }
                }
            )
        )
    })

    it('repeated folds keep accumulating steps monotonically (never regress across summarize calls)', () => {
        fc.assert(
            fc.property(
                prevSummaryArb,
                fc.array(parsedArb, { minLength: 1, maxLength: 6 }),
                fc.array(turnArb, { minLength: 1, maxLength: 6 }),
                (start, parsedSeq, turns) => {
                    let current = start
                    let prevLen = current.completedSteps.length
                    let prevSteps = [...current.completedSteps]

                    for (const parsed of parsedSeq) {
                        current = mergeSummary(current, parsed, turns)
                        // Monotonic growth in count.
                        expect(current.completedSteps.length).toBeGreaterThanOrEqual(
                            prevLen
                        )
                        // Every previously-known step still present.
                        for (const step of prevSteps) {
                            expect(current.completedSteps).toContain(step)
                        }
                        prevLen = current.completedSteps.length
                        prevSteps = [...current.completedSteps]
                    }
                }
            )
        )
    })
})
