import { desktopCapturer, screen } from 'electron'
import type { Rect, TurnCapture } from '@shared/types'

/**
 * Capture Service (design: "Capture Service", Flow B).
 *
 * Captures the active display via `desktopCapturer.getSources`, crops the
 * returned image to the user-selected {@link Rect}, and produces a base64 PNG
 * data URL plus a downscaled thumbnail for the sidebar (Req 4.3, 4.5).
 *
 * The crop/clamp math is deliberately split out into PURE, Electron-free
 * functions ({@link clampRect}, {@link computeThumbnailSize},
 * {@link cropToCapture}) so it can be unit-tested without launching Electron or
 * touching the screen. {@link CaptureService} is the thin Electron-aware shell
 * that supplies a real screen image to that pure pipeline.
 *
 * Requirements: 4.3, 4.4, 4.5, 4.6
 */

/** The width/height a capture image reports, in pixels. */
export interface ImageSize {
    width: number
    height: number
}

/**
 * The minimal image surface the crop pipeline needs. Electron's `NativeImage`
 * satisfies this structurally, but tests can supply a lightweight fake so the
 * pure logic is exercised without any Electron dependency.
 */
export interface CaptureImage {
    /** The image dimensions in pixels. */
    getSize(): ImageSize
    /** Return a new image cropped to the given (already-clamped) rectangle. */
    crop(rect: Rect): CaptureImage
    /** Return a new image resized to the given dimensions. */
    resize(options: { width?: number; height?: number }): CaptureImage
    /** Encode the image as a base64 data URL (PNG for opaque captures). */
    toDataURL(): string
}

/** The longest edge (in px) a generated sidebar thumbnail may have (Req 2.5). */
export const DEFAULT_MAX_THUMBNAIL_DIMENSION = 240

/** Round to the nearest integer pixel, treating non-finite input as 0. */
function toPixel(value: number): number {
    return Number.isFinite(value) ? Math.round(value) : 0
}

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/**
 * Clamp an arbitrary selection rectangle to the bounds of the captured image
 * (Req 4.3). The result is always a valid, integer-pixel rectangle fully
 * contained within `[0, 0, bounds.width, bounds.height]`:
 *
 *  - Rectangles that extend past an edge are trimmed to that edge.
 *  - Rectangles drawn in any direction (e.g. dragged right-to-left, giving a
 *    negative width) are normalized so width/height are non-negative.
 *  - Rectangles entirely outside the image collapse to a zero-area rectangle on
 *    the nearest edge.
 *
 * Pure and Electron-free so the property tests in task 8.4 can assert the
 * containment/clamping invariants directly.
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

/**
 * Compute the dimensions of a thumbnail that fits within `maxDimension` on its
 * longest edge while preserving the source aspect ratio. Images already within
 * the limit are returned unchanged; zero-area input yields a zero-area result.
 *
 * Pure and Electron-free.
 */
export function computeThumbnailSize(
    width: number,
    height: number,
    maxDimension: number = DEFAULT_MAX_THUMBNAIL_DIMENSION
): ImageSize {
    const w = Math.max(0, toPixel(width))
    const h = Math.max(0, toPixel(height))
    if (w === 0 || h === 0) {
        return { width: 0, height: 0 }
    }
    const longest = Math.max(w, h)
    if (maxDimension <= 0 || longest <= maxDimension) {
        return { width: w, height: h }
    }
    const scale = maxDimension / longest
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale))
    }
}

/** Options controlling how a capture is produced from an image. */
export interface CropOptions {
    /** Longest-edge limit for the generated thumbnail. */
    maxThumbnailDimension?: number
}

/**
 * Crop `image` to `rect` and produce a {@link TurnCapture}: the full-resolution
 * cropped region as a base64 PNG data URL, a downscaled thumbnail data URL, and
 * the clamped rectangle that was actually used (Req 4.3, 4.5).
 *
 * The incoming rect is clamped to the image bounds first (Req 4.3), so a rect
 * that overhangs the screen never reads pixels outside the image. Pure with
 * respect to Electron — it only calls methods on the supplied {@link CaptureImage}.
 */
export function cropToCapture(
    image: CaptureImage,
    rect: Rect,
    options: CropOptions = {}
): TurnCapture {
    const size = image.getSize()
    const clamped = clampRect(rect, size)

    const cropped = image.crop(clamped)
    const dataUrl = cropped.toDataURL()

    const thumbSize = computeThumbnailSize(
        clamped.width,
        clamped.height,
        options.maxThumbnailDimension ?? DEFAULT_MAX_THUMBNAIL_DIMENSION
    )
    const needsResize =
        thumbSize.width > 0 &&
        thumbSize.height > 0 &&
        (thumbSize.width !== clamped.width || thumbSize.height !== clamped.height)
    const thumbnailImage = needsResize
        ? cropped.resize({ width: thumbSize.width, height: thumbSize.height })
        : cropped
    const thumbnailUrl = thumbnailImage.toDataURL()

    return { dataUrl, thumbnailUrl, rect: clamped }
}

/** A display the overlay can be shown on, as reported by Electron's `screen`. */
interface ActiveDisplay {
    id: number
    size: ImageSize
}

/** Injectable seams so the service can be exercised without real Electron APIs. */
export interface CaptureServiceDeps {
    /**
     * Resolve the display the user is capturing on. Defaults to the display
     * nearest the cursor (matching the overlay placement), falling back to the
     * primary display.
     */
    getActiveDisplay?: () => ActiveDisplay
    /**
     * Fetch the available screen sources. Defaults to
     * `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`.
     */
    getSources?: (thumbnailSize: ImageSize) => Promise<
        Array<{ display_id: string; thumbnail: CaptureImage }>
    >
    /** Longest-edge limit for generated thumbnails. */
    maxThumbnailDimension?: number
}

/** Resolve the active display via Electron's `screen` module. */
function defaultGetActiveDisplay(): ActiveDisplay {
    const cursor = screen.getCursorScreenPoint()
    const display =
        screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
    return { id: display.id, size: { width: display.size.width, height: display.size.height } }
}

/** Fetch screen sources via Electron's `desktopCapturer`. */
async function defaultGetSources(
    thumbnailSize: ImageSize
): Promise<Array<{ display_id: string; thumbnail: CaptureImage }>> {
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize
    })
    return sources as unknown as Array<{ display_id: string; thumbnail: CaptureImage }>
}

/**
 * Electron-aware shell around the pure crop pipeline. Captures the active
 * display at its native (logical) resolution so the selection {@link Rect},
 * which is expressed in the overlay's logical display pixels, maps directly
 * onto the captured image before cropping.
 */
export class CaptureService {
    private readonly getActiveDisplay: () => ActiveDisplay
    private readonly getSources: (
        thumbnailSize: ImageSize
    ) => Promise<Array<{ display_id: string; thumbnail: CaptureImage }>>
    private readonly maxThumbnailDimension: number

    constructor(deps: CaptureServiceDeps = {}) {
        this.getActiveDisplay = deps.getActiveDisplay ?? defaultGetActiveDisplay
        this.getSources = deps.getSources ?? defaultGetSources
        this.maxThumbnailDimension =
            deps.maxThumbnailDimension ?? DEFAULT_MAX_THUMBNAIL_DIMENSION
    }

    /**
     * Capture the active display and crop it to `rect`, returning a
     * {@link TurnCapture}. Throws if no screen source is available (the caller
     * surfaces this as a user-facing error rather than producing a capture).
     */
    async captureRegion(rect: Rect): Promise<TurnCapture> {
        const display = this.getActiveDisplay()
        const sources = await this.getSources(display.size)

        if (sources.length === 0) {
            throw new Error('No screen source available for capture')
        }

        const source =
            sources.find((s) => String(s.display_id) === String(display.id)) ??
            sources[0]

        return cropToCapture(source.thumbnail, rect, {
            maxThumbnailDimension: this.maxThumbnailDimension
        })
    }
}
