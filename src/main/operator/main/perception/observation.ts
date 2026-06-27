import type { A11yElement, Observation, Rect } from '@op-shared/types'
import type { CaptureImage } from './capture'

/**
 * Observation assembly + capture geometry (Task 7).
 *
 * The PURE, Electron-free core of the Perception Service: crop-rectangle math and
 * the assembly of an {@link Observation} with the display metadata
 * Coordinate_Mapping needs (Req 2.1, 2.4). Exercised headlessly by the
 * property/unit tests via injected images and display info.
 */

/** The width/height a capture image reports, in pixels. */
export interface ImageSize {
    width: number
    height: number
}

/** Round to the nearest integer pixel, treating non-finite input as 0. */
function toPixel(value: number): number {
    return Number.isFinite(value) ? Math.round(value) : 0
}

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/**
 * Clamp an arbitrary selection rectangle to the bounds of the captured image.
 * The result is always a valid, integer-pixel rectangle fully contained within
 * `[0, 0, bounds.width, bounds.height]`:
 *
 *  - Rectangles that extend past an edge are trimmed to that edge.
 *  - Rectangles drawn in any direction (e.g. a negative width) are normalized so
 *    width/height are non-negative.
 *  - Rectangles entirely outside the image collapse to a zero-area rectangle on
 *    the nearest edge.
 *
 * Pure and Electron-free.
 */
export function clampRect(rect: Rect, bounds: ImageSize): Rect {
    const maxX = Math.max(0, toPixel(bounds.width))
    const maxY = Math.max(0, toPixel(bounds.height))

    // Normalize direction: derive the two opposing corners regardless of sign.
    const rawLeft = toPixel(Math.min(rect.x, rect.x + rect.width))
    const rawTop = toPixel(Math.min(rect.y, rect.y + rect.height))
    const rawRight = toPixel(Math.max(rect.x, rect.x + rect.width))
    const rawBottom = toPixel(Math.max(rect.y, rect.y + rect.height))

    const left = clamp(rawLeft, 0, maxX)
    const top = clamp(rawTop, 0, maxY)
    const right = clamp(rawRight, 0, maxX)
    const bottom = clamp(rawBottom, 0, maxY)

    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
    }
}

/** True iff `bounds` is a fully-known, finite, non-negative rectangle. */
export function isValidBounds(bounds: Rect | undefined): bounds is Rect {
    return (
        !!bounds &&
        Number.isFinite(bounds.x) &&
        Number.isFinite(bounds.y) &&
        Number.isFinite(bounds.width) &&
        Number.isFinite(bounds.height) &&
        bounds.width >= 0 &&
        bounds.height >= 0
    )
}

/** True iff `scaleFactor` is a known, finite, positive backing-store scale. */
export function isValidScaleFactor(scaleFactor: number | undefined): scaleFactor is number {
    return typeof scaleFactor === 'number' && Number.isFinite(scaleFactor) && scaleFactor > 0
}

/** Which region of the screen an Observation captures (Req 2.2, 2.3). */
export type CaptureMode = 'full-screen' | 'active-window'

/**
 * Display metadata resolved for a capture. `bounds`/`scaleFactor` are optional so
 * an incomplete Observation (Req 2.8) can be represented when the OS cannot
 * report them.
 */
export interface DisplayInfo {
    /** The display this capture came from (Req 5.2). */
    id: number
    /** Logical size used to request the capture at logical (point) resolution. */
    size: ImageSize
    /** Logical-point bounds of the source display (Req 2.4); undefined if unknown. */
    bounds?: Rect
    /** Backing-store scale factor, e.g. 2 for Retina (Req 2.4); undefined if unknown. */
    scaleFactor?: number
}

/** The raw, Electron-free inputs from which a pure Observation is assembled. */
export interface RawCapture {
    /** The full-display image (captured at logical resolution). */
    image: CaptureImage
    /** Display id + bounds + scale for Coordinate_Mapping. */
    display: DisplayInfo
    /** Full-screen or active-window (Req 2.2, 2.3). */
    mode: CaptureMode
    /**
     * The active-window rectangle in image (logical) pixels, used to crop when
     * `mode === 'active-window'`. Ignored otherwise; when absent in active-window
     * mode the full display is used.
     */
    activeWindowRect?: Rect
    /** Optional accessibility-tree elements to attach (Req 2.6). */
    a11yElements?: A11yElement[]
}

/**
 * Assemble an {@link Observation} from raw capture inputs — the PURE core of the
 * Perception Service, exercised headlessly by the property/unit tests.
 *
 * Mapping metadata (Req 2.4, 2.5):
 *  - Captures are requested at the display's logical resolution, so image pixels
 *    correspond 1:1 to logical points. For full-screen, `displayBounds` is the
 *    display bounds. For an active-window crop, `displayBounds` is the logical
 *    sub-rectangle of the display the crop covers, so Coordinate_Mapping still
 *    resolves within the region the model actually saw.
 *  - `imageWidth`/`imageHeight` always reflect the pixels of the image handed to
 *    the model (post-crop when cropping).
 *
 * Completeness (Req 2.8): the Observation is `complete` only when BOTH the
 * resulting `displayBounds` and the `scaleFactor` are known and valid; otherwise
 * it is marked incomplete and carries no bounds/scale, so no coordinate-based
 * Action can be derived from it.
 */
export function buildObservation(raw: RawCapture, id: string, capturedAt: string): Observation {
    const { image, display, mode } = raw
    const fullSize = image.getSize()
    const boundsKnown = isValidBounds(display.bounds)
    const scaleKnown = isValidScaleFactor(display.scaleFactor)

    let outImage: CaptureImage = image
    let imageWidth = Math.max(0, toPixel(fullSize.width))
    let imageHeight = Math.max(0, toPixel(fullSize.height))
    let displayBounds: Rect | undefined = boundsKnown ? display.bounds : undefined

    if (mode === 'active-window' && raw.activeWindowRect) {
        const cropped = clampRect(raw.activeWindowRect, fullSize)
        outImage = image.crop(cropped)
        const croppedSize = outImage.getSize()
        imageWidth = Math.max(0, toPixel(croppedSize.width))
        imageHeight = Math.max(0, toPixel(croppedSize.height))
        // Translate the pixel crop into the display's logical point space. Since
        // capture is at logical resolution, the crop offsets are logical points.
        displayBounds = boundsKnown && display.bounds
            ? {
                x: display.bounds.x + cropped.x,
                y: display.bounds.y + cropped.y,
                width: cropped.width,
                height: cropped.height
            }
            : undefined
    }

    const scaleFactor = scaleKnown ? display.scaleFactor : undefined
    const complete = displayBounds !== undefined && scaleFactor !== undefined

    const observation: Observation = {
        id,
        screenshotDataUrl: outImage.toDataURL(),
        imageWidth,
        imageHeight,
        displayId: display.id,
        complete,
        capturedAt
    }
    if (displayBounds !== undefined) {
        observation.displayBounds = displayBounds
    }
    if (scaleFactor !== undefined) {
        observation.scaleFactor = scaleFactor
    }
    if (raw.a11yElements && raw.a11yElements.length > 0) {
        observation.a11yElements = raw.a11yElements
    }
    return observation
}
