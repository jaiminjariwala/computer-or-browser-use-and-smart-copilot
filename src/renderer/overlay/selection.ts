import type { Rect } from '@shared/types'

/**
 * Pure geometry for the Overlay_Window's rectangular region selection (Req 4.2).
 *
 * The overlay tracks a drag from a start point to a current point. These
 * helpers turn that pair of points into a normalized {@link Rect} (always
 * non-negative width/height regardless of drag direction) and decide whether a
 * selection is large enough to submit. Kept free of React/DOM so the math can
 * be unit-tested directly.
 */

/** A point in overlay-local pixels. */
export interface Point {
    x: number
    y: number
}

/**
 * Minimum width/height (px) for a selection to count as a deliberate drag
 * rather than an accidental click. Below this the selection is ignored.
 */
export const MIN_SELECTION_SIZE = 4

/**
 * Build a normalized {@link Rect} from the drag start and current points.
 *
 * The origin is the top-left-most corner and width/height are absolute, so a
 * drag in any of the four directions yields the same rectangle. Coordinates are
 * floored / sizes rounded to whole pixels so the emitted rect maps cleanly onto
 * pixel bounds for the later crop step.
 */
export function rectFromPoints(start: Point, current: Point): Rect {
    const x = Math.min(start.x, current.x)
    const y = Math.min(start.y, current.y)
    const width = Math.abs(start.x - current.x)
    const height = Math.abs(start.y - current.y)
    return {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.round(width),
        height: Math.round(height)
    }
}

/**
 * Whether a selection is large enough to submit (Req 4.3). A tiny rectangle —
 * e.g. a stray click — is not a meaningful region and should be ignored rather
 * than producing an empty capture.
 */
export function isValidSelection(rect: Rect, min: number = MIN_SELECTION_SIZE): boolean {
    return rect.width >= min && rect.height >= min
}

/**
 * Build the bounding-box {@link Rect} of a freehand path (the points the user
 * drew). The captured region is the smallest rectangle containing the drawn
 * loop, so circling something automatically captures that area (Req 4.3).
 */
export function boundsFromPoints(points: Point[]): Rect {
    if (points.length === 0) {
        return { x: 0, y: 0, width: 0, height: 0 }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
    }
    return {
        x: Math.floor(minX),
        y: Math.floor(minY),
        width: Math.round(maxX - minX),
        height: Math.round(maxY - minY)
    }
}
