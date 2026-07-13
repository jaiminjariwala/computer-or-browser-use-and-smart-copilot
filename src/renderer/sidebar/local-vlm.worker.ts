/// <reference lib="webworker" />
import {
    AutoProcessor,
    AutoModelForVision2Seq,
    RawImage,
    pipeline,
    env
} from '@huggingface/transformers'

/**
 * Zero-config local fallback model chain (Task: free open-source fallback).
 *
 * Runs open models entirely on-device via transformers.js, so the app keeps
 * working for free with no settings, no key, and no network provider when the
 * network providers are unavailable.
 *
 * There are two chains, picked by the request:
 *
 *   - WITH screenshots -> a vision chain (SmolVLM), which can read the image and
 *     give a next step grounded in what is on screen.
 *   - WITHOUT screenshots (a plain typed question) -> a TEXT chain (SmolLM2),
 *     because a vision model cannot answer when there is no image to look at,
 *     which is why a text-only question previously failed here.
 *
 * Each chain tries its models in order of increasing size, and each model tries
 * WebGPU first then WASM, so if one cannot load or generate on this machine the
 * next is attempted. All models are Apache-2.0 and download once on first use.
 *
 * NOTE: bigger open multimodal models (GLM, MiniMax, Qwen-VL, etc.) are
 * server-scale (billions of params) and cannot run in-browser; they'd need a
 * hosted API + key, which is why the on-device chains use small models.
 */

env.allowLocalModels = false

// Vision models, BEST first (used when the request carries screenshots). The
// larger 500M gives noticeably better screen advice; we fall back to the tiny
// 256M only if the bigger one cannot load (e.g. low memory / no WebGPU), so the
// first-run experience is as good as the machine allows.
const VISION_MODEL_IDS = [
    'HuggingFaceTB/SmolVLM-500M-Instruct',
    'HuggingFaceTB/SmolVLM-256M-Instruct'
]

// Text models, BEST first (used for a plain typed question, no image). The 1.7B
// model writes much more coherent prose + code than the 360M, so a recruiter who
// downloads the app and just starts typing gets a good answer with no key; the
// 360M remains a fast fallback if the larger model cannot load.
const TEXT_MODEL_IDS = [
    'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    'HuggingFaceTB/SmolLM2-360M-Instruct'
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Vision = { id: string; processor: any; model: any }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Text = { id: string; generator: any }

let vision: Vision | null = null
let text: Text | null = null
// Index of the next model to try in each chain. Advances only on failure.
let visionStart = 0
let textStart = 0

/**
 * Set for the duration of a request so the model loaders can stream download
 * progress back to the UI (the first on-device answer downloads the model, which
 * takes a while — we surface a "downloading" indicator instead of a silent hang).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reportProgress: ((p: any) => void) | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progressCallback = (p: any): void => reportProgress?.(p)

async function loadVision(id: string): Promise<Vision> {
    try {
        const processor = await AutoProcessor.from_pretrained(id, { progress_callback: progressCallback })
        const model = await AutoModelForVision2Seq.from_pretrained(id, {
            dtype: { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' },
            device: 'webgpu',
            progress_callback: progressCallback
        })
        return { id, processor, model }
    } catch {
        const processor = await AutoProcessor.from_pretrained(id, { progress_callback: progressCallback })
        const model = await AutoModelForVision2Seq.from_pretrained(id, {
            device: 'wasm',
            progress_callback: progressCallback
        })
        return { id, processor, model }
    }
}

async function loadText(id: string): Promise<Text> {
    try {
        const generator = await pipeline('text-generation', id, {
            dtype: 'q4',
            device: 'webgpu',
            progress_callback: progressCallback
        })
        return { id, generator }
    } catch {
        const generator = await pipeline('text-generation', id, {
            device: 'wasm',
            progress_callback: progressCallback
        })
        return { id, generator }
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateVision(m: Vision, imgs: any[], prompt: string): Promise<string> {
    const content = [...imgs.map(() => ({ type: 'image' })), { type: 'text', text: prompt }]
    const messages = [{ role: 'user', content }]
    const templated = m.processor.apply_chat_template(messages, { add_generation_prompt: true })
    const inputs = await m.processor(templated, imgs)
    const generated = await m.model.generate({
        ...inputs,
        max_new_tokens: 512,
        do_sample: false,
        // Stop the small model from looping the same phrase over and over.
        repetition_penalty: 1.3,
        no_repeat_ngram_size: 3
    })
    const decoded = m.processor.batch_decode(
        generated.slice(null, [inputs.input_ids.dims.at(-1), null]),
        { skip_special_tokens: true }
    )
    return String(decoded?.[0] ?? '').trim()
}

async function generateText(m: Text, prompt: string): Promise<string> {
    const messages = [{ role: 'user', content: prompt }]
    const output = await m.generator(messages, {
        max_new_tokens: 512,
        do_sample: false,
        // A repetition penalty + no-repeat n-gram window stop the tiny model from
        // falling into the "The map method... The map method..." loops.
        repetition_penalty: 1.3,
        no_repeat_ngram_size: 3
    })
    // With a chat-message input the pipeline returns the full conversation; the
    // assistant reply is the last message. Fall back to raw string shapes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen: any = Array.isArray(output) ? output[0]?.generated_text : output
    if (Array.isArray(gen)) {
        const last = gen[gen.length - 1]
        return String(last?.content ?? '').trim()
    }
    return String(gen ?? '').trim()
}

/** Answer a request WITH screenshots using the first working vision model. */
async function answerVision(images: string[], prompt: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgs: any[] = []
    for (const url of images.slice(0, 2)) imgs.push(await RawImage.fromURL(url))

    let lastErr: unknown = new Error('No local vision model available.')
    for (let i = visionStart; i < VISION_MODEL_IDS.length; i += 1) {
        try {
            if (!vision || vision.id !== VISION_MODEL_IDS[i]) {
                vision = await loadVision(VISION_MODEL_IDS[i])
            }
            return await generateVision(vision, imgs, prompt)
        } catch (err) {
            lastErr = err
            vision = null
            visionStart = i + 1
        }
    }
    throw lastErr
}

/** Answer a plain typed question (no image) using the first working text model. */
async function answerText(prompt: string): Promise<string> {
    let lastErr: unknown = new Error('No local text model available.')
    for (let i = textStart; i < TEXT_MODEL_IDS.length; i += 1) {
        try {
            if (!text || text.id !== TEXT_MODEL_IDS[i]) {
                text = await loadText(TEXT_MODEL_IDS[i])
            }
            return await generateText(text, prompt)
        } catch (err) {
            lastErr = err
            text = null
            textStart = i + 1
        }
    }
    throw lastErr
}

/** Pick the right on-device chain: vision when images are present, else text. */
async function answer(images: string[], prompt: string): Promise<string> {
    return images.length > 0 ? answerVision(images, prompt) : answerText(prompt)
}

interface InMessage {
    id: number
    images: string[]
    prompt: string
}

const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<InMessage>) => void) | null
    postMessage: (msg: unknown) => void
}

// Serialize generations so an ONNX session is never re-entered concurrently.
let chain: Promise<void> = Promise.resolve()

ctx.onmessage = (e: MessageEvent<InMessage>): void => {
    const { id, images, prompt } = e.data
    chain = chain.then(async () => {
        // Stream model-download progress for THIS request to the UI.
        reportProgress = (p) => ctx.postMessage({ id, progress: p })
        try {
            const reply = await answer(images, prompt)
            ctx.postMessage({ id, text: reply })
        } catch (err) {
            ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
        } finally {
            reportProgress = null
        }
    })
}
