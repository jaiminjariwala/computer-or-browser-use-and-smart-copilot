import type { Action, Observation, Point, Rect } from '@op-shared/types'

/**
 * Coordinate_Mapping (Task 8.1) — PURE, Electron-free.
 *
 * Part of the fail-closed safety core: this module sits on the validation side
 * of "validate-before-synthesis", feeding `validate/preflight.ts` so that no
 * coordinate-based Action reaches input synthesis unless it maps onto a real
 * point of the originating display.
 *
 * The reasoning model emits coordinates in **image space** (the pixel space of
 * the screenshot it was shown). Physical macOS input events are posted in the
 * source display's **logical point space**. This module performs that mapping
 * for the display identified in the *originating* Observation, so multi-display
 * coordinates can never leak onto the wrong screen (Req 5.2).
 *
 * Algorithm (from the design's "Coordinate Mapping" section):
 *
 *   Given an Observation with imageWidth/imageHeight, displayBounds {x,y,w,h}
 *   and scaleFactor, for a model coordinate (mx, my) in image space:
 *
 *     nx = mx / imageWidth            // normalize to [0,1]
 *     ny = my / imageHeight
 *     px = displayBounds.x + nx * displayBounds.width    // logical point
 *     py = displayBounds.y + ny * displayBounds.height
 *     clamp (px, py) into the display bounds
 *
 * Rules enforced here:
 *  - An incomplete Observation (missing/invalid displayBounds or scaleFactor)
 *    refuses ALL coordinate-based Actions — nothing derived from it may execute
 *    (Req 2.8).
 *  - A pre-clamp target that falls outside the originating display (i.e. the
 *    normalized coordinate is outside [0,1], so the model clearly targeted
 *    off-screen) is a **validation failure**, not a silently clamped click
 *    (Req 5.4). Only sub-pixel/edge overshoot from finite arithmetic is clamped.
 *
 * This module never touches Electron or the OS; the executor (Task 9) applies
 * the result to synthesize a real event.
 */

// ---------------------------------------------------------------------------
// Validity helpers (mirrors perception.ts, kept local so this module is pure)
// ---------------------------------------------------------------------------

/** True iff `bounds` is a fully-known, finite, non-negative rectangle. */
export function hasValidBounds(bounds: Rect | undefined): bounds is Rect {
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
export function hasValidScaleFactor(scaleFactor: number | undefined): scaleFactor is number {
    return typeof scaleFactor === 'number' && Number.isFinite(scaleFactor) && scaleFactor > 0
}

/**
 * True iff an Observation is complete enough to derive coordinate-based Actions:
 * it must be flagged `complete` AND actually carry valid bounds + scale (Req
 * 2.8). Both are checked so a mislabelled Observation still fails closed.
 */
export function isObservationMappable(observation: Observation): boolean {
    return (
        observation.complete === true &&
        hasValidBounds(observation.displayBounds) &&
        hasValidScaleFactor(observation.scaleFactor)
    )
}

// ---------------------------------------------------------------------------
// Point mapping
// ---------------------------------------------------------------------------

/** Reasons a coordinate mapping can be refused (recorded as a failure). */
export type MapFailureReason = 'incomplete-observation' | 'off-display' | 'invalid-coordinate'

/** The result of mapping a single image-space point into logical points. */
export type MapPointResult =
    | { ok: true; point: Point }
    | { ok: false; reason: MapFailureReason }

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/**
 * Map one image-space coordinate onto a logical point on the display identified
 * in `observation`.
 *
 *  - Refuses with `incomplete-observation` when the Observation lacks valid
 *    bounds/scale (Req 2.8).
 *  - Refuses with `invalid-coordinate` when the model coordinate is not finite.
 *  - Refuses with `off-display` when the normalized coordinate falls outside
 *    [0,1] — the model targeted a point outside the originating display, which
 *    is a validation failure rather than a silently clamped click (Req 5.4).
 *  - Otherwise returns the logical point, clamped into the display bounds to
 *    absorb finite-arithmetic overshoot at the far edge.
 */
export function mapImagePointToDisplay(point: Point, observation: Observation): MapPointResult {
    if (!isObservationMappable(observation)) {
        return { ok: false, reason: 'incomplete-observation' }
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return { ok: false, reason: 'invalid-coordinate' }
    }

    const bounds = observation.displayBounds as Rect
    const { imageWidth, imageHeight } = observation

    // A zero/negative image dimension cannot define an image space to map from.
    if (!(imageWidth > 0) || !(imageHeight > 0)) {
        return { ok: false, reason: 'incomplete-observation' }
    }

    const nx = point.x / imageWidth
    const ny = point.y / imageHeight

    // Pre-clamp: a normalized coordinate outside [0,1] is off the originating
    // display -> validation failure, not a clamped click (Req 5.4).
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
        return { ok: false, reason: 'off-display' }
    }

    const px = bounds.x + nx * bounds.width
    const py = bounds.y + ny * bounds.height

    return {
        ok: true,
        point: {
            x: clamp(px, bounds.x, bounds.x + bounds.width),
            y: clamp(py, bounds.y, bounds.y + bounds.height)
        }
    }
}

// ---------------------------------------------------------------------------
// Action mapping
// ---------------------------------------------------------------------------

/** Action kinds that carry one or more image-space coordinates. */
export const COORDINATE_BEARING_KINDS = [
    'mouse_move',
    'left_click',
    'right_click',
    'double_click',
    'drag',
    'scroll'
] as const

/** True iff an Action of this kind carries coordinates requiring mapping. */
export function isCoordinateBearing(kind: Action['kind']): boolean {
    return (COORDINATE_BEARING_KINDS as readonly string[]).includes(kind)
}

/** The result of mapping a whole Action's coordinates into logical points. */
export type MapActionResult =
    | { ok: true; action: Action }
    | { ok: false; reason: MapFailureReason }

/**
 * Map every image-space coordinate in `action` onto logical points on the
 * originating display, returning a new Action with mapped coordinates.
 *
 * Non-coordinate Actions (`screenshot`, `type`, `key`, `wait`) pass through
 * unchanged and never depend on Observation completeness. Coordinate-bearing
 * Actions refuse (fail closed) on any incomplete Observation or off-display
 * target, so no coordinate-based Action derived from an incomplete Observation
 * can be executed (Req 2.8, 5.2).
 */
export function mapActionCoordinates(action: Action, observation: Observation): MapActionResult {
    switch (action.kind) {
        case 'screenshot':
        case 'type':
        case 'key':
        case 'wait':
            return { ok: true, action }
        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click': {
            const mapped = mapImagePointToDisplay(action.at, observation)
            if (!mapped.ok) return { ok: false, reason: mapped.reason }
            return { ok: true, action: { ...action, at: mapped.point } }
        }
        case 'scroll': {
            const mapped = mapImagePointToDisplay(action.at, observation)
            if (!mapped.ok) return { ok: false, reason: mapped.reason }
            return { ok: true, action: { ...action, at: mapped.point } }
        }
        case 'drag': {
            const from = mapImagePointToDisplay(action.from, observation)
            if (!from.ok) return { ok: false, reason: from.reason }
            const to = mapImagePointToDisplay(action.to, observation)
            if (!to.ok) return { ok: false, reason: to.reason }
            return { ok: true, action: { ...action, from: from.point, to: to.point } }
        }
        default: {
            // Exhaustiveness guard: any unhandled kind fails closed.
            const _never: never = action
            void _never
            return { ok: false, reason: 'invalid-coordinate' }
        }
    }
}
