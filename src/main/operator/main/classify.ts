/**
 * High_Risk_Action classification (Task 10.1, Req 9.1, 9.2) — realizes Property 3.
 *
 * This is a thin BARREL that preserves the module's original public surface.
 * The implementation is split for cohesion into the `classify/` folder:
 *
 *  - `context.ts`    — the classification context types (model hint + target).
 *  - `rules.ts`      — the high-risk detectors (lexicon, keystrokes, hints).
 *  - `classifier.ts` — the total, fail-closed `classifyHighRisk` decision.
 *
 * Consumers (the Safety gate, the loop) import from `./classify` exactly as
 * before; nothing about the public API or behavior changed. See `classifier.ts`
 * for the "ambiguity ⇒ High_Risk" fail-closed rule that anchors Property 3.
 */

export type {
    RiskCategory,
    RiskLevel,
    ModelRiskHint,
    TargetContext,
    ClassificationContext
} from './classify/context'
export { NON_COMMITTING_KINDS } from './classify/rules'
export { classifyHighRisk } from './classify/classifier'
