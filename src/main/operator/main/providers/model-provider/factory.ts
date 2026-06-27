import type { ModelProvider, ModelProviderConfig } from '@op-shared/types'
import { type ModelProviderDeps } from './base-provider'
import { LocalProvider, OpenAICompatibleProvider } from './providers'

/**
 * Construct the concrete {@link ModelProvider} for a stored
 * {@link ModelProviderConfig}, dispatching on its `kind`.
 */
export function createModelProvider(
    config: ModelProviderConfig,
    deps: ModelProviderDeps
): ModelProvider {
    switch (config.kind) {
        case 'openai-compatible':
            return new OpenAICompatibleProvider(config, deps)
        case 'local':
            return new LocalProvider(config, deps)
    }
}
