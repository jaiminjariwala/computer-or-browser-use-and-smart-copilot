/// <reference lib="webworker" />
import { pipeline, env, type Pipeline } from '@xenova/transformers'

/**
 * Dedicated speech-to-text worker.
 *
 * Runs Whisper (transformers.js) entirely off the UI thread so live/interim
 * transcription never freezes the app. The main thread posts `{ id, audio }`
 * (16 kHz mono Float32 PCM); the worker replies `{ id, text }` or
 * `{ id, error }`. Jobs are serialized so the ONNX runtime is never re-entered
 * concurrently.
 */

env.allowLocalModels = false
env.backends.onnx.wasm.numThreads = 1

const MODEL = 'Xenova/whisper-tiny.en'

let recognizer: Pipeline | null = null
let loading: Promise<Pipeline> | null = null

async function getRecognizer(): Promise<Pipeline> {
    if (recognizer) return recognizer
    if (!loading) {
        loading = pipeline('automatic-speech-recognition', MODEL) as Promise<Pipeline>
    }
    recognizer = await loading
    return recognizer
}

interface InMessage {
    id: number
    audio: Float32Array
}

/**
 * Strip Whisper's non-speech annotations (e.g. "[BLANK_AUDIO]", "[ Silence ]",
 * "(music)") that it emits for silence/noise between sentences, and collapse
 * whitespace.
 */
function cleanTranscript(text: string): string {
    return text
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// Avoid depending on the WebWorker lib's exact global typing.
const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<InMessage>) => void) | null
    postMessage: (msg: unknown) => void
}

// Serialize jobs: the ONNX session must not run concurrently.
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
            ctx.postMessage({ id, text: cleanTranscript(output?.text ?? '') })
        } catch (err) {
            ctx.postMessage({
                id,
                error: err instanceof Error ? err.message : String(err)
            })
        }
    })
}
