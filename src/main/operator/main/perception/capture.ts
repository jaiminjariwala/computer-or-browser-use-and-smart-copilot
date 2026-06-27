import { desktopCapturer, screen } from 'electron'
import type { Rect } from '@op-shared/types'
import type { DisplayInfo, ImageSize } from './observation'

/**
 * Electron capture seams (Task 7).
 *
 * The only Electron-aware corner of the Perception Service: the `NativeImage`-
 * shaped surface the pipeline needs (crop/scale/encode) plus the default
 * `screen`/`desktopCapturer` implementations. Everything downstream
 * ({@link buildObservation} and the pure geometry) is Electron-free and takes
 * these as injected seams so tests can swap in a lightweight fake image and
 * headless display info.
 */

/**
 * The minimal image surface the perception pipeline needs. Electron's
 * `NativeImage` satisfies this structurally; tests supply a lightweight fake so
 * the pure logic runs without any Electron dependency.
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

/** Resolve the active display via Electron's `screen` module. */
export function defaultGetActiveDisplay(): DisplayInfo {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
    return {
        id: display.id,
        size: { width: display.size.width, height: display.size.height },
        bounds: {
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height
        },
        scaleFactor: display.scaleFactor
    }
}

/** Fetch screen sources via Electron's `desktopCapturer`. */
export async function defaultGetSources(
    thumbnailSize: ImageSize
): Promise<Array<{ display_id: string; thumbnail: CaptureImage }>> {
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize
    })
    return sources as unknown as Array<{ display_id: string; thumbnail: CaptureImage }>
}
