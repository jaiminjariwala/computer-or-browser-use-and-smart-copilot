/**
 * Derived reasoning context + outcomes and the reasoning-router contract.
 *
 * The bounded {@link ReasoningContext} sent to a Model_Provider per step (never
 * the full Trajectory), the single typed {@link ReasoningOutcome} parsed back,
 * its provider-tagged {@link RoutedOutcome}, and the {@link ReasoningRouter}
 * the loop calls over the Provider_Chain (Req 3, 4, 21).
 */

import type { Action } from './action'
import type { Observation, TokenUsage, TrajectoryStep, TrajectorySummary } from './trajectory'

/**
 * A compact, sanitized lesson recalled from a related completed session.
 *
 * Memories are derived from local session archives and intentionally exclude
 * screenshots, raw observations, typed text, provider credentials, and full
 * trajectories. They are optional hints only; the current screen and goal stay
 * authoritative.
 */
export interface PriorSessionMemory {
    goalText: string
    inferredProgress: string
    completedSubSteps: string[]
    updatedAt: string
}

/**
 * The bounded context sent to a Model_Provider on each Reasoning_Step. This is
 * derived, not stored, and never includes the full Trajectory (Req 3.5, 4.3).
 */
export interface ReasoningContext {
    goal: string
    /** Condensed older history. */
    summary: TrajectorySummary
    /** Last K steps only — never the full trajectory (Req 3.5, 4.3). */
    recentSteps: TrajectoryStep[]
    /** Related successful-session summaries recalled from the local archive. */
    priorMemories?: PriorSessionMemory[]
    currentObservation: Observation
    /**
     * A short description of the Execution_Environment the agent is operating
     * (e.g. macOS desktop vs sandboxed Linux vs a browser), folded into the
     * system prompt so the agent reasons with the right conventions (Req 22).
     */
    environmentHint?: string
    /** User guidance/answers given mid-session, folded into the prompt. */
    guidance?: string[]
}

/** Exactly one typed outcome parsed from a Model_Provider response (Req 3.2). */
export type ReasoningOutcome =
    | { kind: 'action'; action: Action; rationale: string }
    | {
        kind: 'completion'
        summary: string
        /**
         * The model's verbatim quote from the current observation backing the
         * claim (page text / title / URL). The loop's evidence gate rejects a
         * completion whose quote does not appear in the live observation.
         */
        evidence?: string
    }
    | { kind: 'help'; question: string }
    | { kind: 'failure'; reason: string }

/**
 * A {@link ReasoningOutcome} optionally annotated with the observability metadata
 * of the model call that produced it: the concrete model id and reported token
 * usage. A concrete {@link ModelProvider} returns this; the router then adds the
 * serving `providerId` to make a {@link RoutedOutcome}.
 */
export type ObservedOutcome = ReasoningOutcome & {
    /** The concrete model id that produced this outcome. */
    model?: string
    /** Token usage the provider reported for this call. */
    usage?: TokenUsage
}

/**
 * A {@link ReasoningOutcome} plus which Model_Provider served it (Req 21.9) and
 * the observability metadata (model id + token usage). When every provider is
 * unavailable/fails, `providerId` is null and the outcome is a failure (Req 21.5).
 */
export type RoutedOutcome = ObservedOutcome & { providerId: string | null }

/** The reasoning entry point used by the loop: a router over the Provider_Chain. */
export interface ReasoningRouter {
    /** Tries providers in order, uses the first that succeeds, only fails when all fail. */
    reason(ctx: ReasoningContext): Promise<RoutedOutcome>
    summarize(steps: TrajectoryStep[], prev: TrajectorySummary): Promise<TrajectorySummary>
}
