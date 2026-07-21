/**
 * Model curation + friendly labels for the composer model picker.
 *
 * The gateway can return dozens of model ids, many of which are text-
 * only, audio, or embedding models that 400 on image input or are simply not
 * useful for a screen co-pilot. To keep the picker uncluttered we:
 *
 *  1. Drop models that can't handle vision/chat (speech, audio, embeddings,
 *     rerankers, guardrails) via {@link isVisionCapable}.
 *  2. Surface a short, ordered list of recommended vision models with friendly
 *     names via {@link curateModels}; everything else is tucked behind a
 *     "show all" toggle so power users can still reach it.
 */

/** A model as shown in the picker. */
export interface ModelOption {
    /** The raw gateway model id (what we actually send). */
    id: string
    /** A human-friendly display name. */
    label: string
    /** A short qualifier shown on a line below the name (e.g. "free"). */
    sublabel?: string
    /** True when this is one of the curated, recommended vision models. */
    recommended: boolean
}

/** Result of curating the raw model id list. */
export interface CuratedModels {
    /** Best vision models, best-first. */
    recommended: ModelOption[]
    /** Remaining vision-capable models, alphabetical. */
    others: ModelOption[]
}

/**
 * Models that cannot take an image (or aren't chat models at all). These would
 * 400 if the user picked them, so we never show them.
 */
const NOT_VISION = /sonic|embed|rerank|tts|speech|whisper|voxtral|polly|stt|guard|transcribe|reranker/i

/** True when a model id looks like it can handle image + chat input. */
export function isVisionCapable(id: string): boolean {
    return !NOT_VISION.test(id)
}

/**
 * Curated "recommended" vision models, best-first. Each entry maps a pattern
 * (matched against the raw gateway id) to a friendly label. Order here defines
 * the order shown in the picker.
 */
const RECOMMENDED: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /llama.*vision|vision.*llama/i, label: 'Llama Vision (local)' },
    { pattern: /gemini.*(flash|pro)/i, label: 'Gemini' },
    { pattern: /gpt-4o|gpt-4\.1|gpt-5|o4/i, label: 'GPT-4o' }
]

/**
 * Best-effort friendly label for any model id. Returns the curated label when
 * the id matches a recommended family, otherwise a lightly cleaned-up version
 * of the raw id.
 */
export function friendlyLabel(id: string): string {
    for (const entry of RECOMMENDED) {
        if (entry.pattern.test(id)) return entry.label
    }
    // Strip a vendor prefix and version suffixes for display.
    return id.replace(/^[a-z0-9]+\./i, '')
}

/**
 * Task-appropriate default models shown in the picker even when the gateway's
 * `/v1/models` is unreachable. These are the models the app actually reaches
 * across its fallback chain, ordered best-first.
 *
 *  - Copilot mode: vision chat models for "look at my screen, what's next?"
 *    (screenshots + PDFs). Includes the free fallback + on-device options.
 *  - Operator mode: computer-use-capable models for the autonomous agent.
 */
export function defaultRecommended(operatorMode: boolean): ModelOption[] {
    const rec = (id: string, label: string, sublabel?: string): ModelOption => ({
        id,
        label,
        sublabel,
        recommended: true
    })
    if (operatorMode) {
        // Lead with the free options that can drive the operator on your keys.
        // Gemini 2.5 Pro is the "stronger" pick: markedly better multi-step
        // judgment (fewer premature completions / off-goal detours) on the
        // same key, at tighter free-tier rate limits.
        return [
            rec('gemini-2.5-flash', 'Gemini 2.5 Flash', 'free, computer or browser use'),
            rec('gemini-2.5-pro', 'Gemini 2.5 Pro', 'stronger reasoning, tighter free limits'),
            rec('openrouter/free', 'OpenRouter Free', 'free, auto-selects')
        ]
    }
    return [
        rec('gemini-2.5-flash', 'Gemini 2.5 Flash', 'free'),
        rec('gpt-4o', 'GPT-4o', 'vision'),
        rec('openrouter/free', 'OpenRouter Free', 'free, auto-selects')
    ]
}

/**
 * Build the picker list for a mode: the task-appropriate recommended defaults
 * first, then any additional vision models the gateway actually reports (that
 * aren't already recommended) under "show all". Works fully offline.
 */
export function curateForMode(operatorMode: boolean, gatewayIds: string[]): CuratedModels {
    const recommended = defaultRecommended(operatorMode)
    const recIds = new Set(recommended.map((m) => m.id))
    const fromGateway = curateModels(gatewayIds)
    const others = [...fromGateway.recommended, ...fromGateway.others].filter(
        (m) => !recIds.has(m.id)
    )
    return { recommended, others }
}

/**
 * Split the raw model id list into recommended (curated, best-first) and other
 * vision-capable models. Non-vision models are dropped entirely.
 */
export function curateModels(ids: string[]): CuratedModels {
    const vision = ids.filter(isVisionCapable)
    const recommended: ModelOption[] = []
    const usedIds = new Set<string>()

    for (const entry of RECOMMENDED) {
        for (const id of vision) {
            if (usedIds.has(id)) continue
            if (entry.pattern.test(id)) {
                recommended.push({ id, label: entry.label, recommended: true })
                usedIds.add(id)
            }
        }
    }

    const others: ModelOption[] = vision
        .filter((id) => !usedIds.has(id))
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ id, label: friendlyLabel(id), recommended: false }))

    return { recommended, others }
}
