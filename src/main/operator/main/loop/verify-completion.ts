/**
 * Evidence gate for `task_complete` claims (premature-"done" guard).
 *
 * Small models routinely declare victory without verifying the goal state
 * (e.g. claiming a video plays while the page still shows an empty search).
 * The loop therefore requires the model to QUOTE something from the
 * observation it just reasoned over — visible page text, the page title, or
 * the URL — and only accepts the completion when that quote actually appears
 * in the observation's text surface.
 *
 * The check is deliberately forgiving about formatting (case- and
 * whitespace-insensitive) and FAILS OPEN when the observation exposes no
 * meaningful text surface (screenshot-only desktop environments), where a
 * text quote cannot be validated at all.
 */

/** Verdict for a `task_complete` claim checked against the live observation. */
export interface CompletionVerdict {
    verified: boolean
    /** Why the claim was rejected (present when `verified` is false). */
    reason?: string
}

/**
 * Observations whose normalized text surface is shorter than this cannot be
 * meaningfully checked (desktop screenshot-only captures have no page text),
 * so the gate fails open rather than rejecting every completion.
 */
const MIN_CHECKABLE_SURFACE = 40

/** Cap the quote used for matching so a pathological emission stays cheap. */
const MAX_EVIDENCE_CHARS = 300

/** Lowercase and collapse all whitespace so formatting differences don't reject. */
function normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Check a completion claim's `evidence` quote against the observation the
 * model reasoned over. Returns `verified: true` when the quote appears in the
 * observation's text surface (or when no checkable surface exists).
 */
export function verifyCompletionEvidence(
    evidence: string | undefined,
    observation: { pageText?: string } | undefined
): CompletionVerdict {
    const surface = normalize(observation?.pageText ?? '')
    if (surface.length < MIN_CHECKABLE_SURFACE) return { verified: true }

    const quote = normalize((evidence ?? '').slice(0, MAX_EVIDENCE_CHARS))
    if (quote.length === 0) {
        return {
            verified: false,
            reason: 'no evidence was quoted from the current observation'
        }
    }
    if (!surface.includes(quote)) {
        return {
            verified: false,
            reason: `the quoted evidence ("${quote.slice(0, 80)}") does not appear in the current observation`
        }
    }
    return { verified: true }
}
