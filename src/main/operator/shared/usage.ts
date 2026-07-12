import type { TokenUsage, TrajectoryStepView } from './types'

/**
 * Token-usage aggregation + cost estimation (observability) — PURE.
 *
 * The Trajectory records per-step {@link TokenUsage}; these helpers sum it across
 * a run and estimate a rough USD cost from a small, clearly-labelled pricing
 * table. Everything here is pure so it can be used from both the main process
 * (session views) and the renderer (activity log) and unit-tested in-memory.
 */

/** A zeroed usage total (identity for {@link addUsage}). */
export function emptyUsage(): TokenUsage {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

/** Add two usage records field-by-field. Pure; neither input is mutated. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens
    }
}

/** Whether a usage record carries any tokens at all. */
export function hasUsage(usage: TokenUsage | undefined): usage is TokenUsage {
    return (
        usage !== undefined &&
        (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0)
    )
}

/**
 * Sum the per-step token usage across a trajectory (stored steps or their
 * renderer views), or `undefined` when no step reported any usage — so the UI
 * can distinguish "0 tokens" (nothing reported) from a real total.
 */
export function sumUsage(
    steps: ReadonlyArray<{ reasoning: { usage?: TokenUsage } } | TrajectoryStepView>
): TokenUsage | undefined {
    let total = emptyUsage()
    let seen = false
    for (const step of steps) {
        const usage = 'reasoning' in step ? step.reasoning.usage : step.usage
        if (hasUsage(usage)) {
            total = addUsage(total, usage)
            seen = true
        }
    }
    return seen ? total : undefined
}

/**
 * Per-million-token USD prices for a few common models. Keyed by a lowercase
 * substring matched against the model id. Free tiers are priced at 0. This is a
 * best-effort estimate for observability, NOT billing — pricing changes and this
 * table is intentionally small and easy to extend.
 */
export interface ModelPrice {
    /** USD per 1M input (prompt) tokens. */
    inputPerM: number
    /** USD per 1M output (completion) tokens. */
    outputPerM: number
}

export const MODEL_PRICING: ReadonlyArray<{ match: string; price: ModelPrice }> = [
    // Free tiers used by the app's fallback chain.
    { match: 'gemini-2.5-flash', price: { inputPerM: 0, outputPerM: 0 } },
    { match: 'glm-4v-flash', price: { inputPerM: 0, outputPerM: 0 } },
    { match: ':free', price: { inputPerM: 0, outputPerM: 0 } },
    // A few common paid models (approximate public list prices, USD / 1M tokens).
    { match: 'gpt-4o-mini', price: { inputPerM: 0.15, outputPerM: 0.6 } },
    { match: 'gpt-4o', price: { inputPerM: 2.5, outputPerM: 10 } },
    { match: 'gpt-4.1-mini', price: { inputPerM: 0.4, outputPerM: 1.6 } },
    { match: 'gpt-4.1', price: { inputPerM: 2, outputPerM: 8 } },
    { match: 'claude-3-5-haiku', price: { inputPerM: 0.8, outputPerM: 4 } },
    { match: 'claude-3-5-sonnet', price: { inputPerM: 3, outputPerM: 15 } },
    { match: 'gemini-1.5-flash', price: { inputPerM: 0.075, outputPerM: 0.3 } },
    { match: 'gemini-1.5-pro', price: { inputPerM: 1.25, outputPerM: 5 } }
]

/** Look up the price for a model id by longest-substring match, or undefined. */
export function priceForModel(model: string | undefined): ModelPrice | undefined {
    if (!model) return undefined
    const id = model.toLowerCase()
    let best: { match: string; price: ModelPrice } | undefined
    for (const entry of MODEL_PRICING) {
        if (id.includes(entry.match) && (!best || entry.match.length > best.match.length)) {
            best = entry
        }
    }
    return best?.price
}

/**
 * Estimate the USD cost of one call's token usage on a given model, or undefined
 * when the model is not in the pricing table (unknown cost). A free model
 * resolves to exactly 0.
 */
export function estimateCostUsd(
    model: string | undefined,
    usage: TokenUsage | undefined
): number | undefined {
    if (!hasUsage(usage)) return model && priceForModel(model) ? 0 : undefined
    const price = priceForModel(model)
    if (!price) return undefined
    return (
        (usage.promptTokens / 1_000_000) * price.inputPerM +
        (usage.completionTokens / 1_000_000) * price.outputPerM
    )
}

/** Format a token count compactly, e.g. `1,234` or `1.2k`. */
export function formatTokens(n: number): string {
    if (n < 1000) return String(n)
    if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
    return `${Math.round(n / 1000)}k`
}

/** Format a USD cost, e.g. `$0.0012` or `free` for exactly 0. */
export function formatCostUsd(cost: number | undefined): string | undefined {
    if (cost === undefined) return undefined
    if (cost === 0) return 'free'
    if (cost < 0.01) return `$${cost.toFixed(4)}`
    return `$${cost.toFixed(2)}`
}
