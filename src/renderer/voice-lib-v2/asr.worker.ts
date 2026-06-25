/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

/**
 * v2 speech-to-text worker — WebGPU accelerated (transformers.js v3).
 *
 * Tries the WebGPU backend first (often 10-100x faster than WASM, enough to run
 * a more accurate model in real time); transparently falls back to single-thread
 * WASM + a tiny model if WebGPU is unavailable. Jobs are serialized so the ONNX
 * session is never re-entered concurrently.
 */

env.allowLocalModels = false

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Recognizer = any

let loading: Promise<Recognizer> | null = null
let device = 'loading'

async function load(): Promise<Recognizer> {
    try {
        // Keep the encoder in fp32 for accuracy but quantize the (much larger)
        // decoder to q4. fp32/fp32 for whisper-base routinely exhausts WebGPU
        // memory and loses the device, which surfaces as an uncaught worker
        // error; this is the config the transformers.js WebGPU examples use.
        const rec = await pipeline(
            'automatic-speech-recognition',
            'onnx-community/whisper-base.en',
            {
                device: 'webgpu',
                dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
            }
        )
        device = 'webgpu'
        return rec
    } catch {
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.numThreads = 1
        }
        const rec = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
            device: 'wasm'
        })
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

/** Strip Whisper's non-speech annotations and collapse whitespace. */
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
            const output = (await recognize(audio, {
                chunk_length_s: 30,
                return_timestamps: false
            })) as { text?: string }
            ctx.postMessage({ id, text: cleanTranscript(output?.text ?? ''), device })
        } catch (err) {
            ctx.postMessage({
                id,
                error: err instanceof Error ? err.message : String(err)
            })
        }
    })
}
