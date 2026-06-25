import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Voice dictation hook (speech-to-text) — the stable v1 baseline.
 *
 * The browser SpeechRecognition API doesn't work in Electron and the gateway
 * has no audio endpoint, so dictation runs Whisper on-device via transformers.js
 * inside a dedicated Web Worker (see `asr.worker.ts`). The worker keeps all
 * inference off the UI thread, which makes smooth live updates possible: while
 * recording we periodically transcribe the audio captured so far and stream the
 * text out, then optionally do one final pass on stop. The model (~40 MB) is
 * fetched once on first use and cached; everything after runs locally.
 *
 * This emits raw transcript text. For the smooth character-reveal UX, wrap it
 * with {@link useSmoothDictation}.
 */

export interface Dictation {
    supported: boolean
    listening: boolean
    transcribing: boolean
    start: () => void
    stop: () => void
    toggle: () => void
}

export interface DictationOptions {
    onText: (text: string) => void
    onFinal?: (text: string) => void
    onError?: (message: string) => void
    /**
     * Returns the text already present when a recording session starts. New
     * dictation is appended after it (rather than overwriting), so toggling the
     * mic off and on continues from where you left off.
     */
    getBaseText?: () => string
}

const TARGET_RATE = 16000
const INTERIM_MS = 450

// --- Worker plumbing (singleton, shared across hook instances) --------------

let worker: Worker | null = null
let reqId = 0
const pending = new Map<number, (r: { text?: string; error?: string }) => void>()

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (
            e: MessageEvent<{ id: number; text?: string; error?: string }>
        ): void => {
            const cb = pending.get(e.data.id)
            if (cb) {
                pending.delete(e.data.id)
                cb(e.data)
            }
        }
        worker.onerror = (): void => {
            // Reject everything in flight so callers can surface the failure.
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: 'Speech worker failed to load.' })
            }
        }
    }
    return worker
}

function transcribeInWorker(audio: Float32Array): Promise<string> {
    return new Promise((resolve, reject) => {
        const id = ++reqId
        pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text ?? '')))
        getWorker().postMessage({ id, audio })
    })
}

// --- Audio helpers ----------------------------------------------------------

/** Average-downsample a Float32 PCM buffer to the target sample rate. */
function downsample(buffer: Float32Array, inRate: number, outRate: number): Float32Array {
    if (outRate >= inRate) return buffer
    const ratio = inRate / outRate
    const outLen = Math.round(buffer.length / ratio)
    const result = new Float32Array(outLen)
    let outOffset = 0
    let inOffset = 0
    while (outOffset < outLen) {
        const nextIn = Math.round((outOffset + 1) * ratio)
        let accum = 0
        let count = 0
        for (let i = inOffset; i < nextIn && i < buffer.length; i++) {
            accum += buffer[i]
            count++
        }
        result[outOffset] = count > 0 ? accum / count : 0
        outOffset++
        inOffset = nextIn
    }
    return result
}

export function useDictation(options: DictationOptions): Dictation {
    const { onText, onFinal, onError } = options
    const [listening, setListening] = useState(false)
    const [transcribing, setTranscribing] = useState(false)
    const supported = useRef<boolean>(
        typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    ).current

    const streamRef = useRef<MediaStream | null>(null)
    const ctxRef = useRef<AudioContext | null>(null)
    const processorRef = useRef<ScriptProcessorNode | null>(null)
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
    const chunksRef = useRef<Float32Array[]>([])
    const rateRef = useRef<number>(TARGET_RATE)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const inferringRef = useRef(false)
    const listeningRef = useRef(false)
    // Whether any interim result has been shown this session (used to decide if
    // a final pass is needed on stop).
    const emittedRef = useRef(false)
    // Text already present when this recording session began; new dictation is
    // appended after it so on/off toggling continues rather than overwrites.
    const baseRef = useRef('')

    const onTextRef = useRef(onText)
    const onFinalRef = useRef(onFinal)
    const onErrorRef = useRef(onError)
    const getBaseTextRef = useRef(options.getBaseText)
    useEffect(() => {
        onTextRef.current = onText
        onFinalRef.current = onFinal
        onErrorRef.current = onError
        getBaseTextRef.current = options.getBaseText
    }, [onText, onFinal, onError, options.getBaseText])

    /** Combine the session's base text with the latest transcript and emit. */
    const emit = useCallback((sessionText: string, isFinal: boolean): void => {
        const base = baseRef.current.replace(/\s+$/, '')
        const combined = base.length > 0 ? `${base} ${sessionText}` : sessionText
        emittedRef.current = true
        onTextRef.current(combined)
        if (isFinal) onFinalRef.current?.(combined)
    }, [])

    /** Concatenate everything captured so far (without clearing) at 16 kHz. */
    const snapshotAudio = useCallback((): Float32Array => {
        const chunks = chunksRef.current
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const merged = new Float32Array(total)
        let off = 0
        for (const c of chunks) {
            merged.set(c, off)
            off += c.length
        }
        return downsample(merged, rateRef.current, TARGET_RATE)
    }, [])

    /** Transcribe via the worker and push text out (interim or final). */
    const runInference = useCallback(async (audio: Float32Array, isFinal: boolean): Promise<void> => {
        if (audio.length === 0) return
        if (!isFinal && inferringRef.current) return
        inferringRef.current = true
        try {
            const text = await transcribeInWorker(audio)
            // Late interim results must not clobber the final transcript.
            if (text.length > 0 && (isFinal || listeningRef.current)) {
                emit(text, isFinal)
            }
        } catch (err) {
            onErrorRef.current?.(err instanceof Error ? err.message : String(err))
        } finally {
            inferringRef.current = false
        }
    }, [emit])

    const teardown = useCallback((): void => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        processorRef.current?.disconnect()
        sourceRef.current?.disconnect()
        if (ctxRef.current && ctxRef.current.state !== 'closed') {
            void ctxRef.current.close()
        }
        streamRef.current?.getTracks().forEach((t) => t.stop())
        processorRef.current = null
        sourceRef.current = null
        ctxRef.current = null
        streamRef.current = null
    }, [])

    const stop = useCallback(() => {
        if (!listening) return
        setListening(false)
        listeningRef.current = false
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }

        const audio = snapshotAudio()
        chunksRef.current = []
        teardown()

        // Live interim updates already populated the field. To make stopping
        // feel instant, don't run another (slow) pass unless nothing has been
        // transcribed yet this session (e.g. a very short utterance).
        if (audio.length === 0 || emittedRef.current) return
        setTranscribing(true)
        void runInference(audio, true).finally(() => setTranscribing(false))
    }, [listening, teardown, snapshotAudio, runInference])

    const start = useCallback(() => {
        if (!supported || listening || transcribing) return
        chunksRef.current = []
        emittedRef.current = false
        // Snapshot the current field text so this session appends to it.
        baseRef.current = getBaseTextRef.current?.() ?? ''
        void navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then((stream) => {
                streamRef.current = stream
                const Ctx =
                    window.AudioContext ||
                    (window as unknown as { webkitAudioContext: typeof AudioContext })
                        .webkitAudioContext
                const ctx = new Ctx()
                ctxRef.current = ctx
                rateRef.current = ctx.sampleRate
                const source = ctx.createMediaStreamSource(stream)
                sourceRef.current = source
                const processor = ctx.createScriptProcessor(4096, 1, 1)
                processorRef.current = processor
                processor.onaudioprocess = (e: AudioProcessingEvent): void => {
                    chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
                }
                source.connect(processor)
                processor.connect(ctx.destination)
                setListening(true)
                listeningRef.current = true
                // Fire the first pass almost immediately so the opening word
                // appears right away, then keep updating on the interval.
                setTimeout(() => {
                    void runInference(snapshotAudio(), false)
                }, 160)
                intervalRef.current = setInterval(() => {
                    void runInference(snapshotAudio(), false)
                }, INTERIM_MS)
            })
            .catch((err) => {
                onErrorRef.current?.(
                    err instanceof Error ? err.message : 'Could not access the microphone.'
                )
                teardown()
                setListening(false)
                listeningRef.current = false
            })
    }, [supported, listening, transcribing, teardown, snapshotAudio, runInference])

    const toggle = useCallback(() => {
        if (listening) stop()
        else start()
    }, [listening, start, stop])

    useEffect(() => {
        return () => teardown()
    }, [teardown])

    return { supported, listening, transcribing, start, stop, toggle }
}
