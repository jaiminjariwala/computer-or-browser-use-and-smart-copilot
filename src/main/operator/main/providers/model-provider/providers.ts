import type { ModelProviderConfig } from '@op-shared/types'
import { OpenAICompatibleModelProvider, type ModelProviderDeps } from './base-provider'

/**
 * The concrete OpenAI-compatible providers. Each only pins its
 * {@link ProviderKind}; all behavior is inherited from
 * {@link OpenAICompatibleModelProvider}. The chain order (primary → fallbacks)
 * is decided by the router, not here.
 */

/** A generic hosted OpenAI-compatible endpoint configured by baseURL + key (Req 21.1). */
export class OpenAICompatibleProvider extends OpenAICompatibleModelProvider {
    constructor(config: Omit<ModelProviderConfig, 'kind'>, deps: ModelProviderDeps) {
        super({ ...config, kind: 'openai-compatible' }, deps)
    }
}

/** A locally hosted, keyless-capable OpenAI-compatible server (Req 21.6, 21.8). */
export class LocalProvider extends OpenAICompatibleModelProvider {
    constructor(config: Omit<ModelProviderConfig, 'kind'>, deps: ModelProviderDeps) {
        super({ ...config, kind: 'local', requiresKey: config.requiresKey ?? false }, deps)
    }
}
