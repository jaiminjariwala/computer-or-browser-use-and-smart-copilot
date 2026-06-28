/**
 * Autonomy + confirmation rules (part of Task 11) — pure, Electron-free.
 *
 * These functions answer clause 8 of the fail-closed gate: "has high-risk /
 * manual confirmation been satisfied?" (see `gate.ts`). There is deliberately
 * NO UI here — the Console renderer collects the user's decision and the loop
 * records it as a {@link ConfirmationState}; this module only decides whether a
 * decision is *required* and, if so, whether it has been *satisfied*.
 */

import type { AutonomyLevel } from '@op-shared/types'

/**
 * The confirmation state the loop sets for a proposed Action:
 *
 *  - `approved`  — an explicit, affirmative user decision to allow this Action.
 *  - `declined`  — the user explicitly refused this Action (Req 9.4, 10.5).
 *  - `pending`   — no explicit decision yet (the initial state, and the state on
 *                  a timeout / no response). NEVER treated as consent (Req 10.2).
 *
 * Confirmation is only ever `approved` through an explicit affirmative action;
 * neither a timeout nor the absence of a response ever produces `approved`, so
 * "no execution on implied consent or timeout" (Property 5) holds by construction.
 */
export type ConfirmationState = 'approved' | 'declined' | 'pending'

/**
 * Whether Confirmation is required before executing an Action (Property 2).
 *
 * The three Autonomy_Levels are now sharply distinct:
 *   - **Manual** → every Action requires Confirmation.
 *   - **Supervised** → ordinary Actions run automatically; High_Risk Actions
 *     require Confirmation.
 *   - **Autonomous** → fully automatic: NOTHING requires Confirmation, including
 *     High_Risk Actions. (Intended for the sandboxed browser/desktop, where the
 *     blast radius is contained and the user wants hands-off execution.)
 */
export function confirmationRequired(autonomy: AutonomyLevel, highRisk: boolean): boolean {
    if (autonomy === 'autonomous') return false
    if (autonomy === 'manual') return true
    return highRisk
}

/**
 * Whether the confirmation clause of the gate is satisfied (clause 8).
 *
 * When Confirmation is required, it is satisfied ONLY by an explicit `approved`
 * decision (Req 10.1, 10.2). When Confirmation is not required (ordinary Action
 * under Supervised/Autonomous), the clause is trivially satisfied.
 */
export function confirmationSatisfied(
    autonomy: AutonomyLevel,
    highRisk: boolean,
    confirmation: ConfirmationState
): boolean {
    if (!confirmationRequired(autonomy, highRisk)) return true
    return confirmation === 'approved'
}
