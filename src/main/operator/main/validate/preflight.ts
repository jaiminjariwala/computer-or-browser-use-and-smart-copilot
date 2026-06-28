/**
 * Preflight + guarded synthesis (Task 8.2) — PURE, Electron-free.
 *
 * This composes the two pre-synthesis stages that must BOTH complete before any
 * operating-system input event (Req 5.5, 5.6, 3.7, 2.8):
 *
 *   validate (kind + params)  ->  map coordinates (for coordinate-bearing kinds)
 *
 * A malformed/out-of-space Action is refused at the `validation` stage; a
 * coordinate-bearing Action against an incomplete Observation, or targeting
 * off-display, is refused at the `mapping` stage. Non-coordinate Actions skip
 * mapping entirely.
 *
 * {@link guardedSynthesize} is the structural chokepoint that makes "validation
 * precedes any input synthesis" (Property 8) a guarantee rather than a
 * convention: it only ever calls the injected synthesizer AFTER preflight passes,
 * so no malformed or out-of-space Action can reach the OS. The executor (Task 9)
 * wires its real CGEvent synth through this function.
 */

import type { Action, Observation } from '@op-shared/types'
import {
    isCoordinateBearing,
    mapActionCoordinates,
    type MapFailureReason
} from '../coordinate'
import { validateAction, type RejectReason } from './schema'

// ---------------------------------------------------------------------------
// Preflight: validation + coordinate mapping, before any synthesis
// ---------------------------------------------------------------------------

/** A preflight rejection: the stage that refused the Action and why. */
export type PreflightRejection =
    | { ok: false; stage: 'validation'; reason: RejectReason; detail: string }
    | { ok: false; stage: 'mapping'; reason: MapFailureReason; detail: string }

/**
 * A validated-and-mapped Action, ready for input synthesis. `action` carries
 * coordinates already resolved to logical points on the originating display.
 */
export type PreflightReady = { ok: true; action: Action }

export type PreflightResult = PreflightReady | PreflightRejection

/**
 * Run the full pre-synthesis pipeline for a candidate Action:
 *   validate (kind + params)  ->  map coordinates (for coordinate-bearing kinds)
 *
 * Both steps complete BEFORE any OS event. A coordinate-bearing Action against
 * an incomplete Observation, or targeting off-display, is refused at the
 * `mapping` stage; a malformed/out-of-space Action is refused at the
 * `validation` stage. Non-coordinate Actions skip mapping entirely.
 */
export function preflightAction(value: unknown, observation: Observation): PreflightResult {
    const validated = validateAction(value)
    if (!validated.ok) {
        return { ok: false, stage: 'validation', reason: validated.reason, detail: validated.detail }
    }

    if (!isCoordinateBearing(validated.action.kind)) {
        return { ok: true, action: validated.action }
    }

    const mapped = mapActionCoordinates(validated.action, observation)
    if (!mapped.ok) {
        return {
            ok: false,
            stage: 'mapping',
            reason: mapped.reason,
            detail: `Coordinate mapping refused: ${mapped.reason}`
        }
    }
    return { ok: true, action: mapped.action }
}

// ---------------------------------------------------------------------------
// Guarded synthesis — the structural chokepoint (Property 8)
// ---------------------------------------------------------------------------

/** Outcome of a guarded synthesis attempt. */
export type GuardedResult<T> =
    | { executed: true; action: Action; output: T }
    | (PreflightRejection & { executed: false })

/**
 * Invoke `synthesize` for `value` **only after** validation and coordinate
 * mapping both pass. If preflight refuses, `synthesize` is never called and the
 * rejection is returned for the caller to record in the Trajectory.
 *
 * This makes "validation precedes any input synthesis" (Property 8) a
 * structural guarantee rather than a convention: the executor (Task 9) routes
 * its real CGEvent synthesizer through this function, so no malformed or
 * out-of-space Action can reach the OS.
 */
export function guardedSynthesize<T>(
    value: unknown,
    observation: Observation,
    synthesize: (action: Action) => T
): GuardedResult<T> {
    const pre = preflightAction(value, observation)
    if (!pre.ok) {
        return { ...pre, executed: false }
    }
    const output = synthesize(pre.action)
    return { executed: true, action: pre.action, output }
}
