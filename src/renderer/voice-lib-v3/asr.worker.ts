/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

/**
 * v3 speech-to-text worker — Moonshine (fastest + precise).
 *
 * Moonshine (UsefulSensors) is an encoder-decoder ASR model built for real-time
 * transcription on-device. It uses rotary position embeddings, so it handles
 * variable-length audio without Whisper's fixed 30s padding — which makes our
 * short interim clips transcribe very fast. `moonshine-base` beats Whisper-tiny
 * on accuracy while staying quick.
 *
 * Runs on WebGPU when available, falling back to single-thread WASM. Jobs are
 * serialized so the ONNX session is never re-entered concurrently.
 */

env.allowLocalModels = false

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Recognizer = any

const MODEL = 'onnx-community/moonshine-base-ONNX'

let loading: Promise<Recognizer> | null = null
let device = 'loading'

async function load(): Promise<Recognizer> {
    try {
        const rec = await pipeline('automatic-speech-recognition', MODEL, { device: 'webgpu' })
        device = 'webgpu'
        return rec
    } catch {
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.numThreads = 1
        }
        const rec = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm' })
        device = 'wasm'
        return rec
    }
}

function getRecognizer(): Promise<Recognizer> {
    if (!loading) loading = load()
    return loading
}

interface InMessage {
    id: number
    audio: Float32Array
}

/** Strip non-speech annotations and collapse whitespace. */
function cleanTranscript(text: string): string {
    return text
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<InMessage>) => void) | null
    postMessage: (msg: unknown) => void
}

let chain: Promise<void> = Promise.resolve()

ctx.onmessage = (e: MessageEvent<InMessage>): void => {
    const { id, audio } = e.data
    chain = chain.then(async () => {
        try {
            const recognize = await getRecognizer()
            // Moonshine handles variable-length audio natively — no chunk_length_s.
            const output = (await recognize(audio)) as { text?: string }
            ctx.postMessage({ id, text: cleanTranscript(output?.text ?? ''), device })
        } catch (err) {
            ctx.postMessage({
                id,
                error: err instanceof Error ? err.message : String(err)
            })
        }
    })
}
