import { describe, it, expect, vi } from 'vitest'
import type { Session, SessionSummary, Turn } from '@shared/types'
import { createEmptySummary } from './session'
import type { AIClient } from './ai'
import {
    KEEP_RECENT,
    SUMMARIZE_THRESHOLD,
    Summarizer,
    selectTurnsToFold,
    type SummaryStore
} from './summarizer'

// --- Helpers ----------------------------------------------------------------

/** Build a plain text turn with a deterministic id. */
function turn(n: number, role: 'user' | 'assistant' = 'user'): Turn {
    return { id: `id-${n}`, role, text: `turn ${n}`, createdAt: '2024-01-01T00:00:00.000Z', status: 'ok' }
}

/** Build a session of `count` turns (id-0 .. id-(count-1)) with a given summary. */
function sessionOf(count: number, summary: SessionSummary = createEmptySummary()): Session {
    const turns = Array.from({ length: count }, (_, i) => turn(i))
    return {
        id: 'session-1',
        turns,
        summary,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
    }
}

/** A capturing summary store standing in for the SessionManager. */
function fakeStore(): SummaryStore & { last: SessionSummary | null; calls: number } {
    const store = {
        last: null as SessionSummary | null,
        calls: 0,
        setSummary(summary: SessionSummary) {
            store.last = summary
            store.calls += 1
        }
    }
    return store
}

/**
 * A fake AIClient whose `summarize` records what it was asked to fold and
 * returns a merged summary that preserves intent and unions steps (mirroring
 * the real GatewayAIClient.mergeSummary contract) without any gateway call.
 */
function fakeClient(): AIClient & { foldedTurns: Turn[][]; prevSeen: SessionSummary[] } {
    const foldedTurns: Turn[][] = []
    const prevSeen: SessionSummary[] = []
    return {
        foldedTurns,
        prevSeen,
        complete: async () => 'unused',
        summarize: async (turns: Turn[], prev: SessionSummary): Promise<SessionSummary> => {
            foldedTurns.push(turns)
            prevSeen.push(prev)
            const newStep = `folded ${turns.map((t) => t.id).join(',')}`
            return {
                inferredIntent: prev.inferredIntent || 'inferred goal',
                completedSteps: [...prev.completedSteps, newStep],
                // Intentionally left null to prove the Summarizer pins the watermark.
                updatedThroughTurnId: null
            }
        }
    }
}

// --- selectTurnsToFold (pure trigger logic) ---------------------------------

describe('selectTurnsToFold', () => {
    it('returns null when the unfolded backlog is at or below the threshold', () => {
        // Exactly THRESHOLD unfolded turns => no summarize (Req 6.2).
        const session = sessionOf(SUMMARIZE_THRESHOLD)
        expect(selectTurnsToFold(session)).toBeNull()
    })

    it('folds older turns once the backlog exceeds the threshold', () => {
        // One past the threshold triggers; keep the last KEEP_RECENT verbatim.
        const session = sessionOf(SUMMARIZE_THRESHOLD + 1)
        const older = selectTurnsToFold(session)
        expect(older).not.toBeNull()
        const expectedFoldCount = SUMMARIZE_THRESHOLD + 1 - KEEP_RECENT
        expect(older).toHaveLength(expectedFoldCount)
        // It folds from the start through (end - KEEP_RECENT).
        expect(older?.[0].id).toBe('id-0')
        expect(older?.[older.length - 1].id).toBe(`id-${expectedFoldCount - 1}`)
    })

    it('only considers turns after the existing watermark', () => {
        // 6 already folded (watermark id-5), then enough new turns to exceed
        // the threshold again should fold only the unfolded older ones.
        const total = 6 + SUMMARIZE_THRESHOLD + 1
        const summary: SessionSummary = {
            inferredIntent: 'goal',
            completedSteps: ['did A'],
            updatedThroughTurnId: 'id-5'
        }
        const session = sessionOf(total, summary)
        const older = selectTurnsToFold(session)
        expect(older).not.toBeNull()
        // Starts right after the watermark, never re-folds id-0..id-5.
        expect(older?.[0].id).toBe('id-6')
        const expectedLastId = `id-${total - KEEP_RECENT - 1}`
        expect(older?.[older.length - 1].id).toBe(expectedLastId)
    })

    it('returns null when the backlog is large but all older turns are within KEEP_RECENT', () => {
        // threshold smaller than keepRecent edge: nothing precedes the recent window.
        const session = sessionOf(5)
        expect(selectTurnsToFold(session, 3, 5)).toBeNull()
    })

    it('honors custom threshold and keepRecent', () => {
        const session = sessionOf(6)
        const older = selectTurnsToFold(session, 3, 2)
        expect(older?.map((t) => t.id)).toEqual(['id-0', 'id-1', 'id-2', 'id-3'])
    })
})

// --- Summarizer.maybeSummarize ---------------------------------------------

describe('Summarizer.maybeSummarize', () => {
    it('does nothing below the threshold (Req 6.2)', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })

        await summarizer.maybeSummarize(sessionOf(SUMMARIZE_THRESHOLD))

        expect(client.foldedTurns).toHaveLength(0)
        expect(store.calls).toBe(0)
        expect(store.last).toBeNull()
    })

    it('folds older turns above the threshold and stores the merged summary (Req 6.1, 6.2)', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })

        await summarizer.maybeSummarize(sessionOf(SUMMARIZE_THRESHOLD + 1))

        expect(client.foldedTurns).toHaveLength(1)
        expect(store.calls).toBe(1)
        expect(store.last).not.toBeNull()
        // Only the older turns (not the recent KEEP_RECENT) were folded.
        const folded = client.foldedTurns[0]
        expect(folded).toHaveLength(SUMMARIZE_THRESHOLD + 1 - KEEP_RECENT)
    })

    it('advances updatedThroughTurnId to the last folded turn id (Req 6.4)', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })

        const total = SUMMARIZE_THRESHOLD + 1
        await summarizer.maybeSummarize(sessionOf(total))

        const lastFoldedId = `id-${total - KEEP_RECENT - 1}`
        // Pinned even though the fake client returned null for the watermark.
        expect(store.last?.updatedThroughTurnId).toBe(lastFoldedId)
    })

    it('preserves inferred intent and previously completed steps (Req 6.4, Property 3)', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })

        const prior: SessionSummary = {
            inferredIntent: 'grant DynamoDB + Lambda access',
            completedSteps: ['opened IAM console', 'selected the user'],
            updatedThroughTurnId: null
        }
        await summarizer.maybeSummarize(sessionOf(SUMMARIZE_THRESHOLD + 1, prior))

        // Intent retained.
        expect(store.last?.inferredIntent).toBe('grant DynamoDB + Lambda access')
        // Existing steps are still present (a superset); none dropped.
        expect(store.last?.completedSteps).toEqual(
            expect.arrayContaining(prior.completedSteps)
        )
        expect(store.last?.completedSteps.length).toBeGreaterThanOrEqual(
            prior.completedSteps.length
        )
    })

    it('does not re-fold turns already covered by the watermark', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })

        const summary: SessionSummary = {
            inferredIntent: 'goal',
            completedSteps: ['did A'],
            updatedThroughTurnId: 'id-5'
        }
        const total = 6 + SUMMARIZE_THRESHOLD + 1
        await summarizer.maybeSummarize(sessionOf(total, summary))

        const folded = client.foldedTurns[0]
        expect(folded[0].id).toBe('id-6')
    })
})

// --- onTurnAppended hook integration ----------------------------------------

describe('Summarizer.onTurnAppended', () => {
    it('delegates to maybeSummarize with the appended session', async () => {
        const client = fakeClient()
        const store = fakeStore()
        const summarizer = new Summarizer({ client, store })
        const spy = vi.spyOn(summarizer, 'maybeSummarize')

        const session = sessionOf(SUMMARIZE_THRESHOLD + 1)
        await summarizer.onTurnAppended(session.turns[session.turns.length - 1], session)

        expect(spy).toHaveBeenCalledWith(session)
        expect(store.calls).toBe(1)
    })
})
