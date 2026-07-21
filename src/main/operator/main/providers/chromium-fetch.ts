import { net } from 'electron'

/**
 * Chromium-backed fetch for the operator's OpenAI-compatible clients.
 *
 * Node's undici fetch (the `openai` SDK default) intermittently drops
 * Gemini's responses mid-body ("Premature close"), which made the operator's
 * availability probe mark Gemini permanently unavailable and fail every
 * Reasoning_Step with `all-providers-failed`. Chromium's network stack does
 * not exhibit the bug, so — exactly like the copilot chat client
 * (src/main/ai.ts) — requests are routed through Electron's `net.fetch`.
 *
 * This is a VENDORED copy of the chat-side helper: the operator engine stays
 * import-isolated from copilot modules by design, so the ~30 lines are
 * duplicated rather than shared.
 */

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
 * fetch (unit tests, where the `electron` import resolves without bindings).
 */
export const chromiumFetch: typeof fetch =
    typeof net?.fetch === 'function'
        ? sanitizedChromiumFetch(net.fetch.bind(net) as typeof fetch)
        : fetch
