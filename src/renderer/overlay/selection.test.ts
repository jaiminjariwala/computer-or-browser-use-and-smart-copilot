import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
    isValidSelection,
    MIN_SELECTION_SIZE,
    rectFromPoints,
    type Point
} from './selection'

/**
 * Unit + property tests for the overlay's region-selection geometry (task 8.1).
 *
 * Covers normalization of a drag (any direction → a top-left-origin rect with
 * non-negative size, Req 4.2) and the minimum-size gate used to ignore stray
 * clicks before submitting a region (Req 4.3).
 */

describe('rectFromPoints', () => {
    it('builds a rect from a top-left → bottom-right drag', () => {
        expect(rectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({
            x: 10,
            y: 20,
            width: 100,
            height: 200
        })
    })

    it('normalizes a bottom-right → top-left drag to the same rect', () => {
        expect(rectFromPoints({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({
            x: 10,
            y: 20,
            width: 100,
            height: 200
        })
    })

    it('normalizes a mixed-direction drag', () => {
        expect(rectFromPoints({ x: 110, y: 20 }, { x: 10, y: 220 })).toEqual({
            x: 10,
            y: 20,
            width: 100,
            height: 200
        })
    })

    it('yields a zero-size rect for a click (no drag)', () => {
        expect(rectFromPoints({ x: 42, y: 42 }, { x: 42, y: 42 })).toEqual({
            x: 42,
            y: 42,
            width: 0,
            height: 0
        })
    })

    it('floors the origin and rounds the size to whole pixels', () => {
        expect(rectFromPoints({ x: 10.8, y: 20.2 }, { x: 30.1, y: 50.9 })).toEqual({
            x: 10,
            y: 20,
            width: 19,
            height: 31
        })
    })

    // Property: regardless of drag direction, the rect is normalized — its
    // origin is the min corner and its size is non-negative (Req 4.2).
    it('always produces a non-negative, top-left-origin rect (property)', () => {
        const coord = fc.integer({ min: -5000, max: 5000 })
        fc.assert(
            fc.property(coord, coord, coord, coord, (x1, y1, x2, y2) => {
                const a: Point = { x: x1, y: y1 }
                const b: Point = { x: x2, y: y2 }
                const rect = rectFromPoints(a, b)
                expect(rect.width).toBeGreaterThanOrEqual(0)
                expect(rect.height).toBeGreaterThanOrEqual(0)
                expect(rect.x).toBe(Math.min(x1, x2))
                expect(rect.y).toBe(Math.min(y1, y2))
                expect(rect.width).toBe(Math.abs(x1 - x2))
                expect(rect.height).toBe(Math.abs(y1 - y2))
            })
        )
    })

    // Property: swapping the two points never changes the resulting rect.
    it('is order-independent (property)', () => {
        const coord = fc.integer({ min: -5000, max: 5000 })
        fc.assert(
            fc.property(coord, coord, coord, coord, (x1, y1, x2, y2) => {
                const forward = rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 })
                const reverse = rectFromPoints({ x: x2, y: y2 }, { x: x1, y: y1 })
                expect(forward).toEqual(reverse)
            })
        )
    })
})

describe('isValidSelection', () => {
    it('accepts a selection at least the minimum size in both dimensions', () => {
        expect(
            isValidSelection({ x: 0, y: 0, width: MIN_SELECTION_SIZE, height: MIN_SELECTION_SIZE })
        ).toBe(true)
    })

    it('rejects a zero-size selection (stray click)', () => {
        expect(isValidSelection({ x: 5, y: 5, width: 0, height: 0 })).toBe(false)
    })

    it('rejects a selection too small in one dimension', () => {
        expect(isValidSelection({ x: 0, y: 0, width: 200, height: 1 })).toBe(false)
        expect(isValidSelection({ x: 0, y: 0, width: 1, height: 200 })).toBe(false)
    })

    it('respects a custom minimum size', () => {
        expect(isValidSelection({ x: 0, y: 0, width: 10, height: 10 }, 20)).toBe(false)
        expect(isValidSelection({ x: 0, y: 0, width: 25, height: 25 }, 20)).toBe(true)
    })
})
