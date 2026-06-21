import { describe, it, expect, vi } from 'vitest'
import {
    CaptureService,
    DEFAULT_MAX_THUMBNAIL_DIMENSION,
    clampRect,
    computeThumbnailSize,
    cropToCapture,
    type CaptureImage,
    type ImageSize
} from './capture'
import type { Rect } from '@shared/types'

/**
 * Unit tests for the Capture Service crop/clamp pipeline (task 8.2).
 *
 * The crop/clamp math is pure and Electron-free, so it can be exercised
 * directly with a fake image. These cover the example cases and edge cases;
 * task 8.4 adds the property tests for the clamping/containment invariants.
 *
 * Validates: Requirements 4.3, 4.4, 4.5, 4.6
 */

/**
 * A lightweight fake of the Electron `NativeImage` surface that records the
 * operations performed on it, so tests can assert what was cropped/resized
 * without any Electron dependency.
 */
function makeFakeImage(size: ImageSize): CaptureImage & {
    cropCalls: Rect[]
    resizeCalls: ImageSize[]
} {
    const cropCalls: Rect[] = []
    const resizeCalls: ImageSize[] = []

    const build = (current: ImageSize): CaptureImage => ({
        getSize: () => current,
        crop: (rect: Rect) => {
            cropCalls.push(rect)
            return build({ width: rect.width, height: rect.height })
        },
        resize: (options: { width?: number; height?: number }) => {
            const next = {
                width: options.width ?? current.width,
                height: options.height ?? current.height
            }
            resizeCalls.push(next)
            return build(next)
        },
        toDataURL: () => `data:image/png;base64,${current.width}x${current.height}`
    })

    return Object.assign(build(size), { cropCalls, resizeCalls })
}

describe('clampRect', () => {
    const bounds: ImageSize = { width: 1000, height: 800 }

    it('leaves an in-bounds rect unchanged (rounded to pixels)', () => {
        expect(clampRect({ x: 100, y: 50, width: 200, height: 150 }, bounds)).toEqual({
            x: 100,
            y: 50,
            width: 200,
            height: 150
        })
    })

    it('trims a rect that overhangs the right/bottom edges (Req 4.3)', () => {
        const clamped = clampRect({ x: 900, y: 700, width: 400, height: 400 }, bounds)
        expect(clamped).toEqual({ x: 900, y: 700, width: 100, height: 100 })
        expect(clamped.x + clamped.width).toBeLessThanOrEqual(bounds.width)
        expect(clamped.y + clamped.height).toBeLessThanOrEqual(bounds.height)
    })

    it('clamps a rect with a negative origin to the top-left edge', () => {
        expect(clampRect({ x: -50, y: -30, width: 200, height: 100 }, bounds)).toEqual({
            x: 0,
            y: 0,
            width: 150,
            height: 70
        })
    })

    it('normalizes a rect dragged right-to-left (negative width/height)', () => {
        // Selection from (300,250) back to (100,100): negative width/height.
        expect(clampRect({ x: 300, y: 250, width: -200, height: -150 }, bounds)).toEqual({
            x: 100,
            y: 100,
            width: 200,
            height: 150
        })
    })

    it('collapses a fully out-of-bounds rect to zero area on the nearest edge', () => {
        const clamped = clampRect({ x: 2000, y: 2000, width: 100, height: 100 }, bounds)
        expect(clamped).toEqual({ x: 1000, y: 800, width: 0, height: 0 })
    })

    it('always stays within the bounds for assorted rects', () => {
        const rects: Rect[] = [
            { x: -100, y: -100, width: 5000, height: 5000 },
            { x: 999, y: 799, width: 5, height: 5 },
            { x: 0, y: 0, width: 1000, height: 800 }
        ]
        for (const r of rects) {
            const c = clampRect(r, bounds)
            expect(c.x).toBeGreaterThanOrEqual(0)
            expect(c.y).toBeGreaterThanOrEqual(0)
            expect(c.x + c.width).toBeLessThanOrEqual(bounds.width)
            expect(c.y + c.height).toBeLessThanOrEqual(bounds.height)
        }
    })
})

describe('computeThumbnailSize', () => {
    it('returns the source size when already within the limit', () => {
        expect(computeThumbnailSize(100, 80, 240)).toEqual({ width: 100, height: 80 })
    })

    it('scales down preserving aspect ratio on the longest edge', () => {
        expect(computeThumbnailSize(480, 240, 240)).toEqual({ width: 240, height: 120 })
    })

    it('scales a tall image by its height', () => {
        expect(computeThumbnailSize(120, 600, 240)).toEqual({ width: 48, height: 240 })
    })

    it('yields zero area for zero-area input', () => {
        expect(computeThumbnailSize(0, 500)).toEqual({ width: 0, height: 0 })
        expect(computeThumbnailSize(500, 0)).toEqual({ width: 0, height: 0 })
    })

    it('never produces a dimension below 1px for a very wide image', () => {
        const thumb = computeThumbnailSize(2400, 2, 240)
        expect(thumb.width).toBe(240)
        expect(thumb.height).toBeGreaterThanOrEqual(1)
    })
})

describe('cropToCapture', () => {
    it('crops to the clamped rect and returns it (Req 4.3, 4.5)', () => {
        const image = makeFakeImage({ width: 1000, height: 800 })
        const capture = cropToCapture(image, { x: 900, y: 700, width: 400, height: 400 })

        expect(image.cropCalls).toEqual([{ x: 900, y: 700, width: 100, height: 100 }])
        expect(capture.rect).toEqual({ x: 900, y: 700, width: 100, height: 100 })
        expect(capture.dataUrl).toBe('data:image/png;base64,100x100')
    })

    it('does not resize when the crop already fits the thumbnail limit', () => {
        const image = makeFakeImage({ width: 1000, height: 800 })
        const capture = cropToCapture(image, { x: 0, y: 0, width: 200, height: 150 })

        expect(image.resizeCalls).toEqual([])
        // Thumbnail falls back to the full crop data URL when no resize occurs.
        expect(capture.thumbnailUrl).toBe(capture.dataUrl)
    })

    it('downscales the thumbnail for a large crop preserving aspect ratio (Req 2.5)', () => {
        const image = makeFakeImage({ width: 4000, height: 3000 })
        const capture = cropToCapture(
            image,
            { x: 0, y: 0, width: 1000, height: 500 },
            { maxThumbnailDimension: DEFAULT_MAX_THUMBNAIL_DIMENSION }
        )

        expect(image.resizeCalls).toEqual([{ width: 240, height: 120 }])
        expect(capture.dataUrl).toBe('data:image/png;base64,1000x500')
        expect(capture.thumbnailUrl).toBe('data:image/png;base64,240x120')
    })
})

describe('CaptureService', () => {
    it('captures the active display and crops to the rect', async () => {
        const thumbnail = makeFakeImage({ width: 1440, height: 900 })
        const getSources = vi.fn(async (_size: ImageSize) => [
            { display_id: '42', thumbnail }
        ])
        const service = new CaptureService({
            getActiveDisplay: () => ({ id: 42, size: { width: 1440, height: 900 } }),
            getSources
        })

        const capture = await service.captureRegion({ x: 10, y: 20, width: 300, height: 200 })

        // Requested the source at the active display's logical size.
        expect(getSources).toHaveBeenCalledWith({ width: 1440, height: 900 })
        expect(thumbnail.cropCalls).toEqual([{ x: 10, y: 20, width: 300, height: 200 }])
        expect(capture.rect).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    })

    it('matches the source by display id when multiple screens exist', async () => {
        const primary = makeFakeImage({ width: 1920, height: 1080 })
        const secondary = makeFakeImage({ width: 1440, height: 900 })
        const service = new CaptureService({
            getActiveDisplay: () => ({ id: 2, size: { width: 1440, height: 900 } }),
            getSources: async () => [
                { display_id: '1', thumbnail: primary },
                { display_id: '2', thumbnail: secondary }
            ]
        })

        await service.captureRegion({ x: 0, y: 0, width: 100, height: 100 })

        expect(secondary.cropCalls).toHaveLength(1)
        expect(primary.cropCalls).toHaveLength(0)
    })

    it('throws when no screen source is available', async () => {
        const service = new CaptureService({
            getActiveDisplay: () => ({ id: 1, size: { width: 800, height: 600 } }),
            getSources: async () => []
        })

        await expect(
            service.captureRegion({ x: 0, y: 0, width: 10, height: 10 })
        ).rejects.toThrow(/no screen source/i)
    })
})
