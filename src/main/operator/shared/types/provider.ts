/**
 * Model_Provider configuration, the Provider_Chain, and the gateway config.
 *
 * Covers a single provider's config + runtime status, the ordered chain and its
 * UI view/input shapes, the {@link ModelProvider} client interface, and the
 * AI_Gateway config + its save input (Req 15, 21).
 */

import type { ReasoningContext, ReasoningOutcome } from './reasoning'

/** The AI_Gateway configuration (apiKey stored encrypted via safeStorage). */
export interface GatewayConfig {
    baseURL: string
    model: string
}

/** The kind of a Model_Provider (Req 21). */
export type ProviderKind = 'openai-compatible' | 'local'

/** A single Model_Provider's configuration (Req 21). */
export interface ModelProviderConfig {
    /** Stable id, referenced by the Provider_Chain. */
    id: string
    /** Hosted OpenAI-compatible endpoint or local open-source server. */
    kind: ProviderKind
    /** OpenAI-compatible endpoint, e.g. a hosted endpoint or `http://localhost:11434/v1`. */
    baseURL: string
    /** Must be vision-capable (Req 21.7). */
    model: string
    /** Local providers may be keyless (Req 21.8); apiKey (when present) encrypted via safeStorage. */
    requiresKey: boolean
}

/** The user-ordered chain: primary first, then fallbacks (Req 21.2). */
export interface ProviderChain {
    /** Ordered provider ids; primary first, then fallbacks. */
    providerIds: string[]
}

/** Runtime status of a provider surfaced to the renderer (Req 21.6, 21.7, 21.10). */
export type ProviderStatus = {
    id: string
    available: boolean
    visionModels: string[]
}

/** The provider list + chain order + statuses shown in the UI (Req 21.1, 21.2, 21.10). */
export interface ProviderChainView {
    chain: ProviderChain
    providers: ModelProviderConfig[]
    statuses: ProviderStatus[]
}

/** Input to add/remove/reorder providers + endpoints/keys (Req 21.1, 21.2, 21.8). */
export interface ProviderChainInput {
    chain: ProviderChain
    providers: (ModelProviderConfig & { apiKey?: string })[]
}

/** `config:save` payload (Req 15.2). */
export interface GatewayConfigInput {
    /** OpenAI-compatible base URL. */
    baseURL?: string
    model: string
    apiKey?: string
}

/** A single Model_Provider: an OpenAI-compatible vision + tool-calling client. */
export interface ModelProvider {
    id: string
    /** Reachability/health probe (Req 21.3, 21.4). */
    isAvailable(): Promise<boolean>
    /** Action | completion | help | failure. */
    reason(ctx: ReasoningContext): Promise<ReasoningOutcome>
    /** Vision-capable models only (Req 21.7). */
    listVisionModels(): Promise<string[]>
}
