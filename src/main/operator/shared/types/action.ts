/**
 * The typed Action_Space and its runtime guards.
 *
 * Nothing outside the {@link Action} union is executable; the guards here give
 * the executor and validation layers runtime narrowing over that fixed space
 * (Req 5.5, 5.6, 3.7). Also home to the geometry primitives ({@link Point},
 * {@link Rect}) the action + perception models are built on.
 */

/** A 2D point in logical/image coordinate space. */
export type Point = { x: number; y: number }

/** A rectangle in logical points (display bounds). */
export interface Rect {
    x: number
    y: number
    width: number
    height: number
}

/**
 * The fixed, typed Action_Space (Req 5.5, 5.6). Nothing outside this union is
 * executable. The `kind` discriminant drives narrowing and validation.
 */
export type Action =
    | { kind: 'screenshot' }
    | { kind: 'mouse_move'; at: Point }
    | { kind: 'left_click'; at: Point }
    | { kind: 'right_click'; at: Point }
    | { kind: 'double_click'; at: Point }
    | { kind: 'drag'; from: Point; to: Point }
    | { kind: 'type'; text: string }
    | { kind: 'key'; keys: string[] }
    | { kind: 'scroll'; at: Point; dx: number; dy: number }
    | { kind: 'wait'; ms: number }

/** The set of valid Action kinds. */
export type ActionKind = Action['kind']

/** The recorded outcome of attempting an Action (Req 5.4-5.7, 14.5). */
export interface ActionResult {
    status: 'success' | 'failure' | 'blocked' | 'rejected'
    /** failure/blocked/rejected reason. */
    reason?: string
    /** High_Risk_Action classification (Req 9.1). */
    highRisk: boolean
    /**
     * How the environment realized this action: `api` when it used structured
     * DOM control (e.g. a click snapped to a real page element), `vision` when
     * it fell back to raw screen coordinates. Optional; environments that are
     * purely coordinate-based leave it unset. Surfaced live in the UI so the
     * user sees the hybrid engine favoring API over vision where it can.
     */
    mode?: 'api' | 'vision'
    /** Whether explicit user confirmation was obtained (Req 9, 10). */
    confirmed?: boolean
    /** Fresh Observation id captured after the attempt (Req 5.3, 5.7). */
    observationAfterId?: string
    executedAt: string
}

// ---------------------------------------------------------------------------
// Action_Space type guards (runtime narrowing for the executor + validation)
// ---------------------------------------------------------------------------

/** The fixed, ordered Action_Space kinds (Req 5.5, 5.6). */
export const ACTION_KINDS = [
    'screenshot',
    'mouse_move',
    'left_click',
    'right_click',
    'double_click',
    'drag',
    'type',
    'key',
    'scroll',
    'wait'
] as const

/** True iff `value` is a kind inside the Action_Space (rejects everything else). */
export function isActionKind(value: unknown): value is ActionKind {
    return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function isPoint(value: unknown): value is Point {
    if (typeof value !== 'object' || value === null) return false
    const p = value as Record<string, unknown>
    return isFiniteNumber(p.x) && isFiniteNumber(p.y)
}

/**
 * Structural type guard for a well-formed {@link Action}. Narrows the
 * discriminated union and rejects any kind outside the Action_Space as well as
 * any in-space kind with malformed parameters (Req 5.5, 5.6, 3.7).
 */
export function isAction(value: unknown): value is Action {
    if (typeof value !== 'object' || value === null) return false
    const a = value as Record<string, unknown>
    if (!isActionKind(a.kind)) return false
    switch (a.kind) {
        case 'screenshot':
            return true
        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click':
            return isPoint(a.at)
        case 'drag':
            return isPoint(a.from) && isPoint(a.to)
        case 'type':
            return typeof a.text === 'string'
        case 'key':
            return Array.isArray(a.keys) && a.keys.every((k) => typeof k === 'string')
        case 'scroll':
            return isPoint(a.at) && isFiniteNumber(a.dx) && isFiniteNumber(a.dy)
        case 'wait':
            return isFiniteNumber(a.ms)
        default:
            return false
    }
}
