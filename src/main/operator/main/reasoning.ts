import type {
    ModelProvider,
    ReasoningContext,
    ReasoningRouter,
    RoutedOutcome,
    TrajectoryStep,
    TrajectorySummary
} from '@op-shared/types'

/**
 * Reasoning Layer — the ProviderChain router (Task 6.3).
 *
 * The router sits in front of one-of-N {@link ModelProvider} implementations
 * and is the reasoning entry point the Agent Loop uses. On each Reasoning_Step
 * it tries providers in the user-configured order, uses the outcome of the
 * FIRST provider that succeeds, and falls back to the next on unavailability or
 * failure (Req 21.3, 21.4). Only when EVERY provider is unavailable or fails is
 * the step treated as failed — in which case it surfaces `all-providers-failed`,
 * pauses (the loop reacts to the failure outcome), and retains the Trajectory,
 * with the recorded serving `providerId` set to null (Req 21.5, 21.9).
 *
 * The router records which provider served each step by stamping the
 * {@link RoutedOutcome} with `providerId` — the id of the first provider that
 * succeeded, or null when all fail.
 *
 * "Success" here means the provider produced a usable outcome (an Action, a
 * completion, or a help signal). A reachable provider that returns a
 * `failure` outcome (e.g. an unparseable response, Req 3.4) is treated like any
 * other provider failure for fallback purposes; if it is the LAST usable
 * provider, its failure becomes the step's failure. This realizes Property 27.
 */

/** Options controlling how the router assembles/condenses context. */
export interface ProviderChainRouterOptions {
    /**
     * Optional summarizer used by {@link ReasoningRouter.summarize}. When
     * absent, `summarize` returns the previous summary unchanged (a no-op fold),
     * so the router is usable before the Summarizer (Task 12.4) is wired in.
     */
    summarizer?: (steps: TrajectoryStep[], prev: TrajectorySummary) => Promise<TrajectorySummary>
}

/**
 * A ProviderChain router over an ordered list of {@link ModelProvider}s. The
 * order of `providers` IS the Provider_Chain order (primary first, then
 * fallbacks); callers construct it from the stored chain.
 */
export class ProviderChainRouter implements ReasoningRouter {
    private readonly providers: readonly ModelProvider[]
    private readonly summarizer?: ProviderChainRouterOptions['summarizer']

    constructor(providers: readonly ModelProvider[], options: ProviderChainRouterOptions = {}) {
        this.providers = providers
        this.summarizer = options.summarizer
    }

    /**
     * Try providers in order and return the first usable {@link RoutedOutcome}.
     * Falls back on unavailability, thrown transport errors, or a returned
     * `failure` outcome; only fails the step when the whole chain is exhausted.
     */
    async reason(ctx: ReasoningContext): Promise<RoutedOutcome> {
        if (this.providers.length === 0) {
            return {
                kind: 'failure',
                reason: 'all-providers-failed: no model provider is configured.',
                providerId: null
            }
        }

        const reasons: string[] = []
        for (const provider of this.providers) {
            try {
                if (!(await provider.isAvailable())) {
                    reasons.push(`${provider.id}: unavailable`)
                    continue
                }
                const outcome = await provider.reason(ctx)
                if (outcome.kind === 'failure') {
                    reasons.push(`${provider.id}: ${outcome.reason}`)
                    continue
                }
                // First success — stamp the serving provider id (Req 21.9).
                return { ...outcome, providerId: provider.id }
            } catch (err) {
                reasons.push(`${provider.id}: ${errorMessage(err)}`)
                continue
            }
        }

        // Every provider was unavailable or failed (Req 21.5).
        return {
            kind: 'failure',
            reason: `all-providers-failed: ${reasons.join('; ')}`,
            providerId: null
        }
    }

    /**
     * Fold older Trajectory steps into the running {@link TrajectorySummary}.
     * Delegates to the injected summarizer when present; otherwise returns the
     * prior summary unchanged (Task 12.4 supplies the real fold).
     */
    async summarize(
        steps: TrajectoryStep[],
        prev: TrajectorySummary
    ): Promise<TrajectorySummary> {
        if (this.summarizer) return this.summarizer(steps, prev)
        return prev
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof Error && err.message.trim().length > 0) return err.message.trim()
    if (typeof err === 'string' && err.trim().length > 0) return err.trim()
    return 'request failed'
}
