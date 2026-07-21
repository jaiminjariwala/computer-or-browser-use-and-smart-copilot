import OpenAI from 'openai'
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
    ChatCompletionToolChoiceOption
} from 'openai/resources/chat/completions'
import { chromiumFetch } from '../chromium-fetch'

/**
 * The narrow OpenAI-compatible client surface the providers rely on.
 *
 * Declaring it explicitly (rather than leaning on the full `openai` SDK type)
 * lets tests inject a fake endpoint with no egress, and keeps every provider
 * talking to the same minimal request/response contract.
 */

/** A raw tool call as returned by an OpenAI-compatible chat completion. */
export interface RawToolCall {
    type?: string
    function?: { name?: string; arguments?: string }
}

/** Token usage as reported by an OpenAI-compatible chat completion. */
export interface RawUsage {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
}

/** The narrow slice of a chat-completion result we read back. */
export interface OperatorChatResult {
    choices: Array<{
        message: {
            content?: string | null
            tool_calls?: RawToolCall[]
        }
    }>
    /** Token usage for the call (observability); absent on endpoints that omit it. */
    usage?: RawUsage
}

/** The parameters we send on a reasoning request (vision + tool-calling). */
export interface OperatorChatCreateParams {
    model: string
    messages: ChatCompletionMessageParam[]
    tools?: ChatCompletionTool[]
    tool_choice?: ChatCompletionToolChoiceOption
}

/**
 * The narrow OpenAI-compatible client this module relies on. Declaring it
 * explicitly lets tests inject a fake without standing up the real SDK.
 */
export interface OperatorChatClient {
    chat: {
        completions: {
            create(params: OperatorChatCreateParams): Promise<OperatorChatResult>
        }
    }
    models?: {
        list(): Promise<{ data?: Array<{ id?: string }> } | AsyncIterable<{ id?: string }>>
    }
}

/** Factory for an OpenAI-compatible client pointed at a provider's endpoint. */
export type ChatClientFactory = (baseURL: string, apiKey: string) => OperatorChatClient

/**
 * Default factory: a real `openai` client pointed at the provider endpoint.
 * Requests run over Chromium's network stack (see `../chromium-fetch`): the
 * SDK's default undici fetch drops Gemini responses mid-body, which silently
 * failed the availability probe and every reasoning step.
 */
export const createOperatorChatClient: ChatClientFactory = (baseURL, apiKey) =>
    new OpenAI({
        baseURL,
        apiKey,
        fetch: chromiumFetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch']
    }) as unknown as OperatorChatClient
