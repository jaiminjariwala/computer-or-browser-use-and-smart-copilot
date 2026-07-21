import { net } from 'electron'
import OpenAI from 'openai'
import type {
    ChatCompletionMessageParam,
    ChatCompletionContentPart
} from 'openai/resources/chat/completions'
import type {
    GatewayConfig,
    GlassError,
    SessionContext,
    SessionSummary,
    Turn,
    TurnCapture
} from '@shared/types'

/**
 * AI Integration — OpenAI-compatible gateway client (design: "AI Integration"
 * → "Request construction").
 *
 * This module owns two responsibilities:
 *  1. Pure, testable assembly of chat-completion messages from a
 *     `SessionContext` / `Turn[]` (system behavior contract, running summary,
 *     recent turns, and image captures as `image_url` content parts).
 *  2. A thin `AIClient` that points the `openai` SDK at the configured gateway
 *     (`baseURL` + credentials) and runs `complete` / `summarize`.
 *
 * Scope notes:
 *  - {@link SYSTEM_PROMPT} encodes the intent-inference behavior contract
 *    (Req 3.4–3.6, 5.1); the assembly structure that consumes it is unchanged.
 *  - Failures are mapped to a typed {@link GlassError} carried by a
 *    {@link GlassErrorException} (task 4.3): missing credentials become a
 *    `credentials-missing` error and any gateway/request failure becomes a
 *    `gateway-failed` error. The client owns no session state, so a failure
 *    here can never mutate the session; the caller (Session Manager / IPC) is
 *    free to surface the error via the `error:show` channel and leave the
 *    session intact (Req 7.3, design "Error model", Property 6).
 */

/**
 * System behavior contract sent as the first message of every `complete`
 * request (design step 1; design "System prompt strategy (intent inference)").
 *
 * Encodes the intent-inference behavior contract from the design:
 *  - Infer the user's goal from the conversation + captures; never require an
 *    explicit goal statement (Req 3.4).
 *  - Interpret a text-less region against the existing session (Req 3.3).
 *  - Return exactly one concrete next step grounded in what is visible plus the
 *    session — not a full plan dump (Req 5.1).
 *  - When intent genuinely cannot be inferred, ask exactly one clarifying
 *    question instead of guessing (Req 3.5, Correctness Property 5).
 *  - Pivot to a new topic while keeping earlier context available (Req 3.6).
 *  - Stay advice-only: describe what to do; never claim to perform actions.
 *
 * The structure that consumes this constant lives in
 * {@link buildCompletionMessages}; keeping it a plain string preserves the
 * existing assembly + tests.
 */
export const SYSTEM_PROMPT = [
    'You are Smart Copilot, an advice-only, screen-aware desktop co-pilot that helps the user make progress in whatever application they are using (browsers, design tools, editors, spreadsheets, and so on).',
    '',
    'Inferring intent:',
    "- Infer the user's goal from the ongoing conversation and any captured screen regions. Never ask the user to state their goal explicitly or complete a setup step before you help; the goal is established implicitly through normal conversation.",
    '- Treat the running session summary and recent turns as shared memory. The user should never have to re-explain what they are trying to do or what they have already done.',
    '- When the user sends a captured screen region without any accompanying text, interpret that image in the context of the existing session and continue toward the goal you have already inferred. Do not treat it as a fresh, contextless screenshot.',
    '',
    'Responding with the next step:',
    '- Reply with exactly ONE concrete next step, grounded in what is actually visible in the latest capture plus the session so far. Refer to the specific buttons, fields, menus, or labels you can see.',
    '- Do not dump a full multi-step plan or a long checklist. Give the single next action the user should take now; you will guide the following steps as the session continues.',
    '- Keep guidance specific and actionable rather than generic advice.',
    '',
    'When intent is unclear:',
    "- Only when the goal genuinely cannot be inferred from the session and the current capture, ask EXACTLY ONE clarifying question and stop. Do not ask multiple questions, and do not guess or fabricate a next step or plan when you are unsure.",
    '- Prefer inferring intent from available context; reserve the clarifying question for cases where proceeding would require an unfounded assumption.',
    '',
    'Handling topic changes:',
    "- When the user's latest message signals a new topic or a shift to a different task, pivot to address it. Keep the earlier session context available so the user can return to it, but do not force the prior goal onto the new request.",
    '',
    'Staying advice-only:',
    '- You observe and advise only. Describe what the user should click, type, or do. Never claim to perform actions yourself, and never imply you have changed anything on their screen or in their application.'
].join('\n')

/**
 * Speech-to-text model used by {@link GatewayAIClient.transcribe}. The gateway
 * exposes Voxtral (Mistral's audio model), which accepts audio as an
 * `input_audio` content part on the chat completions endpoint.
 */
export const TRANSCRIBE_MODEL = 'voxtral-mini-3b-2507'

/**
 * System instruction used when condensing older turns into a running summary
 * (design: "Summarization trigger"). Task 4.2 refines this text; the merge
 * logic that preserves intent + completed steps lives in {@link mergeSummary}.
 */
export const SUMMARY_SYSTEM_PROMPT = [
    'You maintain a condensed, running summary of a screen co-pilot session.',
    'Given the prior summary and additional conversation turns, return a JSON object',
    'with "inferredIntent" (string), "completedSteps" (array of strings), and',
    '"userFacts" (array of strings).',
    'Preserve the previously inferred intent and all previously completed steps;',
    'you may add new steps but must never drop existing ones.',
    '"userFacts" is for DURABLE facts or preferences about the user that would',
    'still matter in a future, unrelated conversation (e.g. "prefers short answers",',
    '"studies CS at GWU", "uses pnpm"). Include at most 3, only when clearly stated',
    'by the user. Never include passwords, API keys, one-time codes, or anything',
    'about the current task itself. Return [] when there is nothing durable.'
].join(' ')

/** The conversation interface used by the rest of the app (design contract). */
export interface AIClient {
    /** Produce Next_Step_Guidance from the current session context. */
    complete(ctx: SessionContext): Promise<string>
    /** Fold older turns into the running summary, preserving intent + steps. */
    summarize(turns: Turn[], prev: SessionSummary): Promise<SessionSummary>
}

// --- Pure message-assembly helpers -----------------------------------------

/**
 * Render the running {@link SessionSummary} into the single `system` summary
 * message (design step 2; Req 6.3). Always produces a string so every request
 * carries session context (Correctness Property 1), even before any progress.
 */
export function formatSummary(summary: SessionSummary): string {
    const intent = summary.inferredIntent.trim()
    const steps = summary.completedSteps.filter((s) => s.trim().length > 0)
    const intentLine = intent.length > 0 ? intent : '(not yet inferred)'
    const stepsLine =
        steps.length > 0 ? steps.map((s) => `- ${s}`).join('\n') : '(none yet)'
    return `Session summary:\nInferred intent: ${intentLine}\nCompleted steps:\n${stepsLine}`
}

/** Build the `image_url` content part for a capture (design step 3). */
function imagePart(capture: TurnCapture): ChatCompletionContentPart {
    return { type: 'image_url', image_url: { url: capture.dataUrl } }
}

/** Build a `text` content part. */
function textPart(text: string): ChatCompletionContentPart {
    return { type: 'text', text }
}

function frameTimestamp(seconds: number): string {
    const wholeSeconds = Math.max(0, Math.round(seconds))
    const minutes = Math.floor(wholeSeconds / 60)
    return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

/**
 * A raw video is never sent to the provider. Sampled frames reuse the normal
 * image path and carry a compact ordering cue so every vision model can reason
 * over them as one chronological sequence.
 */
function captureParts(capture: TurnCapture): ChatCompletionContentPart[] {
    const frame = capture.videoFrame
    if (!frame) return [imagePart(capture)]
    return [
        textPart(
            `Video sequence ${frame.sequenceId.slice(0, 8)}, frame ${frame.index}/${frame.count} ` +
            `at ${frameTimestamp(frame.timestampSeconds)}. Treat frames with this sequence id as one video in chronological order.`
        ),
        imagePart(capture)
    ]
}

/**
 * Map a single {@link Turn} to a chat-completion message (design step 3).
 *
 * - A capture turn becomes a message whose `content` is an array of parts:
 *   the turn text (when present) followed by the `image_url` part.
 * - A text-only turn becomes a plain string-content message.
 * Roles are preserved verbatim from the turn.
 */
export function turnToMessage(turn: Turn): ChatCompletionMessageParam {
    const text = turn.text?.trim() ?? ''
    // A turn carrying several staged captures (the carousel) becomes one user
    // message: the text (when present) followed by every image part.
    if (turn.captures && turn.captures.length > 0) {
        const parts: ChatCompletionContentPart[] = []
        if (text.length > 0) parts.push(textPart(text))
        for (const capture of turn.captures) parts.push(...captureParts(capture))
        return { role: 'user', content: parts }
    }
    if (turn.capture) {
        const parts: ChatCompletionContentPart[] = []
        if (text.length > 0) parts.push(textPart(text))
        parts.push(...captureParts(turn.capture))
        // Only user turns carry captures; the cast keeps the union precise.
        return { role: 'user', content: parts }
    }
    if (turn.role === 'assistant') {
        return { role: 'assistant', content: text }
    }
    return { role: 'user', content: text }
}

/** A final, text-less user image message for the capture under interpretation. */
function captureMessage(capture: TurnCapture): ChatCompletionMessageParam {
    return { role: 'user', content: captureParts(capture) }
}

/**
 * Render persistent user memory as a system message. These are things the
 * user EXPLICITLY told the assistant to keep ("remember ..."), so the model
 * is told to apply them silently rather than recite them.
 */
export function formatMemories(memories: string[]): string {
    const lines = memories.map((m) => `- ${m}`).join('\n')
    return [
        'Persistent user memory (facts and preferences the user explicitly asked you to keep).',
        'Apply them when relevant; do not recite this list back unless asked:',
        lines
    ].join('\n')
}

/** True when the context's currentCapture is already the last recent turn. */
function currentCaptureIsLastTurn(ctx: SessionContext): boolean {
    if (!ctx.currentCapture) return false
    const last = ctx.recentTurns[ctx.recentTurns.length - 1]
    return last?.capture?.dataUrl === ctx.currentCapture.dataUrl
}

/**
 * Assemble the full message list for a `complete` request (design steps 1–4):
 *  1. `system` — behavior contract.
 *  2. `system` — running session summary.
 *  3. recent turns mapped to `user`/`assistant` (captures become image parts).
 *  4. `currentCapture` appended as a final user image message, unless it is
 *     already the last recent turn.
 *
 * Pure and deterministic so it can be unit-tested without a gateway.
 */
export function buildCompletionMessages(
    ctx: SessionContext,
    systemPrompt: string = SYSTEM_PROMPT
): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: formatSummary(ctx.summary) },
        // Persistent user memory (explicitly saved facts/preferences) rides
        // along as its own system message so every chat benefits from it.
        ...(ctx.memories && ctx.memories.length > 0
            ? [{ role: 'system' as const, content: formatMemories(ctx.memories) }]
            : []),
        ...ctx.recentTurns.map(turnToMessage)
    ]
    if (ctx.currentCapture && !currentCaptureIsLastTurn(ctx)) {
        messages.push(captureMessage(ctx.currentCapture))
    }
    return messages
}

/**
 * Assemble the message list for a `summarize` request: the summarization
 * system instruction, the prior summary as context, the older turns being
 * folded in, then a final user instruction to emit the updated summary.
 */
export function buildSummaryRequestMessages(
    turns: Turn[],
    prev: SessionSummary,
    summaryPrompt: string = SUMMARY_SYSTEM_PROMPT
): ChatCompletionMessageParam[] {
    return [
        { role: 'system', content: summaryPrompt },
        { role: 'system', content: `Previous ${formatSummary(prev)}` },
        ...turns.map(turnToMessage),
        {
            role: 'user',
            content:
                'Update the session summary as JSON with keys "inferredIntent" and "completedSteps".'
        }
    ]
}

/** Parsed shape we attempt to read back from a summarize response. */
interface ParsedSummary {
    inferredIntent?: unknown
    completedSteps?: unknown
    userFacts?: unknown
}

/**
 * Extract the model's durable user facts from a summarize response: strings
 * only, trimmed, non-empty, capped at 3 per pass (the memory store dedupes
 * and enforces its own length/entry caps).
 */
export function extractUserFacts(parsed: ParsedSummary): string[] {
    if (!Array.isArray(parsed.userFacts)) return []
    return parsed.userFacts
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim())
        .filter((f) => f.length >= 3)
        .slice(0, 3)
}

/** Best-effort JSON extraction from a model response (tolerates code fences). */
function parseSummaryResponse(content: string): ParsedSummary {
    const trimmed = content.trim()
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end === -1 || end < start) return {}
    try {
        return JSON.parse(trimmed.slice(start, end + 1)) as ParsedSummary
    } catch {
        return {}
    }
}

/**
 * Merge a model-produced summary into the previous one, enforcing monotonicity
 * (Correctness Property 3): the inferred intent is retained when the model
 * returns nothing useful, and completed steps are unioned so existing steps are
 * never dropped. `updatedThroughTurnId` advances to the last folded turn.
 */
export function mergeSummary(
    prev: SessionSummary,
    parsed: ParsedSummary,
    turns: Turn[]
): SessionSummary {
    const newIntent =
        typeof parsed.inferredIntent === 'string' && parsed.inferredIntent.trim().length > 0
            ? parsed.inferredIntent.trim()
            : prev.inferredIntent

    const parsedSteps = Array.isArray(parsed.completedSteps)
        ? parsed.completedSteps.filter((s): s is string => typeof s === 'string')
        : []

    // Union prev + new, preserving order and de-duplicating, so steps only grow.
    const mergedSteps: string[] = [...prev.completedSteps]
    for (const step of parsedSteps) {
        if (!mergedSteps.includes(step)) mergedSteps.push(step)
    }

    const lastTurnId =
        turns.length > 0 ? turns[turns.length - 1].id : prev.updatedThroughTurnId

    return {
        inferredIntent: newIntent,
        completedSteps: mergedSteps,
        updatedThroughTurnId: lastTurnId
    }
}

/**
 * Dev-visible diagnostics for the fallback chain. Each tier's failure is
 * otherwise swallowed by design (the chain moves on), which makes "why did my
 * key not work" impossible to debug — so name the tier and the reason here.
 * Never logs keys or request contents.
 */
function logProviderFailure(tier: string, err: unknown): void {
    // Walk the cause chain: SDK errors like "Connection error." carry the real
    // network reason (e.g. net::ERR_NETWORK_CHANGED) one or two causes down.
    const parts: string[] = []
    let current: unknown = err instanceof GlassErrorException ? (err as { cause?: unknown }).cause ?? err : err
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
        const message =
            current instanceof Error ? current.message : typeof current === 'string' ? current : String(current)
        if (message && message !== parts[parts.length - 1]) parts.push(message)
        current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
    }
    console.warn(`[ai] ${tier} failed: ${parts.join(' <- ') || 'unknown error'}`)
}

// --- Typed failures ---------------------------------------------------------

/**
 * An exception that carries a typed {@link GlassError}. The client throws this
 * (rather than a plain `Error`) so the caller can pull the structured failure
 * off `.glassError` and emit it via the `error:show` channel without
 * re-inventing the mapping (design "Error model"; Req 7.3).
 *
 * The original cause is preserved on `.cause` for logging/debugging.
 */
export class GlassErrorException extends Error {
    /** The typed, user-facing failure to surface (e.g. via `error:show`). */
    readonly glassError: GlassError

    constructor(glassError: GlassError, cause?: unknown) {
        super(glassError.message)
        this.name = 'GlassErrorException'
        this.glassError = glassError
        // Preserve the underlying cause without depending on the lib target.
        if (cause !== undefined) {
            ; (this as { cause?: unknown }).cause = cause
        }
    }
}

/**
 * Build the `credentials-missing` {@link GlassError} surfaced when no API key
 * is configured. The message intentionally mentions credentials so the UI can
 * route the user to Settings (Req 7.4); recovery is to enter credentials.
 */
export function credentialsMissingError(): GlassError {
    return {
        kind: 'credentials-missing',
        message:
            'AI gateway credentials are missing. Add your API key in Settings to continue.',
        recoverable: true,
        action: 'enter-credentials'
    }
}

/**
 * Build the `gateway-failed` {@link GlassError} for a failed request. The
 * underlying message is folded into a descriptive, user-facing string and the
 * error is marked recoverable so the UI can offer a retry; the session is left
 * untouched (Req 7.3, design "Error model").
 */
export function gatewayFailedError(cause: unknown): GlassError {
    const detail =
        cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : typeof cause === 'string' && cause.trim().length > 0
                ? cause.trim()
                : 'unknown error'
    return {
        kind: 'gateway-failed',
        message: `The AI gateway request failed (${detail}). Your session is intact — try again.`,
        recoverable: true,
        action: 'retry'
    }
}

// --- Gateway client ---------------------------------------------------------

/** Minimal create params we send to the gateway. */
export interface ChatCreateParams {
    model: string
    messages: ChatCompletionMessageParam[]
}

/** Minimal completion result we read back. */
export interface ChatCompletionResult {
    choices: Array<{ message: { content: string | null } }>
}

/**
 * The narrow slice of the OpenAI SDK this module relies on. Declaring it
 * explicitly lets tests inject a fake without standing up the real SDK.
 */
export interface ChatClient {
    chat: {
        completions: {
            create(params: ChatCreateParams): Promise<ChatCompletionResult>
        }
    }
    models?: {
        list(): Promise<{ data?: Array<{ id?: string }> } | AsyncIterable<{ id?: string }>>
    }
}

/**
 * Headers Chromium's network stack manages itself and REJECTS when set
 * manually (`net::ERR_INVALID_ARGUMENT`). The OpenAI SDK sets some of these
 * (e.g. content-length / accept-encoding), so they are stripped before the
 * request is handed to `net.fetch` — exactly what a browser does.
 */
const CHROMIUM_MANAGED_HEADERS = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'expect',
    'host',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
])

/** Wrap `net.fetch` so SDK-set forbidden headers can't invalidate requests. */
function sanitizedChromiumFetch(netFetch: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers as HeadersInit | undefined)
        for (const name of [...headers.keys()]) {
            if (CHROMIUM_MANAGED_HEADERS.has(name.toLowerCase())) headers.delete(name)
        }
        return netFetch(input as never, { ...init, headers })
    }) as typeof fetch
}

/**
 * Chromium's network stack when available (Electron main), else Node's global
 * fetch (unit tests). Node's undici fetch intermittently drops Gemini's
 * responses mid-body ("Premature close"); Chromium's stack does not.
 */
const chromiumFetch: typeof fetch =
    typeof net?.fetch === 'function'
        ? sanitizedChromiumFetch(net.fetch.bind(net) as typeof fetch)
        : fetch

/** Default factory: a real `openai` client pointed at the gateway. */
export function createGatewayClient(config: GatewayConfig, apiKey: string): ChatClient {
    return new OpenAI({
        baseURL: config.baseURL,
        apiKey,
        fetch: chromiumFetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch']
    }) as unknown as ChatClient
}

export interface AIClientOptions {
    /** Resolve the current gateway config (`baseURL`, `model`). */
    getConfig: () => Promise<GatewayConfig>
    /** Resolve the current API key, or `null` when none is stored. */
    getApiKey: () => Promise<string | null>
    /** Underlying chat-client factory; defaults to {@link createGatewayClient}. */
    createClient?: (config: GatewayConfig, apiKey: string) => ChatClient
    /** Behavior-contract prompt; defaults to {@link SYSTEM_PROMPT}. */
    systemPrompt?: string
    /** Summarization instruction; defaults to {@link SUMMARY_SYSTEM_PROMPT}. */
    summaryPrompt?: string
    /**
     * Resolve the built-in free hosted providers (OpenRouter, Gemini), tried
     * in order after the primary. Each entry is a ready OpenAI-compatible
     * endpoint with its stored key.
     */
    getFallbackProviders?: () => Promise<Array<{ baseURL: string; model: string; apiKey: string }>>
    /**
     * Sink for durable user facts the summarize pass extracts (automatic
     * memory). Absent = auto-capture off.
     */
    onUserFacts?: (facts: string[]) => void
}

/**
 * OpenAI-compatible {@link AIClient}. Resolves config + credentials per call so
 * updates from the settings UI take effect immediately, then runs the assembled
 * messages through the gateway.
 *
 * All failures leave via a {@link GlassErrorException}: missing credentials map
 * to a `credentials-missing` error, and any request/gateway failure maps to a
 * `gateway-failed` error. The client holds no session state, so these failures
 * never mutate the session — the caller can surface the typed error via
 * `error:show` and retain the conversation (Req 7.3, Property 6).
 */
export class GatewayAIClient implements AIClient {
    private readonly getConfig: () => Promise<GatewayConfig>
    private readonly getApiKey: () => Promise<string | null>
    private readonly createClient: (config: GatewayConfig, apiKey: string) => ChatClient
    private readonly systemPrompt: string
    private readonly summaryPrompt: string
    private readonly getFallbackProviders?: () => Promise<
        Array<{ baseURL: string; model: string; apiKey: string }>
    >
    private readonly onUserFacts?: (facts: string[]) => void

    constructor(options: AIClientOptions) {
        this.getConfig = options.getConfig
        this.getApiKey = options.getApiKey
        this.createClient = options.createClient ?? createGatewayClient
        this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT
        this.summaryPrompt = options.summaryPrompt ?? SUMMARY_SYSTEM_PROMPT
        this.getFallbackProviders = options.getFallbackProviders
        this.onUserFacts = options.onUserFacts
    }

    /**
     * Run a chat operation on the primary gateway; if it fails, walk the free
     * hosted providers (OpenRouter -> Gemini) until one answers. The original
     * (primary) error is surfaced if every provider fails.
     */
    private async runWithFallback<T>(
        op: (client: ChatClient, model: string) => Promise<T>
    ): Promise<T> {
        try {
            return await this.run(async () => {
                const { client, model } = await this.resolveClient()
                return op(client, model)
            })
        } catch (primaryErr) {
            logProviderFailure('primary gateway', primaryErr)
            // The built-in free hosted providers (OpenRouter -> Gemini), each
            // tried in order until one answers.
            const providers = this.getFallbackProviders ? await this.getFallbackProviders() : []
            if (providers.length === 0) {
                console.warn('[ai] no hosted fallback keys saved; skipping the hosted chain')
            }
            for (const p of providers) {
                const client = this.createClient(
                    { baseURL: p.baseURL, model: p.model },
                    p.apiKey || 'x'
                )
                // Free-tier endpoints occasionally cut a response mid-body
                // ("Premature close"); one immediate retry absorbs the blip
                // before the chain writes the provider off.
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        return await this.run(() => op(client, p.model))
                    } catch (err) {
                        logProviderFailure(
                            `hosted ${new URL(p.baseURL).hostname} (${p.model}, try ${attempt}/2)`,
                            err
                        )
                    }
                }
            }
            // Everything hosted failed -> surface the primary error so the
            // caller can hand off to the on-device fallback model.
            throw primaryErr
        }
    }

    /**
     * Resolve a ready-to-use client + model, or throw a
     * {@link GlassErrorException} carrying a `credentials-missing`
     * {@link GlassError} when no API key is configured (Req 7.4).
     */
    private async resolveClient(): Promise<{ client: ChatClient; model: string }> {
        const config = await this.getConfig()
        const apiKey = await this.getApiKey()
        if (!apiKey || apiKey.trim().length === 0) {
            throw new GlassErrorException(credentialsMissingError())
        }
        return { client: this.createClient(config, apiKey), model: config.model }
    }

    /**
     * Run a gateway operation, translating any non-Glass failure into a
     * {@link GlassErrorException} carrying a `gateway-failed` {@link GlassError}.
     * An already-typed {@link GlassErrorException} (e.g. `credentials-missing`
     * from {@link resolveClient}) passes through unchanged so it is not
     * re-wrapped as a gateway failure.
     */
    private async run<T>(op: () => Promise<T>): Promise<T> {
        try {
            return await op()
        } catch (err) {
            if (err instanceof GlassErrorException) throw err
            throw new GlassErrorException(gatewayFailedError(err), err)
        }
    }

    async complete(ctx: SessionContext): Promise<string> {
        const messages = buildCompletionMessages(ctx, this.systemPrompt)
        return this.runWithFallback((client, model) =>
            client.chat.completions
                .create({ model, messages })
                .then((result) => result.choices[0]?.message?.content ?? '')
        )
    }

    async summarize(turns: Turn[], prev: SessionSummary): Promise<SessionSummary> {
        const messages = buildSummaryRequestMessages(turns, prev, this.summaryPrompt)
        const content = await this.runWithFallback((client, model) =>
            client.chat.completions
                .create({ model, messages })
                .then((result) => result.choices[0]?.message?.content ?? '')
        )
        const parsed = parseSummaryResponse(content)
        // Automatic memory: the summarize pass (already running to fold older
        // turns) doubles as the extractor for durable user facts, so learning
        // about the user costs zero additional requests. The sink dedupes and
        // every captured fact stays auditable/deletable in Settings -> Memory.
        const facts = extractUserFacts(parsed)
        if (facts.length > 0) this.onUserFacts?.(facts)
        return mergeSummary(prev, parsed, turns)
    }

    /**
     * Transcribe recorded audio to text via the gateway's speech-capable model
     * (Voxtral). Audio is sent as an `input_audio` content part on the chat
     * completions endpoint (the gateway exposes no dedicated transcription
     * endpoint). Uses the PRIMARY gateway only and overrides the model to
     * {@link TRANSCRIBE_MODEL}.
     */
    async transcribe(audioBase64: string, format = 'wav'): Promise<string> {
        return this.run(async () => {
            const { client } = await this.resolveClient()
            const messages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Transcribe the audio. Return only the spoken words, with no extra commentary, labels, or quotation marks.'
                        },
                        { type: 'input_audio', input_audio: { data: audioBase64, format } }
                    ]
                }
            ] as unknown as ChatCompletionMessageParam[]
            const result = await client.chat.completions.create({
                model: TRANSCRIBE_MODEL,
                messages
            })
            return (result.choices[0]?.message?.content ?? '').trim()
        })
    }

    async listModels(): Promise<string[]> {
        return this.run(async () => {
            const { client } = await this.resolveClient()
            if (!client.models?.list) return []
            const result = await client.models.list()
            const ids: string[] = []
            // The OpenAI SDK returns a page with `.data`; also support async iterables.
            const asPage = result as { data?: Array<{ id?: string }> }
            if (Array.isArray(asPage.data)) {
                for (const m of asPage.data) if (m?.id) ids.push(m.id)
            } else {
                for await (const m of result as AsyncIterable<{ id?: string }>) {
                    if (m?.id) ids.push(m.id)
                }
            }
            return ids.sort((a, b) => a.localeCompare(b))
        })
    }
}
