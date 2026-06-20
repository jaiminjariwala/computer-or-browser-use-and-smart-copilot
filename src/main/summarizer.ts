import type { Session, SessionSummary, Turn } from '@shared/types'
import { KEEP_RECENT } from './session'
import type { AIClient } from './ai'

/**
 * Summarizer (design: "Summarization trigger (Req 6)").
 *
 * Keeps the running {@link SessionSummary} current so a long session never has
 * to replay its full turn-by-turn history on every gateway request. After each
 * appended turn it inspects how many turns sit *after* the summary watermark
 * (`summary.updatedThroughTurnId`); once that backlog grows past
 * {@link SUMMARIZE_THRESHOLD}, it folds the older turns — everything except the
 * most recent {@link KEEP_RECENT} that has not been folded yet — into the
 * summary via {@link AIClient.summarize}, then advances the watermark to the
 * last folded turn (Req 6.1, 6.2, 6.4).
 *
 * The merge done by {@link AIClient.summarize} preserves the inferred intent and
 * unions completed steps (never dropping any — Correctness Property 3); this
 * module additionally pins `updatedThroughTurnId` to the last folded turn id so
 * the watermark advances deterministically even when a client implementation
 * leaves it untouched.
 *
 * Once the watermark advances, {@link SessionManager.buildContext} naturally
 * yields only `summary + KEEP_RECENT` verbatim turns, so request size stays
 * bounded as the session grows (Req 6.3, Correctness Property 2).
 *
 * Scope: this module owns only the trigger decision and the summary update. It
 * is Electron-free and the gateway call is injected as an {@link AIClient}, so
 * the trigger logic is unit-testable with a fake `summarize`. It performs no
 * disk I/O.
 */

/**
 * Number of unfolded turns (turns after `summary.updatedThroughTurnId`) that may
 * accumulate before older ones are condensed into the summary. The design
 * suggests 8: comfortably larger than {@link KEEP_RECENT} so summarization runs
 * occasionally in batches rather than on nearly every turn.
 */
export const SUMMARIZE_THRESHOLD = 8

export { KEEP_RECENT }

/** The minimal sink the Summarizer writes the updated summary back through. */
export interface SummaryStore {
    /** Replace the active session's running summary. */
    setSummary(summary: SessionSummary): void
}

/**
 * Pure trigger logic: given the current session and the threshold/keep-recent
 * parameters, decide which older turns (if any) should be folded into the
 * summary now.
 *
 * Returns the contiguous slice of not-yet-folded turns that precede the last
 * `keepRecent` turns, or `null` when the unfolded backlog has not exceeded
 * `threshold` (in which case nothing should be summarized — Req 6.2).
 *
 * Deterministic and side-effect free so it can be tested directly.
 */
export function selectTurnsToFold(
    session: Session,
    threshold: number = SUMMARIZE_THRESHOLD,
    keepRecent: number = KEEP_RECENT
): Turn[] | null {
    const { turns, summary } = session

    // Index of the last turn already folded into the summary; -1 when none.
    const foldedIndex =
        summary.updatedThroughTurnId === null
            ? -1
            : turns.findIndex((t) => t.id === summary.updatedThroughTurnId)

    // First unfolded turn is right after the watermark.
    const firstUnfolded = foldedIndex + 1
    const unfoldedCount = turns.length - firstUnfolded

    // Below the threshold: leave the summary untouched (Req 6.2).
    if (unfoldedCount <= threshold) return null

    // Fold everything except the most recent `keepRecent` turns that has not
    // been folded yet. Those recent turns stay verbatim in the context.
    const foldEnd = turns.length - keepRecent
    if (foldEnd <= firstUnfolded) return null

    return turns.slice(firstUnfolded, foldEnd)
}

export interface SummarizerOptions {
    /** Gateway client whose `summarize` folds turns into the summary. */
    client: AIClient
    /** Sink for the updated summary (the {@link SessionManager}). */
    store: SummaryStore
    /** Unfolded-turn backlog that triggers summarization. Defaults to {@link SUMMARIZE_THRESHOLD}. */
    threshold?: number
    /** Recent turns kept verbatim (never folded). Defaults to {@link KEEP_RECENT}. */
    keepRecent?: number
}

/**
 * Drives the summarization trigger. Wire {@link onTurnAppended} to the Session
 * Manager's `onTurnAppended` hook; it runs the trigger after every appended
 * turn and stores the condensed summary when the backlog crosses the threshold.
 */
export class Summarizer {
    private readonly client: AIClient
    private readonly store: SummaryStore
    private readonly threshold: number
    private readonly keepRecent: number

    constructor(options: SummarizerOptions) {
        this.client = options.client
        this.store = options.store
        this.threshold = options.threshold ?? SUMMARIZE_THRESHOLD
        this.keepRecent = options.keepRecent ?? KEEP_RECENT
    }

    /**
     * Session Manager `onTurnAppended` hook. Evaluates the trigger against the
     * session as it stands after the append; the appended turn itself is not
     * needed beyond being part of `session.turns`.
     */
    onTurnAppended = (_turn: Turn, session: Session): Promise<void> => {
        return this.maybeSummarize(session)
    }

    /**
     * Run the trigger once: when the unfolded backlog exceeds the threshold,
     * condense the older turns via the gateway and store the merged summary with
     * the watermark advanced to the last folded turn (Req 6.1, 6.2, 6.4). A
     * no-op below the threshold.
     */
    async maybeSummarize(session: Session): Promise<void> {
        const older = selectTurnsToFold(session, this.threshold, this.keepRecent)
        if (!older || older.length === 0) return

        const prev = session.summary
        const merged = await this.client.summarize(older, prev)

        // Pin the watermark to the last folded turn so it advances even if a
        // client leaves `updatedThroughTurnId` unset (design pseudocode:
        // `summary.updatedThroughTurnId = lastOlderTurnId`).
        const lastFoldedId = older[older.length - 1].id
        this.store.setSummary({ ...merged, updatedThroughTurnId: lastFoldedId })
    }
}
