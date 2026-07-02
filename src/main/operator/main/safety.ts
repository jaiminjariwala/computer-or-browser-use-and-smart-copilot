/**
 * Safety / Kill-Switch Controller (Task 11) — the single fail-closed gate.
 *
 * This is a thin BARREL preserving the module's original public surface. The
 * implementation is split for cohesion into the `safety/` folder:
 *
 *  - `autonomy.ts`   — autonomy + confirmation rules (clause 8): when a
 *                      Confirmation is required and when it is satisfied. An
 *                      Action is only ever `approved` by an explicit affirmative
 *                      decision — never by timeout or implied consent.
 *  - `gate.ts`       — the PURE fail-closed gate: `allow` iff ALL eight
 *                      preconditions hold simultaneously, else `blocked(reason)`.
 *                      This is the ONE chokepoint; the loop reaches the Executor
 *                      only through it.
 *  - `controller.ts` — the stateful `SafetyController` that owns the
 *                      Emergency_Stop flag, the Control_Indicator visibility, and
 *                      the global hotkey registration, and merges them into the
 *                      pure gate via `evaluate`.
 *
 * Consumers (the loop, windows, index) import from `./safety` exactly as before;
 * nothing about the public API or behavior changed. See `gate.ts` for the eight
 * simultaneous preconditions and why "no action unless safe" is structural.
 */

export type { ConfirmationState } from './safety/autonomy'
export { confirmationRequired, confirmationSatisfied } from './safety/autonomy'
export {
    ACTING_LEGAL_STATES,
    isActingLegalState,
    gate,
    blockedActionResult,
    type BlockReason,
    type GateContext,
    type GateAllow,
    type GateBlocked,
    type GateDecision
} from './safety/gate'
export {
    SafetyController,
    createSafetyController,
    type ExternalGateInputs,
    type SafetyControllerDeps
} from './safety/controller'
