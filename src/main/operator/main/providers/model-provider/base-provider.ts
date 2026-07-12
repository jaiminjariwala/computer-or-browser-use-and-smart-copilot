import type {
    ModelProvider,
    ModelProviderConfig,
    ObservedOutcome,
    ProviderKind,
    ReasoningContext,
    TokenUsage
} from '@op-shared/types'
import { isVisionCapableModelId } from '../../config'
import {
    buildReasoningMessages,
    buildReasoningTools,
    parseReasoningResponse,
    type ParsedToolCall
} from '../reasoning-request'
import {
    createOperatorChatClient,
    type ChatClientFactory,
    type OperatorChatClient,
    type OperatorChatResult,
    type RawToolCall,
    type RawUsage
} from './client'

/**
 * Shared OpenAI-compatible provider behavior (Task 6.1).
 *
 * Every concrete provider is an OpenAI-compatible vision + tool-calling client
 * ({@link ModelProvider}). They all share the SAME request shape — assembled by
 * the pure `reasoning-request` module — and differ only in transport
 * (`baseURL`, model id, auth), so all the real logic (request assembly,
 * parsing, availability probing, vision-model listing) lives here on the base
 * class; concrete providers only pin their {@link ProviderKind}.
 */

export interface ModelProviderDeps {
    /**
     * Resolve the provider's API key, or null when none is stored. Keyless
     * local providers resolve null and use a placeholder key (Req 21.8).
     */
    getApiKey: () => Promise<string | null>
    /** Chat-client factory; defaults to {@link createOperatorChatClient}. */
    createClient?: ChatClientFactory
    /** Operator behavior + safety-contract system prompt (defaults to the built-in). */
    systemPrompt?: string
    /** Reachability-probe timeout in ms (defaults to 2000). */
    availabilityTimeoutMs?: number
}

/** Placeholder key used for keyless providers so the SDK constructs cleanly. */
const KEYLESS_PLACEHOLDER = 'local'

/**
 * Shared OpenAI-compatible provider behavior. Concrete providers only pin their
 * {@link ProviderKind}; everything else — request assembly, parsing,
 * availability probing, vision-model listing — is identical (Req 3.1, 15.1).
 */
export abstract class OpenAICompatibleModelProvider implements ModelProvider {
    readonly id: string
    readonly kind: ProviderKind
    readonly baseURL: string
    readonly model: string
    readonly requiresKey: boolean

    private readonly getApiKey: () => Promise<string | null>
    private readonly createClient: ChatClientFactory
    private readonly systemPrompt?: string
    private readonly availabilityTimeoutMs: number

    protected constructor(config: ModelProviderConfig, deps: ModelProviderDeps) {
        this.id = config.id
        this.kind = config.kind
        this.baseURL = config.baseURL
        this.model = config.model
        this.requiresKey = config.requiresKey
        this.getApiKey = deps.getApiKey
        this.createClient = deps.createClient ?? createOperatorChatClient
        this.systemPrompt = deps.systemPrompt
        this.availabilityTimeoutMs = deps.availabilityTimeoutMs ?? 2000
    }

    /** Resolve a ready client + effective key, or null when a required key is absent. */
    private async resolveClient(): Promise<OperatorChatClient | null> {
        const key = (await this.getApiKey())?.trim() ?? ''
        if (this.requiresKey && key.length === 0) return null
        return this.createClient(this.baseURL, key.length > 0 ? key : KEYLESS_PLACEHOLDER)
    }

    /**
     * Lightweight reachability/health probe (Req 21.3, 21.4). A provider is
     * available when it is configured (endpoint + model, plus a key when
     * required) and a short `models.list` ping resolves. Any error or timeout
     * → not available, so the router falls back.
     */
    async isAvailable(): Promise<boolean> {
        if (this.baseURL.trim().length === 0 || this.model.trim().length === 0) return false
        const client = await this.resolveClient()
        if (!client) return false
        if (!client.models?.list) {
            // No probe surface; treat a configured provider as available.
            return true
        }
        try {
            await withTimeout(
                Promise.resolve(client.models.list()),
                this.availabilityTimeoutMs
            )
            return true
        } catch {
            return false
        }
    }

    /**
     * Run one Reasoning_Step: assemble the vision + tool-calling request from
     * {@link ReasoningContext}, dispatch it, and parse the response into exactly
     * one {@link ReasoningOutcome}. A missing required key or a transport error
     * THROWS so the router can fall back; a reachable-but-unparseable response
     * returns `{ kind: 'failure' }` (Req 3.4).
     */
    async reason(ctx: ReasoningContext): Promise<ObservedOutcome> {
        const client = await this.resolveClient()
        if (!client) {
            throw new Error(`Provider "${this.id}" is missing a required API key.`)
        }
        const messages = buildReasoningMessages(ctx, this.systemPrompt)
        const tools = buildReasoningTools()

        // Free tiers (notably Gemini) rate-limit aggressively and return 429.
        // A single short backoff+retry smooths over a transient burst limit
        // before the router gives up and falls through to the next provider.
        let result: OperatorChatResult
        try {
            result = await client.chat.completions.create({
                model: this.model,
                messages,
                tools,
                tool_choice: 'required'
            })
        } catch (err) {
            if (isRateLimit(err)) {
                await delay(2000)
                result = await client.chat.completions.create({
                    model: this.model,
                    messages,
                    tools,
                    tool_choice: 'required'
                })
            } else {
                throw err
            }
        }

        // Guard against an error-shaped body with no `choices` (some gateways
        // return `{ error: ... }` on failure); crashing here would abort the
        // whole run instead of failing this one step gracefully.
        const message = result?.choices?.[0]?.message
        const outcome = parseReasoningResponse({
            content: message?.content ?? null,
            toolCalls: normalizeToolCalls(message?.tool_calls)
        })
        // Annotate the outcome with observability metadata: the concrete model id
        // and the token usage the endpoint reported (when it reports any).
        const usage = toTokenUsage(result?.usage)
        return usage
            ? { ...outcome, model: this.model, usage }
            : { ...outcome, model: this.model }
    }

    /**
     * List the provider's vision-capable model ids (Req 21.7). Ids are filtered
     * by the shared vision-capability heuristic; a non-vision model can never be
     * offered for selection. Errors yield an empty list (fail closed).
     */
    async listVisionModels(): Promise<string[]> {
        const client = await this.resolveClient()
        if (!client?.models?.list) return []
        try {
            const result = await client.models.list()
            const ids = await collectModelIds(result)
            return ids.filter(isVisionCapableModelId).sort((a, b) => a.localeCompare(b))
        } catch {
            return []
        }
    }
}

// --- Helpers ----------------------------------------------------------------

/** Resolve after `ms` milliseconds (used for the 429 backoff). */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalize an OpenAI-compatible `usage` block into a {@link TokenUsage}, or
 * undefined when absent / all-zero. `total_tokens` falls back to prompt +
 * completion when the endpoint omits it.
 */
function toTokenUsage(raw: RawUsage | undefined): TokenUsage | undefined {
    if (!raw) return undefined
    const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const promptTokens = num(raw.prompt_tokens)
    const completionTokens = num(raw.completion_tokens)
    const reportedTotal = num(raw.total_tokens)
    const totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined
    return { promptTokens, completionTokens, totalTokens }
}

/** True when a thrown SDK error looks like an HTTP 429 rate-limit. */
function isRateLimit(err: unknown): boolean {
    const status = (err as { status?: number; statusCode?: number } | null)?.status
    const statusCode = (err as { statusCode?: number } | null)?.statusCode
    if (status === 429 || statusCode === 429) return true
    const msg = err instanceof Error ? err.message : String(err ?? '')
    return /\b429\b|rate.?limit|too many requests/i.test(msg)
}

/** Adapt raw SDK tool calls into the pure-parser {@link ParsedToolCall} shape. */
function normalizeToolCalls(raw: RawToolCall[] | undefined): ParsedToolCall[] {
    if (!raw || raw.length === 0) return []
    const out: ParsedToolCall[] = []
    for (const call of raw) {
        const name = call.function?.name
        if (typeof name !== 'string') continue
        out.push({ name, arguments: call.function?.arguments ?? '' })
    }
    return out
}

/** Collect model ids from either a `.data` page or an async-iterable result. */
async function collectModelIds(
    result: { data?: Array<{ id?: string }> } | AsyncIterable<{ id?: string }>
): Promise<string[]> {
    const ids: string[] = []
    const asPage = result as { data?: Array<{ id?: string }> }
    if (Array.isArray(asPage.data)) {
        for (const m of asPage.data) if (m?.id) ids.push(m.id)
    } else {
        for await (const m of result as AsyncIterable<{ id?: string }>) {
            if (m?.id) ids.push(m.id)
        }
    }
    return ids
}

/** Reject after `ms` milliseconds so a hung probe cannot stall the chain. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('probe timeout')), ms)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (err) => {
                clearTimeout(timer)
                reject(err)
            }
        )
    })
}
