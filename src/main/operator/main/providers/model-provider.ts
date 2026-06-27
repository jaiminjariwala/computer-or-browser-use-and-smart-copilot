/**
 * Model_Provider implementations (Task 6.1).
 *
 * Split into the sibling `model-provider/` folder by concern:
 *  - `client.ts`        — the narrow injectable OpenAI-compatible client surface.
 *  - `base-provider.ts` — the shared `OpenAICompatibleModelProvider` base + deps.
 *  - `providers.ts`     — hosted and local concrete providers.
 *  - `factory.ts`       — `createModelProvider`, which routes providers to the
 *    OpenAI-compatible base.
 *
 * This file stays a BARREL so every existing import path keeps working. The
 * three providers share one request shape and differ only in transport; the
 * router (`reasoning.ts`) tries them in order and falls back on failure.
 */

export {
    type RawToolCall,
    type OperatorChatResult,
    type OperatorChatCreateParams,
    type OperatorChatClient,
    type ChatClientFactory,
    createOperatorChatClient
} from './model-provider/client'
export {
    OpenAICompatibleModelProvider,
    type ModelProviderDeps
} from './model-provider/base-provider'
export {
    OpenAICompatibleProvider,
    LocalProvider
} from './model-provider/providers'
export { createModelProvider } from './model-provider/factory'
