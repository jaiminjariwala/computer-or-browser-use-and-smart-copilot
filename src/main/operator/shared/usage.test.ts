import { describe, it, expect } from 'vitest'
import type { TokenUsage, TrajectoryStepView } from './types'
import {
    emptyUsage,
    addUsage,
    hasUsage,
    sumUsage,
    priceForModel,
    estimateCostUsd,
    formatTokens,
    formatCostUsd
} from './usage'

/**
 * Unit tests for the token-usage aggregation + cost estimation helpers
 * (observability). All pure, so they run headlessly.
 */

const usage = (p: number, c: number, t = p + c): TokenUsage => ({
    promptTokens: p,
    completionTokens: c,
    totalTokens: t
})

describe('emptyUsage / addUsage', () => {
    it('emptyUsage is all zeroes', () => {
        expect(emptyUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    })

    it('addUsage sums field-by-field without mutating inputs', () => {
        const a = usage(10, 5)
        const b = usage(3, 7)
        expect(addUsage(a, b)).toEqual({ promptTokens: 13, completionTokens: 12, totalTokens: 25 })
        expect(a).toEqual(usage(10, 5))
        expect(b).toEqual(usage(3, 7))
    })
})

describe('hasUsage', () => {
    it('is false for undefined and all-zero', () => {
        expect(hasUsage(undefined)).toBe(false)
        expect(hasUsage(emptyUsage())).toBe(false)
    })
    it('is true when any field is positive', () => {
        expect(hasUsage(usage(0, 1))).toBe(true)
    })
})

describe('sumUsage', () => {
    const stepView = (u?: TokenUsage): TrajectoryStepView => ({
        index: 0,
        outcome: 'action',
        rationale: '',
        providerId: 'p',
        usage: u,
        capturedAt: ''
    })

    it('returns undefined when no step reported usage', () => {
        expect(sumUsage([stepView(), stepView()])).toBeUndefined()
    })

    it('sums usage across step views', () => {
        expect(sumUsage([stepView(usage(10, 5)), stepView(usage(4, 6))])).toEqual(
            usage(14, 11, 25)
        )
    })

    it('sums usage across stored steps (reasoning.usage)', () => {
        const stored = [
            { reasoning: { usage: usage(2, 3) } },
            { reasoning: { usage: undefined } },
            { reasoning: { usage: usage(1, 1) } }
        ]
        expect(sumUsage(stored)).toEqual(usage(3, 4, 7))
    })
})

describe('priceForModel', () => {
    it('matches free tiers to zero pricing', () => {
        expect(priceForModel('gemini-2.5-flash')).toEqual({ inputPerM: 0, outputPerM: 0 })
        expect(priceForModel('some-model:free')).toEqual({ inputPerM: 0, outputPerM: 0 })
    })

    it('prefers the longest substring match', () => {
        // 'gpt-4o-mini' is longer than 'gpt-4o' and must win.
        expect(priceForModel('gpt-4o-mini')).toEqual({ inputPerM: 0.15, outputPerM: 0.6 })
    })

    it('returns undefined for an unknown model', () => {
        expect(priceForModel('mystery-model-9000')).toBeUndefined()
        expect(priceForModel(undefined)).toBeUndefined()
    })
})

describe('estimateCostUsd', () => {
    it('is 0 for a known free model', () => {
        expect(estimateCostUsd('gemini-2.5-flash', usage(1000, 1000))).toBe(0)
    })

    it('computes cost from per-million pricing', () => {
        // gpt-4o-mini: $0.15/M in, $0.60/M out.
        // 1M prompt + 1M completion => 0.15 + 0.60 = 0.75
        expect(estimateCostUsd('gpt-4o-mini', usage(1_000_000, 1_000_000))).toBeCloseTo(0.75, 6)
    })

    it('is undefined for an unknown model', () => {
        expect(estimateCostUsd('mystery', usage(100, 100))).toBeUndefined()
    })

    it('is undefined when there is no usage and no known price', () => {
        expect(estimateCostUsd(undefined, undefined)).toBeUndefined()
    })
})

describe('formatTokens', () => {
    it('formats small counts verbatim', () => {
        expect(formatTokens(0)).toBe('0')
        expect(formatTokens(999)).toBe('999')
    })
    it('abbreviates thousands', () => {
        expect(formatTokens(1200)).toBe('1.2k')
        expect(formatTokens(12_340)).toBe('12k')
    })
})

describe('formatCostUsd', () => {
    it('undefined stays undefined', () => {
        expect(formatCostUsd(undefined)).toBeUndefined()
    })
    it('exact zero is "free"', () => {
        expect(formatCostUsd(0)).toBe('free')
    })
    it('sub-cent uses 4 decimals; larger uses 2', () => {
        expect(formatCostUsd(0.0004)).toBe('$0.0004')
        expect(formatCostUsd(1.5)).toBe('$1.50')
    })
})
