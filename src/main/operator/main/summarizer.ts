import type {
    Action,
    Observation,
    ReasoningContext,
    TrajectoryStep,
    TrajectorySummary
} from '@op-shared/types'
import { KEEP_RECENT } from './session'

/**
 * Summarizer + bounded-context assembly (Task 12.4).
 *
 * Migrated onto the design's data model from the Click Copilot `summarizer.ts`
 * primitive vendored in Task 2. Reuse rule (Req 19): Click Operator owns and
 * evolves this copy; it imports from `@op-shared/types` and does not reference the
 * `click-copilot` project or any gateway client directly — the fold is an
 * injected {@link SummarizeFn} (the ReasoningRouter's `summarize`).
 *
 * Responsibilities:
 *  - Keep the running {@link TrajectorySummary} current so a long session never
 *    replays its full step-by-step Trajectory on every Reasoning_Step. Older
 *    steps are folded into the summary **only when** the number of steps since
 *    the last summary exceeds the configured threshold (Req 4.2, Property 13).
 *  - Enforce summary monotonicity: the Goal is always preserved and the set of
 *    completed sub-steps only ever grows (a superset of the prior set) —
 *    completed sub-steps are never dropped, regardless of what the injected fold
 *    returns (Req 4.1, 4.4, Property 14).
 *  - Assemble a bounded {@link ReasoningContext} = summary + at most K recent
 *    steps, never the full Trajectory (Req 3.5, 4.3).
 *
 * Electron-free and pure at the trigger/fold boundary; the model call is
 * injected as a {@link SummarizeFn}.
 */

/**
 * Number of unfolded steps (steps after `summary.updatedThroughIndex`) that may
 * accumulate before older ones are folded into the summary. Comfortably larger
 * than {@link KEEP_RECENT} so summarization runs in occasional batches rather
 * than on nearly every step, and so the "fold" always has steps to fold once
 * the threshold is crossed.
 */
export const SUMMARIZE_THRESHOLD = 8

export { KEEP_RECENT }

/** The injected fold: condense older Trajectory steps into the running summary. */
export type SummarizeFn = (
    steps: TrajectoryStep[],
    prev: TrajectorySummary
) => Promise<TrajectorySummary>

/** Maximum length of one persisted summary sentence after redaction. */
export const SUMMARY_TEXT_LIMIT = 180
/** Hard cap for successful action categories retained in an in-session summary. */
export const MAX_SUMMARY_SUB_STEPS = 12

const SAFE_SUMMARY_ITEMS = new Set([
    'Task completed successfully.',
    'Clicked the intended target.',
    'Opened the target context menu.',
    'Opened the intended target.',
    'Dragged the intended item to its destination.',
    'Entered text into the active field.',
    'Pressed a keyboard shortcut.',
    'Scrolled the current view.'
])

/**
 * Remove common credential-shaped values before text is retained as memory.
 * This is defense in depth: typed Action payloads and screenshots are never
 * copied into summaries in the first place.
 */
export function sanitizeMemoryText(
    value: string,
    limit: number = SUMMARY_TEXT_LIMIT
): string {
    const redacted = value
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(
            /\b(api[-_ ]?key|access[-_ ]?token|auth(?:orization)?|password|secret)\b\s*[:=]\s*[^\s,;]+/gi,
            '$1=[redacted]'
        )
        .replace(/([?&](?:api_?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted identifier]')
        .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[redacted number]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    if (limit <= 0) return ''
    return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Deterministically condense successful steps into a small allowlisted set of
 * action categories. Free-form model rationales, completion summaries, typed
 * values, coordinates, and observations are never made durable memory.
 */
export function summarizeTrajectorySteps(
    steps: readonly TrajectoryStep[],
    prev: TrajectorySummary
): TrajectorySummary {
    const completed = prev.completedSubSteps
        .map((item) => sanitizeMemoryText(item))
        .filter((item) => SAFE_SUMMARY_ITEMS.has(item))

    for (const step of steps) {
        if (step.reasoning.outcome === 'completion') {
            completed.push('Task completed successfully.')
            continue
        }

        if (step.action && step.result?.status === 'success') {
            const progress = describeSuccessfulAction(step.action)
            if (progress.length > 0) completed.push(progress)
        }
    }

    const bounded = uniqueSummaryItems(completed).slice(-MAX_SUMMARY_SUB_STEPS)
    return {
        goalText: prev.goalText,
        inferredProgress: bounded[bounded.length - 1] ?? '',
        completedSubSteps: bounded,
        updatedThroughIndex: prev.updatedThroughIndex
    }
}

function uniqueSummaryItems(items: readonly string[]): string[] {
    const output: string[] = []
    const seen = new Set<string>()
    for (const item of items) {
        const normalized = item.toLocaleLowerCase()
        if (seen.has(normalized)) continue
        seen.add(normalized)
        output.push(item)
    }
    return output
}

/** Describe successful Actions without retaining coordinates or typed content. */
function describeSuccessfulAction(action: Action): string {
    switch (action.kind) {
        case 'left_click':
            return 'Clicked the intended target.'
        case 'right_click':
            return 'Opened the target context menu.'
        case 'double_click':
            return 'Opened the intended target.'
        case 'drag':
            return 'Dragged the intended item to its destination.'
        case 'type':
            return 'Entered text into the active field.'
        case 'key':
            return 'Pressed a keyboard shortcut.'
        case 'scroll':
            return 'Scrolled the current view.'
        case 'screenshot':
        case 'mouse_move':
        case 'wait':
            return ''
    }
}

/** The minimal sink the Summarizer writes the updated summary back through. */
export interface SummaryStore {
    /** Replace the active session's running summary. */
    setSummary(summary: TrajectorySummary): void
}

/**
 * The number of unfolded Trajectory steps, i.e. steps whose index is beyond the
 * summary's watermark (`updatedThroughIndex`). When the watermark is null, every
 * step is unfolded. Pure and deterministic.
 */
export function stepsSinceLastSummary(
    trajectory: readonly TrajectoryStep[],
    summary: TrajectorySummary
): number {
    const firstUnfolded = firstUnfoldedPosition(trajectory, summary)
    return trajectory.length - firstUnfolded
}

/**
 * Whether the summary should be folded now: **if and only if** the number of
 * steps since the last summary exceeds `threshold` (Req 4.2, Property 13). With
 * the default `threshold` >= `keepRecent`, crossing the threshold always leaves
 * foldable steps behind the recent window.
 */
export function shouldSummarize(
    trajectory: readonly TrajectoryStep[],
    summary: TrajectorySummary,
    threshold: number = SUMMARIZE_THRESHOLD
): boolean {
    return stepsSinceLastSummary(trajectory, summary) > threshold
}

/** Array position of the first unfolded step (right after the watermark). */
function firstUnfoldedPosition(
    trajectory: readonly TrajectoryStep[],
    summary: TrajectorySummary
): number {
    if (summary.updatedThroughIndex === null) return 0
    const foldedPos = trajectory.findIndex((s) => s.index === summary.updatedThroughIndex)
    // Watermark not found (e.g. summary ahead of a truncated trajectory) -> treat
    // as nothing foldable so we never re-fold or fold negative ranges.
    if (foldedPos === -1) return trajectory.length
    return foldedPos + 1
}

/**
 * Pure trigger logic: given the Trajectory + running summary, decide which older
 * steps (if any) to fold now. Returns the contiguous slice of not-yet-folded
 * steps that precede the most-recent `keepRecent` steps, or `null` when the
 * unfolded backlog has not exceeded `threshold` (Req 4.2, Property 13).
 * Deterministic and side-effect free.
 */
export function selectStepsToFold(
    trajectory: readonly TrajectoryStep[],
    summary: TrajectorySummary,
    threshold: number = SUMMARIZE_THRESHOLD,
    keepRecent: number = KEEP_RECENT
): TrajectoryStep[] | null {
    if (!shouldSummarize(trajectory, summary, threshold)) return null

    const firstUnfolded = firstUnfoldedPosition(trajectory, summary)
    const foldEnd = trajectory.length - keepRecent
    if (foldEnd <= firstUnfolded) return null

    return trajectory.slice(firstUnfolded, foldEnd)
}

/**
 * Merge a freshly produced summary onto the prior one while ENFORCING the
 * monotonicity invariant (Req 4.1, 4.4, Property 14): the Goal is preserved from
 * the prior summary and the completed sub-steps are the union of the prior set
 * and any newly produced ones (order-preserving, de-duplicated) so completed
 * sub-steps are never dropped — no matter what the injected fold returns. The
 * watermark is advanced to `lastFoldedIndex`.
 */
export function foldSummary(
    prev: TrajectorySummary,
    produced: TrajectorySummary,
    lastFoldedIndex: number
): TrajectorySummary {
    return {
        // Preserve the Goal (Req 4.4) — the fold can never rewrite it.
        goalText: prev.goalText,
        inferredProgress: produced.inferredProgress,
        // Monotonic union: prior completed sub-steps are never dropped (Req 4.4).
        completedSubSteps: unionPreservingOrder(
            prev.completedSubSteps,
            produced.completedSubSteps
        ),
        updatedThroughIndex: lastFoldedIndex
    }
}

/** Union of two string lists, preserving `a`'s order first, de-duplicated. */
function unionPreservingOrder(a: readonly string[], b: readonly string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const value of [...a, ...b]) {
        if (!seen.has(value)) {
            seen.add(value)
            out.push(value)
        }
    }
    return out
}

/**
 * Assemble the bounded {@link ReasoningContext} for a Reasoning_Step: the running
 * summary plus at most `keepRecent` most-recent steps — never the full
 * step-by-step Trajectory (Req 3.5, 4.3). Returns the trajectory suffix so the
 * request size stays bounded as the session grows.
 */
export function buildReasoningContext(
    goal: string,
    summary: TrajectorySummary,
    trajectory: readonly TrajectoryStep[],
    currentObservation: Observation,
    keepRecent: number = KEEP_RECENT,
    environmentHint?: string,
    guidance?: readonly string[]
): ReasoningContext {
    const recentSteps = keepRecent > 0 ? trajectory.slice(-keepRecent) : []
    // Re-project from structured action/result data on every request so an old
    // persisted summary containing free-form model text can never be replayed.
    const safeSummary = summarizeTrajectorySteps(trajectory, {
        goalText: goal,
        inferredProgress: '',
        completedSubSteps: [],
        updatedThroughIndex: summary.updatedThroughIndex
    })
    const ctx: ReasoningContext = {
        goal,
        summary: safeSummary,
        recentSteps: [...recentSteps],
        currentObservation
    }
    if (environmentHint) ctx.environmentHint = environmentHint
    if (guidance && guidance.length > 0) ctx.guidance = [...guidance]
    return ctx
}

export interface SummarizerOptions {
    /** The fold: condenses older steps into the summary (the ReasoningRouter's `summarize`). */
    summarize: SummarizeFn
    /** Sink for the updated summary (the {@link SessionManager}). */
    store: SummaryStore
    /** Unfolded-step backlog that triggers a fold. Defaults to {@link SUMMARIZE_THRESHOLD}. */
    threshold?: number
    /** Recent steps kept verbatim (never folded). Defaults to {@link KEEP_RECENT}. */
    keepRecent?: number
}

/**
 * Drives the summarization trigger. Wire {@link onStepAppended} to the Session
 * Manager's `onStepAppended` hook; it runs the trigger after every appended step
 * and stores the monotonically-merged summary when the backlog crosses the
 * threshold.
 */
export class Summarizer {
    private readonly summarize: SummarizeFn
    private readonly store: SummaryStore
    private readonly threshold: number
    private readonly keepRecent: number

    constructor(options: SummarizerOptions) {
        this.summarize = options.summarize
        this.store = options.store
        this.threshold = options.threshold ?? SUMMARIZE_THRESHOLD
        this.keepRecent = options.keepRecent ?? KEEP_RECENT
    }

    /**
     * Session Manager `onStepAppended` hook. Evaluates the trigger against the
     * session's Trajectory + summary as they stand after the append.
     */
    onStepAppended = (
        _step: TrajectoryStep,
        session: { trajectory: TrajectoryStep[]; summary: TrajectorySummary }
    ): Promise<void> => {
        return this.maybeSummarize(session.trajectory, session.summary)
    }

    /**
     * Run the trigger once: when the unfolded backlog exceeds the threshold,
     * fold the older steps via the injected {@link SummarizeFn} and store the
     * monotonically-merged summary with the watermark advanced to the last
     * folded step. A no-op below the threshold (Req 4.2, Property 13).
     */
    async maybeSummarize(
        trajectory: readonly TrajectoryStep[],
        summary: TrajectorySummary
    ): Promise<void> {
        const older = selectStepsToFold(trajectory, summary, this.threshold, this.keepRecent)
        if (!older || older.length === 0) return

        const produced = await this.summarize(older, summary)
        const lastFoldedIndex = older[older.length - 1].index
        this.store.setSummary(foldSummary(summary, produced, lastFoldedIndex))
    }
}
