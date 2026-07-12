import type { Action } from '@op-shared/types'

/**
 * Progress / stuck detection (reliability layer) — PURE, Electron-free.
 *
 * The Agent Loop can get stuck two ways that the base state machine does not
 * itself notice: it repeats the SAME ineffective Action over and over (e.g.
 * clicking the same coordinate that never does anything), or it strings together
 * consecutive failed Actions. Left alone, either burns the whole Step_Budget
 * making no progress.
 *
 * This module turns those two signals into (a) a corrective guidance string the
 * loop folds into the next Reasoning_Step so the model self-corrects instead of
 * repeating itself, and (b) a hard "give up, this is stuck" verdict once the
 * behaviour is clearly pathological, so a run fails fast with a clear reason
 * rather than silently grinding to budget exhaustion.
 *
 * It is pure and deterministic so it can be exhaustively unit-tested in-memory,
 * matching the rest of the loop's testing posture.
 */

/**
 * Trailing identical Actions that trip the soft "you are repeating yourself"
 * nudge (a corrective hint is folded into the next reasoning turn).
 */
export const SOFT_REPEAT_THRESHOLD = 3

/** Consecutive failed Actions that trip the soft "stop repeating a failing approach" nudge. */
export const SOFT_FAILURE_THRESHOLD = 3

/** Trailing identical Actions at which the run is declared hopelessly stuck and fails. */
export const HARD_REPEAT_THRESHOLD = 6

/** Consecutive failed Actions at which the run is declared hopelessly stuck and fails. */
export const HARD_FAILURE_THRESHOLD = 8

/** Coordinate bucket (px): points within this distance are treated as "the same spot". */
const COORD_BUCKET_PX = 12

/**
 * Action kinds whose repetition is a genuine stuck signal. `scroll`, `wait`, and
 * `screenshot` are inherently repeatable during legitimate progress (scrolling a
 * long page, polling for a load), so repeating them is NOT treated as stuck.
 */
function isDiagnosticKind(kind: Action['kind']): boolean {
    return (
        kind === 'left_click' ||
        kind === 'right_click' ||
        kind === 'double_click' ||
        kind === 'mouse_move' ||
        kind === 'drag' ||
        kind === 'type' ||
        kind === 'key'
    )
}

function bucket(n: number): number {
    return Math.round(n / COORD_BUCKET_PX)
}

/**
 * A stable signature for an Action, used to detect repeats. Coordinates are
 * bucketed so a model nudging a click a few pixels each turn still counts as
 * repeating the same target; `type`/`key` compare on their (normalized) payload;
 * inherently-repeatable kinds get a signature but are excluded from the repeat
 * heuristic by {@link trailingRepeatCount}.
 */
export function actionSignature(action: Action): string {
    switch (action.kind) {
        case 'screenshot':
            return 'screenshot'
        case 'wait':
            return 'wait'
        case 'type':
            return `type:${action.text.trim().toLowerCase()}`
        case 'key':
            return `key:${action.keys.join('+').toLowerCase()}`
        case 'scroll':
            return `scroll:${Math.sign(action.dx)},${Math.sign(action.dy)}`
        case 'drag':
            return `drag:${bucket(action.from.x)},${bucket(action.from.y)}->${bucket(action.to.x)},${bucket(action.to.y)}`
        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click':
            return `${action.kind}:${bucket(action.at.x)},${bucket(action.at.y)}`
        default: {
            const _never: never = action
            void _never
            return 'unknown'
        }
    }
}

/**
 * How many Actions at the END of `actions` are the same diagnostic Action
 * repeated back-to-back. Returns 0 when the most recent Action is a
 * non-diagnostic kind (scroll/wait/screenshot), so legitimate repeated scrolling
 * never looks stuck. Deterministic and side-effect free.
 */
export function trailingRepeatCount(actions: readonly Action[]): number {
    if (actions.length === 0) return 0
    const last = actions[actions.length - 1]
    if (!isDiagnosticKind(last.kind)) return 0
    const sig = actionSignature(last)
    let count = 0
    for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i]
        if (isDiagnosticKind(a.kind) && actionSignature(a) === sig) count += 1
        else break
    }
    return count
}

/** Options for the progress heuristics (defaults to the module thresholds). */
export interface ProgressThresholds {
    softRepeat?: number
    softFailure?: number
    hardRepeat?: number
    hardFailure?: number
}

/**
 * Whether the run is hopelessly stuck and should fail fast: the same Action has
 * been repeated {@link HARD_REPEAT_THRESHOLD}+ times, or {@link HARD_FAILURE_THRESHOLD}+
 * Actions have failed in a row. Returns a human-readable reason, or null when the
 * run is not (yet) hard-stuck.
 */
export function hardStuckReason(
    recentActions: readonly Action[],
    consecutiveFailures: number,
    thresholds: ProgressThresholds = {}
): string | null {
    const hardRepeat = thresholds.hardRepeat ?? HARD_REPEAT_THRESHOLD
    const hardFailure = thresholds.hardFailure ?? HARD_FAILURE_THRESHOLD
    const repeats = trailingRepeatCount(recentActions)
    if (repeats >= hardRepeat) {
        return `Repeated the same action ${repeats} times with no progress; stopping to avoid wasting the step budget.`
    }
    if (consecutiveFailures >= hardFailure) {
        return `${consecutiveFailures} actions failed in a row; stopping to avoid wasting the step budget.`
    }
    return null
}

/**
 * A one-shot corrective guidance string to fold into the next Reasoning_Step, or
 * null when the agent is progressing normally. Fires below the hard-stuck limits
 * so the model gets a chance to self-correct before the run is abandoned:
 *  - repeating the same Action → tell it to stop and try a different approach;
 *  - consecutive failures → tell it the approach is failing and to reconsider.
 */
export function buildProgressHint(
    recentActions: readonly Action[],
    consecutiveFailures: number,
    thresholds: ProgressThresholds = {}
): string | null {
    const softRepeat = thresholds.softRepeat ?? SOFT_REPEAT_THRESHOLD
    const softFailure = thresholds.softFailure ?? SOFT_FAILURE_THRESHOLD
    const repeats = trailingRepeatCount(recentActions)

    if (repeats >= softRepeat) {
        const last = recentActions[recentActions.length - 1]
        return (
            `SELF-CORRECTION: You have already tried the same action (${last.kind}) ` +
            `${repeats} times and the screen has not changed. Do NOT repeat it again. ` +
            `Re-read the current observation carefully and choose a DIFFERENT approach — ` +
            `target a different element, scroll to reveal more of the page, or if the ` +
            `goal genuinely cannot proceed from here, call request_help.`
        )
    }

    if (consecutiveFailures >= softFailure) {
        return (
            `SELF-CORRECTION: The last ${consecutiveFailures} actions failed. The current ` +
            `approach is not working. Stop retrying it — reconsider the observation and pick ` +
            `a different action, or call request_help if you are blocked.`
        )
    }

    return null
}
