import type { SessionContext } from '@shared/types'

/**
 * Renderer-side glue for the zero-config local fallback model.
 *
 * When the gateway fails, the main process forwards the derived
 * {@link SessionContext}; this module turns that into a compact prompt + image
 * set and runs SmolVLM in a Web Worker (so the UI never blocks), returning the
 * answer text. The worker downloads the model once on first use and then runs
 * fully offline.
 */

let worker: Worker | null = null
let reqId = 0
const pending = new Map<number, (r: { text?: string; error?: string }) => void>()

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('./local-vlm.worker.ts', import.meta.url), { type: 'module' })
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
            const detail = event?.message
                ? `Local model error: ${event.message}`
                : 'Local model failed to load.'
            worker = null
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: detail })
            }
        }
    }
    return worker
}

/** Run the local model on the given images + prompt. Rejects on failure. */
export function runLocalFallback(images: string[], prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const id = ++reqId
        pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text ?? '')))
        getWorker().postMessage({ id, images, prompt })
    })
}

/**
 * Flatten a {@link SessionContext} into the images + short prompt the local
 * model needs: every screenshot in play, plus the running goal and the recent
 * turns so the answer stays on-topic.
 */
export function buildFallbackRequest(ctx: SessionContext): { images: string[]; prompt: string } {
    const images: string[] = []
    const pushUnique = (url?: string): void => {
        if (url && !images.includes(url)) images.push(url)
    }
    for (const turn of ctx.recentTurns ?? []) {
        pushUnique(turn.capture?.dataUrl)
        for (const cap of turn.captures ?? []) pushUnique(cap.dataUrl)
    }
    pushUnique(ctx.currentCapture?.dataUrl)

    const lines: string[] = [
        'You are Smart Copilot, a screen co-pilot. Look at the screenshot(s) and give a clear, concise next step or answer.'
    ]
    const goal = ctx.summary?.inferredIntent?.trim()
    if (goal) lines.push(`The user's goal so far: ${goal}`)
    for (const turn of ctx.recentTurns ?? []) {
        const text = turn.text?.trim()
        if (text) lines.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
    }

    // Keep only the most recent images to stay fast on the tiny model.
    return { images: images.slice(-2), prompt: lines.join('\n') }
}
