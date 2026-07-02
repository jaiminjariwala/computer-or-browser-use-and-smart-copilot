/**
 * Action validation (Task 8.2) — PURE, Electron-free.
 *
 * This is a thin BARREL preserving the module's original public surface. The
 * implementation is split for cohesion into the `validate/` folder:
 *
 *  - `known-keys.ts` — the admissible `key` names and the `wait` bound.
 *  - `schema.ts`     — kind check + per-kind parameter schema (`validateAction`).
 *  - `preflight.ts`  — validation + coordinate mapping + the guarded-synthesis
 *                      chokepoint that enforces "validation precedes synthesis".
 *
 * The pipeline runs, in order, BEFORE the Action Executor is ever invoked
 * (Req 5.5, 5.6, 3.7):
 *
 *   1. Kind check       — reject anything outside the fixed Action_Space.
 *   2. Parameter schema — per-kind checks (finite coordinates, string `text`,
 *                         known `keys`, bounded `ms`).
 *   3. Coordinate check — coordinate-bearing Actions require a complete
 *                         Observation and an on-display mapping (see `preflight`).
 *
 * Consumers import from `./validate` exactly as before; nothing about the public
 * API or behavior changed.
 */

export { MAX_WAIT_MS, KNOWN_KEYS, isKnownKey } from './validate/known-keys'
export {
    validateAction,
    type RejectReason,
    type ValidationResult
} from './validate/schema'
export {
    preflightAction,
    guardedSynthesize,
    type PreflightRejection,
    type PreflightReady,
    type PreflightResult,
    type GuardedResult
} from './validate/preflight'
