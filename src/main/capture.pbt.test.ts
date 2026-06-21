import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { clampRect, cropToCapture, type CaptureImage, type ImageSize } from './capture'
import { CaptureOrchestrator } from './capture-orchestrator'
import { mapStatusToResult, type ScreenPermissionStatus } from './permissions'
import type { Rect, TurnCapture } from '@shared/types'

/**
 * Property-based tests for the capture pipeline (task 8.4).
 *
 * Two properties from the design's "Correctness Properties" are exercised here:
 *
 *   - Property 4 support (Req 4.3): for ANY image bounds and ANY selection
 *     rectangle — including out-of-bounds, negative-origin, and reversed-drag
 *     (negative width/height) rects — `clampRect` always yields a rectangle
 *     fully contained within `[0, 0, width, height]` with non-negative
 *     dimensions, and `cropToCapture` crops to EXACTLY that clamped rect.
 *
 *   - Properties 4 & 7 (Req 4.4, 4.6, 8.1): no `Region_Capture` is produced on
 *     cancel or when screen-recording permission is not granted. The Capture
 *     Service is NEVER invoked unless permission is granted, and never on the
 *     cancel path.
 *
 * Validates: Requirements 4.3, 4.4, 4.6, 8.1
 */

// --- Fakes ------------------------------------------------------------------

/**
 * A lightweight fake of the Electron `NativeImage` surface that records the
 * crop/resize operations performed on it, so the pure crop pipeline can be
 * asserted without any Electron dependency. Mirrors the helper in
 * `capture.test.ts`.
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

/** A Capture Service that counts how many times `captureRegion` was invoked. */
function makeCountingCaptureService() {
    let calls = 0
    return {
        get calls() {
            return calls
        },
        captureRegion: (rect: Rect): Promise<TurnCapture> => {
            calls++
            return Promise.resolve({
                dataUrl: 'data:image/png;base64,AAAA',
                thumbnailUrl: 'data:image/png;base64,AAAA#thumb',
                rect
            })
        }
    }
}

/** An overlay that counts show/close calls. */
function makeCountingOverlay() {
    let shows = 0
    let closes = 0
    return {
        get shows() {
            return shows
        },
        get closes() {
            return closes
        },
        showOverlay: () => {
            shows++
        },
        closeOverlay: () => {
            closes++
        }
    }
}

// --- Arbitraries ------------------------------------------------------------

/** Non-negative, finite integer image bounds. */
const boundsArb: fc.Arbitrary<ImageSize> = fc.record({
    width: fc.integer({ min: 0, max: 6000 }),
    height: fc.integer({ min: 0, max: 4000 })
})

/**
 * Arbitrary selection rectangles spanning the full input space: well past the
 * right/bottom edges, negative origins, and reversed drags (negative
 * width/height).
 */
const rectArb: fc.Arbitrary<Rect> = fc.record({
    x: fc.integer({ min: -3000, max: 8000 }),
    y: fc.integer({ min: -3000, max: 8000 }),
    width: fc.integer({ min: -3000, max: 8000 }),
    height: fc.integer({ min: -3000, max: 8000 })
})

/** Every status value, with `granted` mixed in so both branches are covered. */
const statusArb: fc.Arbitrary<ScreenPermissionStatus> = fc.constantFrom(
    'granted',
    'denied',
    'restricted',
    'not-determined',
    'unknown'
)

/** Any status that is NOT `granted`. */
const nonGrantedStatusArb: fc.Arbitrary<ScreenPermissionStatus> = fc.constantFrom(
    'denied',
    'restricted',
    'not-determined',
    'unknown'
)

// --- Property: clamp containment + crop-to-clamped (Property 4, Req 4.3) ----

describe('Property 4 support: clampRect containment + cropToCapture bounds (Req 4.3)', () => {
    it('always yields a rect fully contained in the bounds with non-negative dimensions', () => {
        fc.assert(
            fc.property(rectArb, boundsArb, (rect, bounds) => {
                const clamped = clampRect(rect, bounds)

                // Non-negative origin and dimensions.
                expect(clamped.x).toBeGreaterThanOrEqual(0)
                expect(clamped.y).toBeGreaterThanOrEqual(0)
                expect(clamped.width).toBeGreaterThanOrEqual(0)
                expect(clamped.height).toBeGreaterThanOrEqual(0)

                // Fully contained within [0, 0, width, height].
                expect(clamped.x + clamped.width).toBeLessThanOrEqual(bounds.width)
                expect(clamped.y + clamped.height).toBeLessThanOrEqual(bounds.height)
            })
        )
    })

    it('is idempotent: clamping an already-clamped rect changes nothing', () => {
        fc.assert(
            fc.property(rectArb, boundsArb, (rect, bounds) => {
                const once = clampRect(rect, bounds)
                const twice = clampRect(once, bounds)
                expect(twice).toEqual(once)
            })
        )
    })

    it('crops to EXACTLY the clamped rect for arbitrary rects (asserted via a fake image)', () => {
        fc.assert(
            fc.property(rectArb, boundsArb, (rect, bounds) => {
                const image = makeFakeImage(bounds)
                const expected = clampRect(rect, bounds)

                const capture = cropToCapture(image, rect)

                // The crop call used precisely the clamped rect — no pixels
                // outside the image are ever read (Req 4.3).
                expect(image.cropCalls).toHaveLength(1)
                expect(image.cropCalls[0]).toEqual(expected)
                // The returned capture reports the same clamped rect.
                expect(capture.rect).toEqual(expected)
            })
        )
    })
})

// --- Property: no capture on cancel / permission not granted (P4 & P7) ------

describe('Properties 4 & 7: no capture on cancel or when permission not granted (Req 4.4, 4.6, 8.1)', () => {
    it('decideCaptureTrigger yields permission-error (no overlay) for any non-granted status', () => {
        fc.assert(
            fc.property(nonGrantedStatusArb, (status) => {
                const overlay = makeCountingOverlay()
                const capture = makeCountingCaptureService()
                let emittedErrors = 0
                const orchestrator = new CaptureOrchestrator({
                    checkPermission: () => mapStatusToResult(status),
                    captureService: capture,
                    overlay,
                    stageCapture: () => {},
                    chatFlow: { handleCapture: () => Promise.resolve() },
                    emitError: () => {
                        emittedErrors++
                    }
                })

                orchestrator.handleTrigger()

                // No overlay shown, an error surfaced, and — crucially — the
                // Capture Service was never invoked (Property 7, Req 8.1).
                expect(overlay.shows).toBe(0)
                expect(emittedErrors).toBe(1)
                expect(capture.calls).toBe(0)
            })
        )
    })

    it('only shows the overlay (and never captures on trigger) exactly when granted', () => {
        fc.assert(
            fc.property(statusArb, (status) => {
                const overlay = makeCountingOverlay()
                const capture = makeCountingCaptureService()
                const orchestrator = new CaptureOrchestrator({
                    checkPermission: () => mapStatusToResult(status),
                    captureService: capture,
                    overlay,
                    stageCapture: () => {},
                    chatFlow: { handleCapture: () => Promise.resolve() },
                    emitError: () => { }
                })

                orchestrator.handleTrigger()

                // Overlay shown iff granted; triggering never captures by itself.
                expect(overlay.shows).toBe(status === 'granted' ? 1 : 0)
                expect(capture.calls).toBe(0)
            })
        )
    })

    it('the cancel path never invokes the Capture Service, for any prior status', async () => {
        await fc.assert(
            fc.asyncProperty(statusArb, async (status) => {
                const overlay = makeCountingOverlay()
                const capture = makeCountingCaptureService()
                const orchestrator = new CaptureOrchestrator({
                    checkPermission: () => mapStatusToResult(status),
                    captureService: capture,
                    overlay,
                    stageCapture: () => {},
                    chatFlow: { handleCapture: () => Promise.resolve() },
                    emitError: () => { }
                })

                // Trigger then cancel: cancel closes the overlay and produces
                // no capture (Req 4.4).
                orchestrator.handleTrigger()
                orchestrator.handleCancel()

                expect(capture.calls).toBe(0)
                expect(overlay.closes).toBeGreaterThanOrEqual(1)
            })
        )
    })
})
