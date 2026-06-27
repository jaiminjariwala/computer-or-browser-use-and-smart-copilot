import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
    GatewayConfig,
    GatewayConfigInput,
    ModelProviderConfig,
    OperatorError,
    ProviderChain,
    ProviderChainInput,
    ProviderChainView,
    ProviderStatus
} from '@op-shared/types'
import { isVisionCapableModelId } from './vision-models'
import { EncryptionUnavailableError, safeStorageCodec, type SecretCodec } from './secret-codec'
import { credentialsMissingError, noProviderConfiguredError } from './errors'

/**
 * Config / Credential Store (Task 4 — "Config / Credential store and
 * Model_Provider configuration").
 *
 * Evolved from the vendored Click Copilot `config.ts` toward the design's
 * **Model_Provider** model (Req 21). The encrypted-credential pattern
 * (`safeStorage`, secret bytes held in files separate from `config.json`) is
 * retained from the vendor copy; the data model is now the Provider_Chain plus
 * a list of {@link ModelProviderConfig} rather than a single gateway.
 *
 * Reuse rule (Req 19): a one-time COPY that Click Operator now owns; it does
 * not import from or modify the `click-copilot` project.
 *
 * Two files back the store, kept deliberately apart:
 *  - `config.json` holds only non-secret state — the {@link ProviderChain}
 *    order and each {@link ModelProviderConfig} (`id`, `kind`, `baseURL`,
 *    `model`, `requiresKey`). It NEVER holds an API key, so
 *    it is safe to inspect, sync, or back up (Req 21.1, 21.2).
 *  - one `provider-key-<id>.enc` per provider holds that provider's key,
 *    encrypted via the OS keychain. Keeping keys out of `config.json` is the
 *    whole point: a leaked config file exposes no credentials (Req 15.3, 21.8).
 */

/** The non-secret config persisted to `config.json` (never holds any key). */
export interface StoredConfig {
    chain: ProviderChain
    providers: ModelProviderConfig[]
}

/** A config with no Model_Provider configured yet. */
export const EMPTY_STORED_CONFIG: StoredConfig = {
    chain: { providerIds: [] },
    providers: []
}

/** The id of the default primary OpenAI-compatible provider. */
export const DEFAULT_PRIMARY_PROVIDER_ID = 'primary'

// Distinct from Click Copilot's own `config.json` — the merged operator engine
// shares the same `userData` directory, so its provider-chain config lives in
// its own file to avoid clobbering the host app's gateway config.
const CONFIG_FILENAME = 'operator-config.json'
/** Prefix for the per-provider encrypted key files (kept out of config.json). */
const KEY_FILENAME_PREFIX = 'operator-provider-key-'
const KEY_FILENAME_SUFFIX = '.enc'

/** Result of evaluating whether a session may start (Req 15.4, 15.7, 21.10). */
export type StartGateResult = { ok: true } | { ok: false; error: OperatorError }

export interface ConfigStoreOptions {
    /** Directory to store files in. Defaults to `app.getPath('userData')`. */
    userDataDir?: string
    /** Encryption codec. Defaults to the `safeStorage`-backed codec. */
    codec?: SecretCodec
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
    private readonly dir: string
    private readonly codec: SecretCodec

    constructor(options: ConfigStoreOptions = {}) {
        this.dir = options.userDataDir ?? app.getPath('userData')
        this.codec = options.codec ?? safeStorageCodec
    }

    private get configPath(): string {
        return join(this.dir, CONFIG_FILENAME)
    }

    /** Path to the encrypted key file for a provider id (id is sanitized). */
    private keyPath(providerId: string): string {
        const safe = providerId.replace(/[^a-zA-Z0-9_-]/g, '_')
        return join(this.dir, `${KEY_FILENAME_PREFIX}${safe}${KEY_FILENAME_SUFFIX}`)
    }

    // -- non-secret config --------------------------------------------------

    /** Read the non-secret config. Missing/malformed files yield an empty config. */
    async readConfig(): Promise<StoredConfig> {
        let raw: string
        try {
            raw = await fs.readFile(this.configPath, 'utf-8')
        } catch {
            return cloneStoredConfig(EMPTY_STORED_CONFIG)
        }
        try {
            const parsed = JSON.parse(raw) as Partial<StoredConfig>
            const providers = Array.isArray(parsed.providers)
                ? parsed.providers.filter(isModelProviderConfig).map(normalizeProvider)
                : []
            const providerIds =
                parsed.chain && Array.isArray(parsed.chain.providerIds)
                    ? parsed.chain.providerIds.filter((id): id is string => typeof id === 'string')
                    : []
            return { chain: { providerIds }, providers }
        } catch {
            return cloneStoredConfig(EMPTY_STORED_CONFIG)
        }
    }

    /**
     * Persist the non-secret config. Any `apiKey` accidentally present on a
     * provider object is stripped defensively — keys never enter `config.json`.
     */
    async writeConfig(config: StoredConfig): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true })
        const providers = config.providers.map(normalizeProvider)
        const body = JSON.stringify(
            { chain: { providerIds: [...config.chain.providerIds] }, providers },
            null,
            2
        )
        await fs.writeFile(this.configPath, body, 'utf-8')
    }

    // -- per-provider encrypted keys (Req 15.3, 21.8) -----------------------

    /** Whether an encrypted key is stored for a provider (without decrypting). */
    async hasProviderKey(providerId: string): Promise<boolean> {
        try {
            const buf = await fs.readFile(this.keyPath(providerId))
            return buf.length > 0
        } catch {
            return false
        }
    }

    /** Decrypt and return a provider's stored key, or null if absent/corrupt. */
    async getProviderKey(providerId: string): Promise<string | null> {
        let buf: Buffer
        try {
            buf = await fs.readFile(this.keyPath(providerId))
        } catch {
            return null
        }
        if (buf.length === 0) return null
        try {
            return this.codec.decryptString(buf)
        } catch {
            return null
        }
    }

    /** Encrypt and store a provider's key separately from `config.json`. */
    async setProviderKey(providerId: string, apiKey: string): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) {
            throw new EncryptionUnavailableError()
        }
        await fs.mkdir(this.dir, { recursive: true })
        const encrypted = this.codec.encryptString(apiKey)
        await fs.writeFile(this.keyPath(providerId), encrypted)
    }

    /** Remove a provider's stored key, if any. */
    async clearProviderKey(providerId: string): Promise<void> {
        try {
            await fs.rm(this.keyPath(providerId), { force: true })
        } catch {
            // best-effort
        }
    }

    // -- provider get/save (Req 21.1, 21.2, 21.8) ---------------------------

    /**
     * The provider list + chain order + per-provider status for the renderer.
     *
     * Status here is derived from *stored state only* (no network probe): a
     * provider is `available` when it is fully configured (has a `baseURL` and
     * `model`, plus a stored key when `requiresKey`). `visionModels` reflects
     * the configured model when it passes the vision-capability heuristic. The
     * live reachability probe + real model listing land with `providers:test`
     * (Req 21.6) in a later task.
     */
    async getProviders(): Promise<ProviderChainView> {
        const config = await this.readConfig()
        const statuses: ProviderStatus[] = []
        for (const p of config.providers) {
            const configured = await this.isProviderConfigured(p)
            const visionModels =
                p.model.trim().length > 0 && isVisionCapableModelId(p.model) ? [p.model] : []
            statuses.push({ id: p.id, available: configured, visionModels })
        }
        return { chain: config.chain, providers: config.providers, statuses }
    }

    /**
     * Add/remove/reorder providers and persist per-provider endpoints + keys.
     * A provider carrying a non-empty `apiKey` has it encrypted and stored;
     * `requiresKey: false` (keyless local) providers store no key. An empty
     * `apiKey` leaves any existing stored key intact.
     */
    async saveProviders(input: ProviderChainInput): Promise<void> {
        const providers: ModelProviderConfig[] = input.providers.map((p) => normalizeProvider(p))
        await this.writeConfig({ chain: { providerIds: [...input.chain.providerIds] }, providers })

        for (const p of input.providers) {
            const key = p.apiKey?.trim() ?? ''
            if (p.requiresKey && key.length > 0) {
                await this.setProviderKey(p.id, p.apiKey ?? '')
            }
        }
    }

    // -- legacy single-gateway config (Req 15.2, 15.4, 15.6) ----------------

    /** The active/primary provider (first in the chain that exists), or null. */
    async getPrimaryProvider(): Promise<ModelProviderConfig | null> {
        const config = await this.readConfig()
        return resolvePrimary(config)
    }

    /** The primary provider's non-secret gateway config (`baseURL` + `model`). */
    async getConfig(): Promise<GatewayConfig> {
        const primary = await this.getPrimaryProvider()
        return { baseURL: primary?.baseURL ?? '', model: primary?.model ?? '' }
    }

    /**
     * Non-secret status for the renderer's `config:get-status`. `hasCredentials`
     * is true when the primary provider is fully configured (Req 15.4);
     * `models` is the vision-filtered selectable list for that provider derived
     * from stored state (Req 15.6).
     */
    async getConfigStatus(): Promise<{ hasCredentials: boolean; models: string[] }> {
        const primary = await this.getPrimaryProvider()
        if (!primary) return { hasCredentials: false, models: [] }
        const hasCredentials = await this.isProviderConfigured(primary)
        const models =
            primary.model.trim().length > 0 && isVisionCapableModelId(primary.model)
                ? [primary.model]
                : []
        return { hasCredentials, models }
    }

    /**
     * Save the legacy single-gateway configuration by upserting the default
     * OpenAI-compatible primary provider (Req 21.2) with the given
     * `baseURL`/`model` and, when supplied, its encrypted key.
     */
    async saveConfig(input: GatewayConfigInput): Promise<void> {
        const config = await this.readConfig()
        const existingIdx = config.providers.findIndex(
            (p) => p.id === DEFAULT_PRIMARY_PROVIDER_ID
        )
        const primary: ModelProviderConfig = {
            id: DEFAULT_PRIMARY_PROVIDER_ID,
            kind: 'openai-compatible',
            baseURL: input.baseURL?.trim() ?? '',
            model: input.model,
            requiresKey: true
        }
        if (existingIdx >= 0) {
            config.providers[existingIdx] = primary
        } else {
            config.providers.unshift(primary)
        }
        if (!config.chain.providerIds.includes(DEFAULT_PRIMARY_PROVIDER_ID)) {
            config.chain.providerIds.unshift(DEFAULT_PRIMARY_PROVIDER_ID)
        }
        await this.writeConfig(config)

        const key = input.apiKey?.trim() ?? ''
        if (key.length > 0) {
            await this.setProviderKey(DEFAULT_PRIMARY_PROVIDER_ID, input.apiKey ?? '')
        }
    }

    // -- start-gate (Req 15.4, 15.7, 21.10) ---------------------------------

    /**
     * Whether a provider is fully configured. Providers need a `baseURL` +
     * `model` (+ stored key when required).
     */
    async isProviderConfigured(provider: ModelProviderConfig): Promise<boolean> {
        if (!hasEndpoint(provider)) return false
        if (provider.model.trim().length === 0) return false
        if (provider.requiresKey && !(await this.hasProviderKey(provider.id))) return false
        return true
    }

    /**
     * The first provider in the chain whose `requiresKey` is true but whose key
     * is absent, or null when none are missing a required key (Req 15.4, 15.7).
     */
    async firstProviderMissingKey(): Promise<ModelProviderConfig | null> {
        const config = await this.readConfig()
        for (const p of orderedProviders(config)) {
            if (p.requiresKey && !(await this.hasProviderKey(p.id))) return p
        }
        return null
    }

    /**
     * Evaluate the credential/provider start-gate. Returns `{ ok: true }` only
     * when at least one Model_Provider is configured and (optionally) reachable
     * and no required key is missing; otherwise a typed {@link OperatorError}:
     *  - `no-provider-configured` when nothing is configured or, given a
     *    reachability probe, nothing is reachable (Req 21.10).
     *  - `credentials-missing` when a configured provider still lacks a required
     *    key (Req 15.4, 15.7).
     *
     * @param isReachable optional async probe; when provided, a provider must be
     *   both configured and reachable to satisfy the gate. Omitted here so the
     *   store stays network-free; the loop supplies the probe in a later task.
     */
    async evaluateStartGate(
        isReachable?: (provider: ModelProviderConfig) => Promise<boolean>
    ): Promise<StartGateResult> {
        const config = await this.readConfig()
        const ordered = orderedProviders(config)

        if (ordered.length === 0) {
            return { ok: false, error: noProviderConfiguredError() }
        }

        // A missing required key on an otherwise-configured provider is the more
        // specific, actionable failure — surface it first (Req 15.4, 15.7).
        for (const p of ordered) {
            if (
                hasEndpoint(p) &&
                p.model.trim().length > 0 &&
                p.requiresKey &&
                !(await this.hasProviderKey(p.id))
            ) {
                return { ok: false, error: credentialsMissingError() }
            }
        }

        let anyUsable = false
        for (const p of ordered) {
            if (!(await this.isProviderConfigured(p))) continue
            if (isReachable && !(await isReachable(p))) continue
            anyUsable = true
            break
        }
        if (!anyUsable) {
            return { ok: false, error: noProviderConfiguredError() }
        }
        return { ok: true }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneStoredConfig(config: StoredConfig): StoredConfig {
    return {
        chain: { providerIds: [...config.chain.providerIds] },
        providers: config.providers.map((p) => ({ ...p }))
    }
}

/** Providers in Provider_Chain order, then any not referenced by the chain. */
function orderedProviders(config: StoredConfig): ModelProviderConfig[] {
    const byId = new Map(config.providers.map((p) => [p.id, p]))
    const ordered: ModelProviderConfig[] = []
    const used = new Set<string>()
    for (const id of config.chain.providerIds) {
        const p = byId.get(id)
        if (p && !used.has(id)) {
            ordered.push(p)
            used.add(id)
        }
    }
    for (const p of config.providers) {
        if (!used.has(p.id)) {
            ordered.push(p)
            used.add(p.id)
        }
    }
    return ordered
}

/** The primary provider = first ordered provider, or null when none exist. */
function resolvePrimary(config: StoredConfig): ModelProviderConfig | null {
    const ordered = orderedProviders(config)
    return ordered.length > 0 ? ordered[0] : null
}

const PROVIDER_KINDS = ['openai-compatible', 'local'] as const

function hasEndpoint(provider: ModelProviderConfig): boolean {
    return provider.baseURL.trim().length > 0
}

/** Structural guard for a persisted {@link ModelProviderConfig}. */
function isModelProviderConfig(value: unknown): value is ModelProviderConfig {
    if (typeof value !== 'object' || value === null) return false
    const p = value as Record<string, unknown>
    return (
        typeof p.id === 'string' &&
        typeof p.kind === 'string' &&
        (PROVIDER_KINDS as readonly string[]).includes(p.kind) &&
        typeof p.baseURL === 'string' &&
        typeof p.model === 'string' &&
        typeof p.requiresKey === 'boolean'
    )
}

/** Strip any stray secret fields and keep exactly the persisted shape. */
function normalizeProvider(p: ModelProviderConfig & { apiKey?: string }): ModelProviderConfig {
    const normalized: ModelProviderConfig = {
        id: p.id,
        kind: p.kind,
        baseURL: p.baseURL,
        model: p.model,
        requiresKey: p.requiresKey
    }
    return normalized
}
