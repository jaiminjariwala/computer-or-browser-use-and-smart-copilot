/**
 * Vision-capability filtering (pure — Req 15.6, 21.7 / Property 26).
 *
 * Click Operator only ever drives vision-capable models: the reasoning loop
 * feeds screenshots to the provider, so a text-only model is useless and must
 * never be selectable. Everything here is pure and network-free, which is what
 * lets Property 26 exercise it directly.
 */

/**
 * A candidate model advertised by a provider, annotated with whether it can
 * process images. Providers determine `vision` from their model metadata (or
 * the {@link isVisionCapableModelId} heuristic for id-only servers).
 */
export interface ModelCandidate {
    id: string
    /** True iff the model can process images (Req 21.7). */
    vision: boolean
}

/**
 * The selectable model list for a provider: every non-vision model is excluded
 * (Req 15.6, 21.7). Order is preserved and ids are de-duplicated (an id is kept
 * once, the first time it appears as vision-capable).
 *
 * This is the pure core validated by Property 26.
 */
export function filterVisionModels(candidates: readonly ModelCandidate[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of candidates) {
        if (!c.vision) continue
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c.id)
    }
    return out
}

/**
 * Whether `modelId` may be selected/activated for a provider given its
 * advertised `candidates`: true **iff** the id appears as a vision-capable
 * model. A non-vision-capable model can never be made active (Req 21.7).
 */
export function isModelSelectable(candidates: readonly ModelCandidate[], modelId: string): boolean {
    return filterVisionModels(candidates).includes(modelId)
}

/** Substrings that mark a model id as belonging to a vision-capable family. */
const VISION_ID_MARKERS = [
    'gpt-4o',
    'gpt-4.1',
    'gpt-4-vision',
    'gpt-4-turbo',
    'o4',
    'gemini',
    'llava',
    'bakllava',
    'moondream',
    'llama-3.2-vision',
    'llama3.2-vision',
    'qwen-vl',
    'qwen2-vl',
    'qwen2.5-vl',
    'pixtral',
    'minicpm-v',
    'cogvlm',
    'internvl',
    'phi-3-vision',
    'phi-3.5-vision',
    'phi-4-multimodal',
    '-vl',
    'vision'
]

/**
 * Heuristic vision-capability check for a bare model id, used by providers that
 * only expose ids (e.g. an Ollama/LM-Studio `/models` list) without capability
 * metadata. Explicit {@link ModelCandidate.vision} flags always take precedence
 * over this heuristic where available.
 */
export function isVisionCapableModelId(modelId: string): boolean {
    const id = modelId.toLowerCase()
    return VISION_ID_MARKERS.some((m) => id.includes(m))
}
