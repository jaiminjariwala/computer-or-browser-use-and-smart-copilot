import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
    GatewayConfig,
    GatewayConfigInput,
    ConfigStatus
} from '@shared/types'

/**
 * Config / Credential Store (design: "Config / Credential Store",
 * "Persistence & Restore").
 *
 * Responsibilities:
 *  - Read/write the non-secret gateway config (`baseURL`, `model`) as JSON in
 *    `app.getPath('userData')/config.json`.
 *  - Store the gateway API key *separately* and encrypted, using Electron's
 *    `safeStorage.encryptString` / `decryptString`, so the key never lands on
 *    disk in plaintext and is never written into `config.json`.
 *  - Expose status (`config:get-status`) and save (`config:save`) over IPC and
 *    emit `credentials:required` when the API key is absent (Req 7.2, 7.4).
 */

/** Abstraction over the OS keychain-backed encryption, for testability. */
export interface SecretCodec {
    isEncryptionAvailable(): boolean
    encryptString(plain: string): Buffer
    decryptString(data: Buffer): string
}

/** Default codec backed by Electron `safeStorage`. */
export const safeStorageCodec: SecretCodec = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (data) => safeStorage.decryptString(data)
}

const CONFIG_FILENAME = 'config.json'
/** Encrypted API key bytes live here, separate from the JSON config. */
const API_KEY_FILENAME = 'gateway-key.enc'

/**
 * Built-in free hosted providers, tried in order after the user's own
 * (corporate/personal) gateway. Both are OpenAI-compatible, so one client
 * factory serves them; the user pastes a free key once and it is used
 * automatically forever after.
 *
 *  - OpenRouter: the `openrouter/free` router auto-selects a free model that
 *    supports the request's needs (image understanding + tool calling), so the
 *    slug keeps working even as individual free models come and go.
 *  - Google Gemini: OpenAI-compatible endpoint, generous free tier, vision.
 */
export const HOSTED_FALLBACKS = {
    openrouter: {
        baseURL: 'https://openrouter.ai/api/v1',
        // `openrouter/free` is a router that picks a free model matching the
        // request's needs (vision + tool calling). Individual `:free` slugs
        // (e.g. the old llama-3.2-vision one) get retired and start 404-ing;
        // the router avoids that by never pinning a single dead model.
        defaultModel: 'openrouter/free',
        keyFile: 'openrouter-key.enc'
    },
    gemini: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        // Gemini 2.5 Flash is the current free-tier vision + function-calling
        // model (the 2.x free lineup moved off 2.0). Best free choice to drive
        // the operator, which needs both vision and tool-calling.
        defaultModel: 'gemini-2.5-flash',
        keyFile: 'gemini-key.enc'
    }
} as const

export type HostedFallbackId = keyof typeof HOSTED_FALLBACKS

/** A config with no gateway configured yet. */
export const EMPTY_CONFIG: GatewayConfig = {
    baseURL: '',
    model: '',
    openrouterModel: '',
    geminiModel: '',
    captureMode: 'rectangle'
}

export interface ConfigStoreOptions {
    /** Directory to store files in. Defaults to `app.getPath('userData')`. */
    userDataDir?: string
    /** Encryption codec. Defaults to the `safeStorage`-backed codec. */
    codec?: SecretCodec
}

/** Thrown when an API key cannot be encrypted because the OS keychain is
 * unavailable (e.g. headless Linux). The IPC layer maps this to a GlassError. */
export class EncryptionUnavailableError extends Error {
    constructor() {
        super('Secure storage is unavailable on this system; cannot store the API key.')
        this.name = 'EncryptionUnavailableError'
    }
}

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

    private get keyPath(): string {
        return join(this.dir, API_KEY_FILENAME)
    }

    /** Read the non-secret config. Missing or malformed files yield EMPTY_CONFIG. */
    async readConfig(): Promise<GatewayConfig> {
        try {
            const raw = await fs.readFile(this.configPath, 'utf-8')
            const parsed = JSON.parse(raw) as Partial<GatewayConfig>
            return {
                baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL : '',
                model: typeof parsed.model === 'string' ? parsed.model : '',
                openrouterModel:
                    typeof parsed.openrouterModel === 'string' ? parsed.openrouterModel : '',
                geminiModel: typeof parsed.geminiModel === 'string' ? parsed.geminiModel : '',
                captureMode: 'rectangle'
            }
        } catch {
            // ENOENT or invalid JSON -> treat as unconfigured.
            return { ...EMPTY_CONFIG }
        }
    }

    /** Persist the non-secret config (never includes the API key). */
    async writeConfig(config: GatewayConfig): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true })
        const body = JSON.stringify(
            {
                baseURL: config.baseURL,
                model: config.model,
                openrouterModel: config.openrouterModel ?? '',
                geminiModel: config.geminiModel ?? '',
                captureMode: config.captureMode ?? 'rectangle'
            },
            null,
            2
        )
        await fs.writeFile(this.configPath, body, 'utf-8')
    }

    /** Whether an encrypted API key is stored (without decrypting it). */
    async hasApiKey(): Promise<boolean> {
        try {
            const buf = await fs.readFile(this.keyPath)
            return buf.length > 0
        } catch {
            return false
        }
    }

    /** Decrypt and return the stored API key, or null if absent/corrupt. */
    async getApiKey(): Promise<string | null> {
        let buf: Buffer
        try {
            buf = await fs.readFile(this.keyPath)
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

    /** Encrypt and store the API key separately from the JSON config. */
    async setApiKey(apiKey: string): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) {
            throw new EncryptionUnavailableError()
        }
        await fs.mkdir(this.dir, { recursive: true })
        const encrypted = this.codec.encryptString(apiKey)
        await fs.writeFile(this.keyPath, encrypted)
    }

    /** Remove the stored API key, if any. */
    async clearApiKey(): Promise<void> {
        try {
            await fs.rm(this.keyPath, { force: true })
        } catch {
            // best-effort
        }
    }

    // -- built-in free hosted providers (OpenRouter / Gemini) ----------------

    private hostedKeyPath(id: HostedFallbackId): string {
        return join(this.dir, HOSTED_FALLBACKS[id].keyFile)
    }

    /** Whether a key is stored for a hosted fallback provider. */
    async hasHostedKey(id: HostedFallbackId): Promise<boolean> {
        try {
            const buf = await fs.readFile(this.hostedKeyPath(id))
            return buf.length > 0
        } catch {
            return false
        }
    }

    /** Decrypt and return a hosted provider's key, or null if absent/corrupt. */
    async getHostedKey(id: HostedFallbackId): Promise<string | null> {
        let buf: Buffer
        try {
            buf = await fs.readFile(this.hostedKeyPath(id))
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

    /** Encrypt and store a hosted provider's key. */
    async setHostedKey(id: HostedFallbackId, apiKey: string): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) {
            throw new EncryptionUnavailableError()
        }
        await fs.mkdir(this.dir, { recursive: true })
        await fs.writeFile(this.hostedKeyPath(id), this.codec.encryptString(apiKey))
    }

    /**
     * The active hosted fallback providers in chain order, each as a ready
     * {baseURL, model, apiKey}. Only providers with a stored key are included;
     * the model is the user's override or the provider default.
     */
    async getHostedFallbacks(): Promise<Array<{ baseURL: string; model: string; apiKey: string }>> {
        const config = await this.readConfig()
        const modelFor: Record<HostedFallbackId, string> = {
            openrouter: config.openrouterModel ?? '',
            gemini: config.geminiModel ?? ''
        }
        const out: Array<{ baseURL: string; model: string; apiKey: string }> = []
        for (const id of Object.keys(HOSTED_FALLBACKS) as HostedFallbackId[]) {
            const key = await this.getHostedKey(id)
            if (!key || key.trim().length === 0) continue
            const meta = HOSTED_FALLBACKS[id]
            const model = modelFor[id].trim().length > 0 ? modelFor[id].trim() : meta.defaultModel
            out.push({ baseURL: meta.baseURL, model, apiKey: key })
        }
        return out
    }

    /**
     * Non-secret status for the renderer. `hasCredentials` is true only when an
     * encrypted API key is stored AND a baseURL is configured, i.e. the app is
     * ready to send requests to the gateway (Req 7.2, 7.4).
     */
    async getStatus(): Promise<ConfigStatus> {
        const config = await this.readConfig()
        const hasKey = await this.hasApiKey()
        const [hasOpenrouter, hasGemini] = await Promise.all([
            this.hasHostedKey('openrouter'),
            this.hasHostedKey('gemini')
        ])
        return {
            hasCredentials: hasKey && config.baseURL.trim().length > 0,
            baseURL: config.baseURL,
            model: config.model,
            hasOpenrouter,
            openrouterModel: config.openrouterModel ?? '',
            hasGemini,
            geminiModel: config.geminiModel ?? '',
            captureMode: config.captureMode ?? 'rectangle'
        }
    }

    /**
     * Save user-entered settings. Always persists `baseURL`/`model` (+ fallback
     * URL/model); updates the stored API keys only when a non-empty key is
     * supplied (empty leaves the existing one intact).
     */
    async save(input: GatewayConfigInput): Promise<void> {
        // Merge with existing config so a partial save (e.g. switching model
        // from the picker) never wipes other settings or capture mode.
        const existing = await this.readConfig()
        await this.writeConfig({
            baseURL: input.baseURL,
            model: input.model,
            openrouterModel: input.openrouterModel ?? existing.openrouterModel ?? '',
            geminiModel: input.geminiModel ?? existing.geminiModel ?? '',
            captureMode: input.captureMode ?? existing.captureMode ?? 'rectangle'
        })
        const trimmedKey = input.apiKey?.trim() ?? ''
        if (trimmedKey.length > 0) {
            await this.setApiKey(input.apiKey)
        }
        // Persist any newly-entered hosted keys (empty leaves as-is).
        const hostedKeys: Array<[HostedFallbackId, string | undefined]> = [
            ['openrouter', input.openrouterApiKey],
            ['gemini', input.geminiApiKey]
        ]
        for (const [id, key] of hostedKeys) {
            if ((key?.trim().length ?? 0) > 0) {
                await this.setHostedKey(id, key ?? '')
            }
        }
    }
}

export interface ConfigIpcDeps {
    /** The store to use. Defaults to a new `ConfigStore()`. */
    store?: ConfigStore
    /** Accessor for the sidebar window to push `credentials:required` to. */
    getSidebarWindow: () => BrowserWindow | null | undefined
    /**
     * Called after a successful `config:save`. Used to re-seed the operator's
     * (isolated) provider chain from the just-saved keys, so adding a key in
     * Settings makes the operator usable immediately without a restart.
     */
    onSaved?: () => void | Promise<void>
}

/**
 * Register the `config:get-status` and `config:save` IPC handlers. Returns the
 * `ConfigStore` so callers can reuse it (e.g. to read credentials when building
 * gateway requests). After a save, if credentials are still missing, the
 * sidebar is notified via `credentials:required` (Req 7.4).
 */
export function registerConfigIpc(deps: ConfigIpcDeps): ConfigStore {
    const store = deps.store ?? new ConfigStore()

    ipcMain.handle('config:get-status', async (): Promise<ConfigStatus> => {
        return store.getStatus()
    })

    ipcMain.handle('config:save', async (_event, input: GatewayConfigInput): Promise<void> => {
        await store.save(input)
        // Re-seed the operator provider chain from the newly-saved keys so a key
        // added here works in the operator immediately (no restart needed).
        await deps.onSaved?.()
        const status = await store.getStatus()
        if (!status.hasCredentials) {
            deps.getSidebarWindow()?.webContents.send('credentials:required')
        }
    })

    return store
}

/**
 * Push `credentials:required` to the sidebar if no usable credentials are
 * stored. Call this once the sidebar is ready (e.g. on launch) so the user is
 * prompted to configure the gateway before sending a request (Req 7.4).
 */
export async function emitCredentialsRequiredIfMissing(
    store: ConfigStore,
    window: BrowserWindow | null | undefined
): Promise<void> {
    const status = await store.getStatus()
    if (!status.hasCredentials) {
        window?.webContents.send('credentials:required')
    }
}
