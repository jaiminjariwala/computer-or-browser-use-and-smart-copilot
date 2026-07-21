import { describe, it, expect } from 'vitest'
import type { ReasoningContext } from '@op-shared/types'
import { OpenAICompatibleProvider } from './providers'
import type { OperatorChatClient, OperatorChatResult } from './client'

/**
 * Provider-level observability test: the base provider annotates its outcome
 * with the concrete model id and the token usage the endpoint reported, so the
 * loop can record per-step cost. Uses an injected fake chat client (no egress).
 */

function makeContext(): ReasoningContext {
    return {
        goal: 'open example.com',
        summary: {
            goalText: 'open example.com',
            inferredProgress: '',
            completedSubSteps: [],
            updatedThroughIndex: null
        },
        recentSteps: [],
        currentObservation: {
            id: 'obs1',
            screenshotDataUrl: 'data:image/png;base64,AAAA',
            imageWidth: 100,
            imageHeight: 100,
            displayId: 0,
            complete: true,
            capturedAt: '2020-01-01T00:00:00.000Z'
        }
    }
}

function makeClient(result: OperatorChatResult): OperatorChatClient {
    return {
        chat: { completions: { create: async () => result } },
        models: { list: async () => ({ data: [{ id: 'test-model' }] }) }
    }
}

function actionResult(usage?: OperatorChatResult['usage']): OperatorChatResult {
    return {
        choices: [
            {
                message: {
                    content: 'clicking the link',
                    tool_calls: [
                        {
                            type: 'function',
                            function: {
                                name: 'computer',
                                arguments: JSON.stringify({ action: 'left_click', x: 10, y: 20 })
                            }
                        }
                    ]
                }
            }
        ],
        usage
    }
}

function makeProvider(result: OperatorChatResult, model = 'gpt-4o-mini'): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider(
        { id: 'p1', baseURL: 'http://local.test/v1', model, requiresKey: false },
        { getApiKey: async () => 'key', createClient: () => makeClient(result) }
    )
}

describe('OpenAICompatibleModelProvider observability', () => {
    it('annotates the outcome with model id and normalized token usage', async () => {
        const provider = makeProvider(
            actionResult({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
        )
        const outcome = await provider.reason(makeContext())

        expect(outcome.kind).toBe('action')
        expect(outcome.model).toBe('gpt-4o-mini')
        expect(outcome.usage).toEqual({
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        })
    })

    it('derives total_tokens when the endpoint omits it', async () => {
        const provider = makeProvider(
            actionResult({ prompt_tokens: 40, completion_tokens: 10 })
        )
        const outcome = await provider.reason(makeContext())
        expect(outcome.usage).toEqual({ promptTokens: 40, completionTokens: 10, totalTokens: 50 })
    })

    it('sets model but leaves usage undefined when no usage is reported', async () => {
        const provider = makeProvider(actionResult(undefined))
        const outcome = await provider.reason(makeContext())
        expect(outcome.model).toBe('gpt-4o-mini')
        expect(outcome.usage).toBeUndefined()
    })
})

describe('coordinate-less scroll anchoring', () => {
    function scrollResult(args: Record<string, unknown>): OperatorChatResult {
        return {
            choices: [
                {
                    message: {
                        content: null,
                        tool_calls: [
                            {
                                type: 'function',
                                function: { name: 'computer', arguments: JSON.stringify(args) }
                            }
                        ]
                    }
                }
            ]
        }
    }

    it('anchors a page scroll with no x/y at the screenshot center (Gemini emission)', async () => {
        // Verbatim shape from a real gemini-2.5-flash run that previously failed:
        // {"dy":400,"rationale":"Scroll down to find more MrBeast videos.","action":"scroll"}
        const provider = makeProvider(
            scrollResult({ dy: 400, rationale: 'Scroll down to find more videos.', action: 'scroll' })
        )
        const outcome = await provider.reason(makeContext())
        expect(outcome.kind).toBe('action')
        if (outcome.kind !== 'action') return
        expect(outcome.action).toEqual({ kind: 'scroll', at: { x: 50, y: 50 }, dx: 0, dy: 400 })
    })

    it('maps the unprefixed direction/amount dialect onto anchored deltas', async () => {
        const provider = makeProvider(
            scrollResult({ action: 'scroll', direction: 'down', amount: 4 })
        )
        const outcome = await provider.reason(makeContext())
        expect(outcome.kind).toBe('action')
        if (outcome.kind !== 'action') return
        expect(outcome.action).toEqual({ kind: 'scroll', at: { x: 50, y: 50 }, dx: 0, dy: 400 })
    })

    it('still prefers explicit model-supplied scroll coordinates over the anchor', async () => {
        const provider = makeProvider(
            scrollResult({ action: 'scroll', x: 10, y: 20, dy: -300 })
        )
        const outcome = await provider.reason(makeContext())
        expect(outcome.kind).toBe('action')
        if (outcome.kind !== 'action') return
        expect(outcome.action).toEqual({ kind: 'scroll', at: { x: 10, y: 20 }, dx: 0, dy: -300 })
    })
})

describe('task_complete evidence plumb-through', () => {
    function completionResult(args: Record<string, unknown>): OperatorChatResult {
        return {
            choices: [
                {
                    message: {
                        content: null,
                        tool_calls: [
                            {
                                type: 'function',
                                function: { name: 'task_complete', arguments: JSON.stringify(args) }
                            }
                        ]
                    }
                }
            ]
        }
    }

    it('carries the evidence quote on the completion outcome', async () => {
        const provider = makeProvider(
            completionResult({ summary: 'Played the song.', evidence: 'Closer - The Chainsmokers' })
        )
        const outcome = await provider.reason(makeContext())
        expect(outcome.kind).toBe('completion')
        if (outcome.kind !== 'completion') return
        expect(outcome.summary).toBe('Played the song.')
        expect(outcome.evidence).toBe('Closer - The Chainsmokers')
    })

    it('leaves evidence undefined when the model omits it', async () => {
        const provider = makeProvider(completionResult({ summary: 'Done.' }))
        const outcome = await provider.reason(makeContext())
        expect(outcome.kind).toBe('completion')
        if (outcome.kind !== 'completion') return
        expect(outcome.evidence).toBeUndefined()
    })
})
