/**
 * Config / Credential Store — public barrel (Task 4).
 *
 * The implementation lives under `./config/`, split by concern:
 *  - `vision-models` — the pure vision-only model filter (Property 26).
 *  - `secret-codec`  — OS keychain-backed encryption for API keys.
 *  - `errors`        — typed start-gate error builders.
 *  - `store`         — the {@link ConfigStore} plus its persisted shape/defaults.
 *
 * Many modules import from `'./config'` / `'../config'`, so this file re-exports
 * the full public surface. The split is a pure reorganization: no behavior,
 * signatures, or public names changed.
 */

export {
    type ModelCandidate,
    filterVisionModels,
    isModelSelectable,
    isVisionCapableModelId
} from './config/vision-models'

export {
    type SecretCodec,
    safeStorageCodec,
    EncryptionUnavailableError
} from './config/secret-codec'

export { noProviderConfiguredError, credentialsMissingError } from './config/errors'

export {
    type StoredConfig,
    type StartGateResult,
    type ConfigStoreOptions,
    EMPTY_STORED_CONFIG,
    DEFAULT_PRIMARY_PROVIDER_ID,
    ConfigStore
} from './config/store'
