/**
 * Classification context types (part of Task 10.1, Req 9.1, 9.2).
 *
 * These describe the *signals* the reasoning/perception layers hand to the
 * classifier alongside a candidate Action. None of them is authoritative on its
 * own — {@link ClassificationContext} is deliberately all-optional, because a
 * provider may offer no hint and perception may know nothing about the target.
 * The classifier's fail-closed rule (see `classifier.ts`) exists precisely so
 * that missing/ambiguous signals resolve to High_Risk rather than "ordinary".
 */

// ---------------------------------------------------------------------------
// Model + target signals
// ---------------------------------------------------------------------------

/** The five enumerated High_Risk categories (Req 9.2). */
export type RiskCategory = 'purchase' | 'message' | 'delete' | 'credential' | 'destructive'

/** A coarse risk level a Model_Provider may attach to the Action it emitted. */
export type RiskLevel = 'high' | 'low' | 'unknown'

/**
 * A model-provided risk hint. Both fields are optional: a provider that offers
 * no hint yields `undefined`, which the classifier treats as ambiguous.
 */
export interface ModelRiskHint {
    /** Coarse level; `high` ⇒ High_Risk, `low` ⇒ evidence of ordinariness. */
    level?: RiskLevel
    /** Any enumerated high-risk category the model recognized (Req 9.2). */
    categories?: RiskCategory[]
}

/**
 * Context about what the Action targets, derived from the Observation's
 * accessibility elements and/or the surrounding UI text.
 */
export interface TargetContext {
    /** Accessibility role of the target element, e.g. `button`, `textfield`, `password`. */
    role?: string
    /** Visible label / accessible name of the target control, e.g. "Buy Now". */
    label?: string
    /** True when the target is a secure / password / credential input field. */
    secure?: boolean
    /** Free-form text around the target (form heading, dialog body, etc.). */
    surroundingText?: string
}

/** Optional signals the Safety Controller passes alongside the Action. */
export interface ClassificationContext {
    hint?: ModelRiskHint
    target?: TargetContext
}
