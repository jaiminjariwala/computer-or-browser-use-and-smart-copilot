/**
 * High_Risk_Action classification core (Task 10.1, Req 9.1, 9.2) — Property 3.
 *
 * {@link classifyHighRisk} is a **TOTAL, pure** function: for EVERY Action in
 * the fixed Action_Space (and any classification context) it returns a boolean.
 * It runs BEFORE execution and is Electron-free, so the Safety Controller can
 * call it on every selected Action (Req 9.1).
 *
 * The design mandates (Req 9.2) that any Action which submits a purchase/payment,
 * sends a message/email, deletes or overwrites data, enters/submits credentials,
 * or performs a destructive system/shell operation is classified High_Risk — and,
 * crucially, that **ambiguity resolves to High_Risk (fail-closed)**: when a
 * side-effecting Action cannot be positively shown to be ordinary, it is High_Risk.
 *
 * The evidence detectors live in `rules.ts`; this module is only the decision
 * procedure that combines them. Actions split into two structural classes:
 *
 *  - **Non-committing kinds** (`screenshot`, `mouse_move`, `scroll`, `wait`)
 *    cannot commit/send/delete/authenticate/destroy by themselves. Ordinary
 *    unless the model explicitly flags them High_Risk.
 *  - **Committing kinds** (clicks, `drag`, `type`, `key`) CAN trigger an
 *    enumerated category depending on what they land on. They demand positive
 *    evidence of ordinariness (an explicit `low` hint with nothing high-risk in
 *    target or parameters). Absent that — no hint, `unknown` hint, or any
 *    high-risk signal — the Action is ambiguous and therefore High_Risk.
 */

import type { Action } from '@op-shared/types'
import type { ClassificationContext } from './context'
import {
    hintSaysHigh,
    hintSaysLow,
    isDestructiveKeyCombo,
    isNonCommitting,
    matchesHighRiskLexicon,
    textSignals
} from './rules'

/**
 * Classify an Action as High_Risk (`true`) or ordinary (`false`) BEFORE
 * execution. Total and pure: defined for every Action in the Action_Space and
 * every context, with ambiguity resolved to High_Risk (Req 9.1, 9.2).
 *
 * @param action  the selected Action (from the fixed Action_Space)
 * @param context optional model risk hint + target context signals
 * @returns `true` if the Action is High_Risk, `false` if ordinary
 */
export function classifyHighRisk(
    action: Action,
    context: ClassificationContext = {}
): boolean {
    // 1. An explicit model high-risk signal always wins, for any kind.
    if (hintSaysHigh(context.hint)) return true

    // Guard against an unrecognized/undefined kind (defensive totality):
    // anything we cannot reason about is fail-closed to High_Risk.
    const kind = action?.kind
    if (typeof kind !== 'string') return true

    // 2. Non-committing kinds cannot trigger an enumerated high-risk category
    //    by themselves, and no high-risk hint was given ⇒ ordinary.
    if (isNonCommitting(kind)) return false

    // 3. Committing kinds (clicks, drag, type, key): look for high-risk signals.

    //    3a. A secure / password / credential target ⇒ credential entry.
    const target = context.target
    if (target?.secure === true) return true
    if (target?.role && /pass(word|code)|secure|credential/i.test(target.role)) return true

    //    3b. High-risk lexicon anywhere in label / surrounding text / typed text.
    for (const signal of textSignals(action, context)) {
        if (matchesHighRiskLexicon(signal)) return true
    }

    //    3c. Destructive key combinations (e.g. ⌘+Delete).
    if (kind === 'key' && isDestructiveKeyCombo(action.keys)) return true

    // 4. No high-risk signal found. Only a positive `low` hint (with no
    //    contradicting category) is enough to call a committing Action ordinary.
    if (hintSaysLow(context.hint)) return false

    // 5. Otherwise the risk cannot be positively determined ordinary ⇒
    //    ambiguity resolves to High_Risk (fail-closed, Req 9.2).
    return true
}
