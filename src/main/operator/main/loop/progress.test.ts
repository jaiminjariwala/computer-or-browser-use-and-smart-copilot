import { describe, it, expect } from 'vitest'
import type { Action } from '@op-shared/types'
import {
    actionSignature,
    trailingRepeatCount,
    buildProgressHint,
    hardStuckReason,
    SOFT_REPEAT_THRESHOLD,
    SOFT_FAILURE_THRESHOLD,
    HARD_REPEAT_THRESHOLD,
    HARD_FAILURE_THRESHOLD
} from './progress'

/**
 * Unit tests for the progress / stuck detector (reliability layer).
 *
 * These cover the pure heuristics the Agent Loop relies on to notice it is
 * repeating an ineffective Action or failing repeatedly, so it can self-correct
 * (soft hint) or fail fast (hard stop) instead of burning the whole Step_Budget.
 */

const click = (x: number, y: number): Action => ({ kind: 'left_click', at: { x, y } })
const scrollDown = (): Action => ({ kind: 'scroll', at: { x: 0, y: 0 }, dx: 0, dy: 100 })
const type = (text: string): Action => ({ kind: 'type', text })

describe('actionSignature', () => {
    it('buckets coordinates in the same bucket to the same signature', () => {
        // A model nudging a click a couple of pixels within the same bucket still
        // counts as repeating the same target.
        expect(actionSignature(click(100, 100))).toBe(actionSignature(click(101, 99)))
    })

    it('distinguishes far-apart coordinates', () => {
        expect(actionSignature(click(100, 100))).not.toBe(actionSignature(click(400, 400)))
    })

    it('normalizes type payloads (trim + lowercase)', () => {
        expect(actionSignature(type('  Hello '))).toBe(actionSignature(type('hello')))
    })

    it('distinguishes different action kinds at the same point', () => {
        const at = { x: 50, y: 50 }
        expect(actionSignature({ kind: 'left_click', at })).not.toBe(
            actionSignature({ kind: 'right_click', at })
        )
    })
})

describe('trailingRepeatCount', () => {
    it('is 0 for an empty history', () => {
        expect(trailingRepeatCount([])).toBe(0)
    })

    it('counts back-to-back identical clicks', () => {
        expect(trailingRepeatCount([click(10, 10), click(12, 8), click(11, 9)])).toBe(3)
    })

    it('resets the count when the target changes', () => {
        expect(trailingRepeatCount([click(10, 10), click(10, 10), click(400, 400)])).toBe(1)
    })

    it('does NOT treat repeated scrolling as stuck (0)', () => {
        expect(trailingRepeatCount([scrollDown(), scrollDown(), scrollDown()])).toBe(0)
    })

    it('stops counting at a non-matching earlier action', () => {
        expect(trailingRepeatCount([click(400, 400), click(10, 10), click(10, 10)])).toBe(2)
    })
})

describe('buildProgressHint', () => {
    it('returns null when progressing normally', () => {
        expect(buildProgressHint([click(10, 10), scrollDown()], 0)).toBeNull()
    })

    it('nudges when the same action repeats past the soft threshold', () => {
        const actions = Array.from({ length: SOFT_REPEAT_THRESHOLD }, () => click(10, 10))
        const hint = buildProgressHint(actions, 0)
        expect(hint).toContain('SELF-CORRECTION')
        expect(hint).toContain('different')
    })

    it('nudges on consecutive failures past the soft threshold', () => {
        const hint = buildProgressHint([scrollDown()], SOFT_FAILURE_THRESHOLD)
        expect(hint).toContain('SELF-CORRECTION')
        expect(hint).toContain('failed')
    })

    it('does not nudge just below the soft thresholds', () => {
        const actions = Array.from({ length: SOFT_REPEAT_THRESHOLD - 1 }, () => click(10, 10))
        expect(buildProgressHint(actions, SOFT_FAILURE_THRESHOLD - 1)).toBeNull()
    })
})

describe('hardStuckReason', () => {
    it('returns null when not stuck', () => {
        expect(hardStuckReason([click(10, 10)], 1)).toBeNull()
    })

    it('fails fast after too many identical repeats', () => {
        const actions = Array.from({ length: HARD_REPEAT_THRESHOLD }, () => click(10, 10))
        expect(hardStuckReason(actions, 0)).toContain('Repeated the same action')
    })

    it('fails fast after too many consecutive failures', () => {
        expect(hardStuckReason([scrollDown()], HARD_FAILURE_THRESHOLD)).toContain(
            'actions failed in a row'
        )
    })
})
