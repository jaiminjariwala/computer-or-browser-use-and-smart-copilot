import { describe, it, expect } from 'vitest'
import {
    createServer,
    type IncomingMessage,
    type Server
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
    GatewayConfig,
    SessionContext,
    SessionSummary,
    Turn,
    TurnCapture
} from '@shared/types'
import {
    GatewayAIClient,
    GlassErrorException,
    SUMMARY_SYSTEM_PROMPT,
    SYSTEM_PROMPT
} from './ai'

/**
 * Integration tests for {@link GatewayAIClient} against a *real* OpenAI SDK
 * transport (task 4.4). Unlike `ai.test.ts`, these tests do NOT inject a fake
 * `ChatClient`: the client is built with the default {@link createGatewayClient}
 * factory so the genuine `openai` SDK serializes and POSTs the request over
 * HTTP. We stand up a throwaway localhost server, point `baseURL` at it, and
 * assert the actual wire behavior:
 *
 *  - the OpenAI-compatible POST to `/chat/completions` (Req 7.1),
 *  - the configured credentials on the `Authorization` header (Req 7.2),
 *  - the running session summary system message and the `image_url` vision
 *    content parts in the request body (Req 5.1), and
 *  - that a non-2xx gateway response surfaces a typed `gateway-failed`
 *    {@link GlassError} without mutating the session context (Req 7.3).
 */

// --- Stub OpenAI-compatible server -----------------------------------------

interface RecordedRequest {
    method?: string
    url?: string
    headers: IncomingMessage['headers']
    body: {
        model?: string
        messages?: Array<{ role: string; content: unknown }>
    }
}

interface StubResponse {
    status: number
    body: unknown
}

interface StubServer {
    baseURL: string
    requests: RecordedRequest[]
    close: () => Promise<void>
}

/**
 * Start a localhost HTTP server that records every request it receives and
 * replies with whatever `responder` returns. The returned `baseURL` is shaped
 * like an OpenAI-compatible gateway root, so the SDK appends
 * `/chat/completions` to it.
 */
async function startStubServer(
    responder: (req: RecordedRequest) => StubResponse
): Promise<StubServer> {
    const requests: RecordedRequest[] = []
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk as Buffer))
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let body: RecordedRequest['body'] = {}
            try {
                body = raw.length > 0 ? JSON.parse(raw) : {}
            } catch {
                body = {}
            }
            const recorded: RecordedRequest = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body
            }
            requests.push(recorded)
            const { status, body: responseBody } = responder(recorded)
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(responseBody))
        })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve()))
            )
    }
}

/** A successful OpenAI-compatible chat-completion response payload. */
function chatCompletionResponse(content: string): unknown {
    return {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'vision-model',
        choices: [
            { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }
}

// --- Fixtures ---------------------------------------------------------------

const API_KEY = 'secret-test-key'
const rect = { x: 0, y: 0, width: 10, height: 10 }

function capture(dataUrl: string): TurnCapture {
    return { dataUrl, thumbnailUrl: `${dataUrl}#thumb`, rect }
}

function userTurn(id: string, text?: string, cap?: TurnCapture): Turn {
    return {
        id,
        role: 'user',
        text,
        capture: cap,
        createdAt: '2024-01-01T00:00:00Z',
        status: 'ok'
    }
}

const emptySummary: SessionSummary = {
    inferredIntent: '',
    completedSteps: [],
    updatedThroughTurnId: null
}

/**
 * Build a real {@link GatewayAIClient} that talks to `baseURL` through the
 * genuine `openai` SDK (no `createClient` override → default factory).
 */
function makeRealClient(baseURL: string): GatewayAIClient {
    const config: GatewayConfig = { baseURL, model: 'vision-model' }
    return new GatewayAIClient({
        getConfig: async () => config,
        getApiKey: async () => API_KEY
    })
}

/** Locate the first message whose content carries an `image_url` part. */
function findImageMessage(messages: Array<{ role: string; content: unknown }> | undefined) {
    return (messages ?? []).find(
        (m) =>
            Array.isArray(m.content) &&
            m.content.some(
                (part: unknown) =>
                    typeof part === 'object' &&
                    part !== null &&
                    (part as { type?: string }).type === 'image_url'
            )
    )
}

// --- complete(): request shape + credentials over the wire ------------------

describe('GatewayAIClient integration — complete request shape (Req 5.1, 7.1, 7.2)', () => {
    it('POSTs an OpenAI-compatible chat completion with credentials, summary, and vision parts', async () => {
        const server = await startStubServer(() => ({
            status: 200,
            body: chatCompletionResponse('Next: click Add permissions')
        }))
        try {
            const ai = makeRealClient(server.baseURL)
            const ctx: SessionContext = {
                summary: {
                    inferredIntent: 'Grant DynamoDB access',
                    completedSteps: ['Opened IAM'],
                    updatedThroughTurnId: 't0'
                },
                recentTurns: [userTurn('t1', 'stuck on IAM')],
                currentCapture: capture('data:image/png;base64,AAAA')
            }

            const out = await ai.complete(ctx)
            expect(out).toBe('Next: click Add permissions')

            expect(server.requests).toHaveLength(1)
            const req = server.requests[0]

            // OpenAI-compatible POST to /chat/completions (Req 7.1).
            expect(req.method).toBe('POST')
            expect(req.url).toMatch(/\/chat\/completions$/)

            // Configured credentials attached to every request (Req 7.2).
            expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`)

            // Configured model carried in the body.
            expect(req.body.model).toBe('vision-model')

            // Behavior-contract system message first, running summary second
            // so every request carries session context (Req 5.1, Property 1).
            const messages = req.body.messages ?? []
            expect(messages[0]).toMatchObject({ role: 'system', content: SYSTEM_PROMPT })
            expect(messages[1].role).toBe('system')
            expect(messages[1].content).toContain('Session summary')
            expect(messages[1].content).toContain('Grant DynamoDB access')

            // Vision content parts: an image_url grounded capture (Req 5.1).
            const imageMessage = findImageMessage(messages)
            expect(imageMessage).toBeDefined()
            const parts = imageMessage!.content as Array<{
                type: string
                image_url?: { url: string }
            }>
            const imagePart = parts.find((p) => p.type === 'image_url')
            expect(imagePart?.image_url?.url).toBe('data:image/png;base64,AAAA')
        } finally {
            await server.close()
        }
    })
})

// --- summarize(): summary system message over the wire ----------------------

describe('GatewayAIClient integration — summarize request shape (Req 6, 7.1, 7.2)', () => {
    it('POSTs the summary system message with credentials and merges the response', async () => {
        const server = await startStubServer(() => ({
            status: 200,
            body: chatCompletionResponse(
                '{"inferredIntent":"grant access","completedSteps":["opened IAM","selected user"]}'
            )
        }))
        try {
            const ai = makeRealClient(server.baseURL)
            const prev: SessionSummary = {
                inferredIntent: 'old intent',
                completedSteps: ['opened IAM'],
                updatedThroughTurnId: null
            }

            const result = await ai.summarize([userTurn('t9', 'context')], prev)

            // Response is parsed and merged (steps only grow).
            expect(result.inferredIntent).toBe('grant access')
            expect(result.completedSteps).toEqual(['opened IAM', 'selected user'])
            expect(result.updatedThroughTurnId).toBe('t9')

            expect(server.requests).toHaveLength(1)
            const req = server.requests[0]
            expect(req.method).toBe('POST')
            expect(req.url).toMatch(/\/chat\/completions$/)
            expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`)

            // The summarization instruction leads the request (summary system message).
            const messages = req.body.messages ?? []
            expect(messages[0]).toMatchObject({
                role: 'system',
                content: SUMMARY_SYSTEM_PROMPT
            })
        } finally {
            await server.close()
        }
    })
})

// --- Failure mapping over the wire (Req 7.3, Property 6) ---------------------

describe('GatewayAIClient integration — gateway failure mapping (Req 7.3)', () => {
    it('maps a non-2xx complete response to gateway-failed without mutating the session', async () => {
        // 4xx is not retried by the SDK, keeping the test deterministic/fast.
        const server = await startStubServer(() => ({
            status: 400,
            body: { error: { message: 'bad request from gateway', type: 'invalid_request' } }
        }))
        try {
            const ai = makeRealClient(server.baseURL)
            const ctx: SessionContext = {
                summary: {
                    inferredIntent: 'goal',
                    completedSteps: ['a'],
                    updatedThroughTurnId: 't0'
                },
                recentTurns: [userTurn('t1', 'hi')],
                currentCapture: capture('data:image/png;base64,BBBB')
            }
            const snapshot = JSON.parse(JSON.stringify(ctx))

            const err = await ai.complete(ctx).catch((e) => e)
            expect(err).toBeInstanceOf(GlassErrorException)
            expect(err.glassError.kind).toBe('gateway-failed')
            expect(err.glassError.recoverable).toBe(true)
            expect(err.glassError.action).toBe('retry')

            // The session context is untouched by a failed request (Property 6).
            expect(ctx).toEqual(snapshot)
        } finally {
            await server.close()
        }
    })

    it('maps a non-2xx summarize response to gateway-failed without mutating prior summary or turns', async () => {
        const server = await startStubServer(() => ({
            status: 400,
            body: { error: { message: 'bad request from gateway', type: 'invalid_request' } }
        }))
        try {
            const ai = makeRealClient(server.baseURL)
            const prev: SessionSummary = {
                inferredIntent: 'keep me',
                completedSteps: ['s1'],
                updatedThroughTurnId: 't1'
            }
            const turns = [userTurn('t2', 'x')]
            const prevSnapshot = JSON.parse(JSON.stringify(prev))
            const turnsSnapshot = JSON.parse(JSON.stringify(turns))

            const err = await ai.summarize(turns, prev).catch((e) => e)
            expect(err).toBeInstanceOf(GlassErrorException)
            expect(err.glassError.kind).toBe('gateway-failed')

            expect(prev).toEqual(prevSnapshot)
            expect(turns).toEqual(turnsSnapshot)
        } finally {
            await server.close()
        }
    })
})
