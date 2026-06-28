/**
 * Action schema validation (Task 8.2) — PURE, Electron-free.
 *
 * This is steps 1–2 of the pre-synthesis pipeline (the coordinate step lives in
 * `preflight.ts`):
 *
 *   1. Kind check       — reject anything outside the fixed Action_Space (Req 5.5).
 *   2. Parameter schema — per-kind checks: finite {x,y} points, string `text`,
 *                         known `keys`, bounded `ms` (Req 5.6).
 *
 * A failure here is a **reject-before-input**: the Action is malformed or out of
 * the Action_Space and must never reach input synthesis. That is distinct from a
 * *valid* Action that later fails at execution time (the executor's concern).
 */

import type { Action, ActionKind, Point } from '@op-shared/types'
import { isActionKind } from '@op-shared/types'
import { isKnownKey, MAX_WAIT_MS } from './known-keys'

// ---------------------------------------------------------------------------
// Validation outcome
// ---------------------------------------------------------------------------

/** Why an Action was rejected before any OS input event (Req 5.5, 5.6). */
export type RejectReason =
    | 'not-an-object'
    | 'unknown-kind'
    | 'invalid-parameters'
    | 'unknown-key'
    | 'wait-out-of-range'

/** The result of validating a candidate Action against the Action_Space. */
export type ValidationResult =
    | { ok: true; action: Action }
    | { ok: false; reason: RejectReason; detail: string }

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function isFinitePoint(value: unknown): value is Point {
    if (typeof value !== 'object' || value === null) return false
    const p = value as Record<string, unknown>
    return isFiniteNumber(p.x) && isFiniteNumber(p.y)
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/**
 * Validate a candidate Action: kind check + per-kind parameter schema checks.
 * Returns the narrowed {@link Action} on success, or a typed rejection with a
 * human-readable detail on failure. No OS event is ever produced here.
 */
export function validateAction(value: unknown): ValidationResult {
    if (typeof value !== 'object' || value === null) {
        return { ok: false, reason: 'not-an-object', detail: 'Action must be an object' }
    }
    const a = value as Record<string, unknown>

    // 1. Kind check — reject anything outside the Action_Space (Req 5.5).
    if (!isActionKind(a.kind)) {
        return {
            ok: false,
            reason: 'unknown-kind',
            detail: `Kind "${String(a.kind)}" is outside the Action_Space`
        }
    }
    const kind: ActionKind = a.kind

    // 2. Per-kind parameter schema checks (Req 5.6).
    switch (kind) {
        case 'screenshot':
            return { ok: true, action: { kind } }

        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click':
            if (!isFinitePoint(a.at)) {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: `${kind} requires a finite {x,y} point`
                }
            }
            return { ok: true, action: { kind, at: { x: a.at.x, y: a.at.y } } }

        case 'drag':
            if (!isFinitePoint(a.from) || !isFinitePoint(a.to)) {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: 'drag requires finite {from} and {to} points'
                }
            }
            return {
                ok: true,
                action: {
                    kind,
                    from: { x: a.from.x, y: a.from.y },
                    to: { x: a.to.x, y: a.to.y }
                }
            }

        case 'type':
            if (typeof a.text !== 'string') {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: 'type requires a string `text`'
                }
            }
            return { ok: true, action: { kind, text: a.text } }

        case 'key':
            if (!Array.isArray(a.keys) || a.keys.length === 0) {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: 'key requires a non-empty `keys` array'
                }
            }
            for (const k of a.keys) {
                if (!isKnownKey(k)) {
                    return {
                        ok: false,
                        reason: 'unknown-key',
                        detail: `Unknown key "${String(k)}"`
                    }
                }
            }
            return { ok: true, action: { kind, keys: a.keys as string[] } }

        case 'scroll':
            if (!isFinitePoint(a.at) || !isFiniteNumber(a.dx) || !isFiniteNumber(a.dy)) {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: 'scroll requires a finite {x,y} point and finite dx/dy'
                }
            }
            return { ok: true, action: { kind, at: { x: a.at.x, y: a.at.y }, dx: a.dx, dy: a.dy } }

        case 'wait':
            if (!isFiniteNumber(a.ms)) {
                return {
                    ok: false,
                    reason: 'invalid-parameters',
                    detail: 'wait requires a finite `ms`'
                }
            }
            if (a.ms < 0 || a.ms > MAX_WAIT_MS) {
                return {
                    ok: false,
                    reason: 'wait-out-of-range',
                    detail: `wait ms must be within [0, ${MAX_WAIT_MS}]`
                }
            }
            return { ok: true, action: { kind, ms: a.ms } }

        default: {
            // Exhaustiveness guard: any unhandled kind fails closed.
            const _never: never = kind
            void _never
            return { ok: false, reason: 'unknown-kind', detail: 'Unhandled Action kind' }
        }
    }
}
