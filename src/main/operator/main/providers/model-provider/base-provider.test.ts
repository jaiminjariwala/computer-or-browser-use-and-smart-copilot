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
