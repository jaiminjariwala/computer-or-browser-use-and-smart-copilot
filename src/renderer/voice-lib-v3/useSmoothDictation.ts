import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * voice-lib-v3 — Moonshine (WebGPU) dictation with smooth character reveal.
 *
 * Same UX contract as v1/v2 (record → live text → instant stop → append →
 * cancel), but the worker runs the Moonshine ASR model, which is faster and
 * more precise for short real-time clips than Whisper. Self-contained so it
 * can't regress the frozen v1/v2 baselines.
 */

export interface Dictation {
    supported: boolean
    listening: boolean
    transcribing: boolean
    start: () => void
    stop: () => void
    toggle: () => void
    /** Stop immediately, clear the live buffer, and empty the field. */
    cancel: () => void
}

export interface SmoothDictationOptions {
    getText: () => string
    setText: (text: string) => void
    onError?: (message: string) => void
    revealMs?: number
}

const TARGET_RATE = 16000
// Moonshine is fast, so we can poll aggressively for a near-real-time feel.
const INTERIM_MS = 250
const FIRST_PASS_MS = 100

// --- Worker plumbing --------------------------------------------------------

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
        worker.onerror = (event: ErrorEvent): void => {
            // Drop the dead worker so the next attempt rebuilds it (a broken
            // worker left in place would swallow future posts and hang the UI),
            // and reject anything waiting with the real reason.
            const detail = event?.message ? `Speech worker error: ${event.message}` : 'Speech worker failed to load.'
            worker = null
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: detail })
            }
        }
        worker.onmessageerror = (): void => {
            worker = null
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: 'Speech worker message could not be decoded.' })
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

export function useSmoothDictation(options: SmoothDictationOptions): Dictation {
    const { getText, setText, onError } = options
    const revealMs = options.revealMs ?? 16

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
    const emittedRef = useRef(false)
    const baseRef = useRef('')

    const targetRef = useRef('')
    const curRef = useRef('')
    const revealRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const getTextRef = useRef(getText)
    const setTextRef = useRef(setText)
    const onErrorRef = useRef(onError)
    useEffect(() => {
        getTextRef.current = getText
        setTextRef.current = setText
        onErrorRef.current = onError
    }, [getText, setText, onError])

    const revealTick = useCallback(() => {
        const target = targetRef.current
        const cur = curRef.current
        if (cur === target) {
            if (!listeningRef.current && revealRef.current !== null) {
                clearInterval(revealRef.current)
                revealRef.current = null
            }
            return
        }
        let next: string
        if (target.startsWith(cur)) {
            const step = Math.max(4, Math.ceil((target.length - cur.length) / 5))
            next = target.slice(0, Math.min(target.length, cur.length + step))
        } else {
            next = target
        }
        curRef.current = next
        setTextRef.current(next)
    }, [])

    const ensureReveal = useCallback(() => {
        if (revealRef.current === null) revealRef.current = setInterval(revealTick, revealMs)
    }, [revealTick, revealMs])

    const pushTarget = useCallback(
        (sessionText: string) => {
            const base = baseRef.current.replace(/\s+$/, '')
            const combined = base.length > 0 ? `${base} ${sessionText}` : sessionText
            emittedRef.current = true
            targetRef.current = combined
            ensureReveal()
        },
        [ensureReveal]
    )

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

    const runInference = useCallback(
        async (audio: Float32Array, isFinal: boolean): Promise<void> => {
            if (audio.length === 0) return
            if (!isFinal && inferringRef.current) return
            inferringRef.current = true
            try {
                const text = await transcribeInWorker(audio)
                if (text.length > 0 && (isFinal || listeningRef.current)) {
                    pushTarget(text)
                }
            } catch (err) {
                onErrorRef.current?.(err instanceof Error ? err.message : String(err))
            } finally {
                inferringRef.current = false
            }
        },
        [pushTarget]
    )

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
        if (audio.length === 0 || emittedRef.current) return
        setTranscribing(true)
        void runInference(audio, true).finally(() => setTranscribing(false))
    }, [listening, teardown, snapshotAudio, runInference])

    const start = useCallback(() => {
        if (!supported || listening || transcribing) return
        chunksRef.current = []
        emittedRef.current = false
        baseRef.current = getTextRef.current()
        curRef.current = baseRef.current
        targetRef.current = baseRef.current
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
                ensureReveal()
                setTimeout(() => {
                    void runInference(snapshotAudio(), false)
                }, FIRST_PASS_MS)
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
    }, [supported, listening, transcribing, teardown, snapshotAudio, runInference, ensureReveal])

    const toggle = useCallback(() => {
        if (listening) stop()
        else start()
    }, [listening, start, stop])

    const cancel = useCallback(() => {
        setListening(false)
        listeningRef.current = false
        setTranscribing(false)
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        if (revealRef.current !== null) {
            clearInterval(revealRef.current)
            revealRef.current = null
        }
        teardown()
        chunksRef.current = []
        emittedRef.current = false
        baseRef.current = ''
        targetRef.current = ''
        curRef.current = ''
        setTextRef.current('')
    }, [teardown])

    useEffect(
        () => () => {
            teardown()
            if (revealRef.current !== null) clearInterval(revealRef.current)
        },
        [teardown]
    )

    return { supported, listening, transcribing, start, stop, toggle, cancel }
}
