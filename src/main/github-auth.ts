import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'
import type {
    GitHubAuthStatus,
    GitHubDeviceChallenge,
    GitHubUserIdentity
} from '@shared/types'
import { safeStorageCodec, type SecretCodec } from './config'

declare const __GITHUB_OAUTH_CLIENT_ID__: string

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const TOKEN_FILENAME = 'github-token.enc'
const TOKEN_TEMP_FILENAME = 'github-token.enc.tmp'
const REQUEST_TIMEOUT_MS = 15_000

/** Public OAuth client id supplied at runtime or embedded during the build. */
export function configuredGitHubClientId(): string {
    const runtime = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
    if (runtime.length > 0) return runtime
    const embedded =
        typeof __GITHUB_OAUTH_CLIENT_ID__ === 'string'
            ? __GITHUB_OAUTH_CLIENT_ID__.trim()
            : ''
    return embedded
}

interface GitHubTokenStoreOptions {
    userDataDir?: string
    codec?: SecretCodec
}

/** Persists only encrypted token bytes; plaintext exists in main-process memory. */
export class GitHubTokenStore {
    private readonly dir: string
    private readonly codec: SecretCodec

    constructor(options: GitHubTokenStoreOptions = {}) {
        this.dir = options.userDataDir ?? app.getPath('userData')
        this.codec = options.codec ?? safeStorageCodec
    }

    private get tokenPath(): string {
        return join(this.dir, TOKEN_FILENAME)
    }

    private get tempPath(): string {
        return join(this.dir, TOKEN_TEMP_FILENAME)
    }

    async read(): Promise<string | null> {
        let encrypted: Buffer
        try {
            encrypted = await fs.readFile(this.tokenPath)
        } catch {
            return null
        }
        if (encrypted.length === 0) return null
        try {
            const token = this.codec.decryptString(encrypted).trim()
            return token.length > 0 ? token : null
        } catch {
            return null
        }
    }

    async write(token: string): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) {
            throw new Error('Secure storage is unavailable; GitHub sign-in cannot be saved.')
        }
        const normalized = token.trim()
        if (normalized.length === 0) throw new Error('GitHub returned an empty access token.')
        await fs.mkdir(this.dir, { recursive: true })
        await fs.writeFile(this.tempPath, this.codec.encryptString(normalized))
        await fs.rename(this.tempPath, this.tokenPath)
    }

    async clear(): Promise<void> {
        await fs.rm(this.tokenPath, { force: true })
        await fs.rm(this.tempPath, { force: true })
    }
}

class GitHubHttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
        this.name = 'GitHubHttpError'
    }
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
    return typeof value === 'object' && value !== null ? (value as JsonRecord) : {}
}

function stringField(record: JsonRecord, key: string): string {
    return typeof record[key] === 'string' ? record[key].trim() : ''
}

function numberField(record: JsonRecord, key: string): number {
    return typeof record[key] === 'number' && Number.isFinite(record[key])
        ? record[key]
        : 0
}

function cloneStatus(status: GitHubAuthStatus): GitHubAuthStatus {
    return {
        ...status,
        ...(status.user ? { user: { ...status.user } } : {})
    }
}

export interface GitHubAuthServiceOptions {
    clientId: string
    tokenStore?: GitHubTokenStore
    fetchImpl?: typeof fetch
    openExternal?: (url: string) => Promise<void>
    onStatus?: (status: GitHubAuthStatus) => void
    now?: () => number
}

/**
 * Main-process GitHub Device Flow. The renderer receives only status, identity,
 * verification URI, and user code; device/access tokens stay in this service.
 */
export class GitHubAuthService {
    private readonly clientId: string
    private readonly tokenStore: GitHubTokenStore
    private readonly fetchImpl: typeof fetch
    private readonly openExternal: (url: string) => Promise<void>
    private readonly onStatus?: (status: GitHubAuthStatus) => void
    private readonly now: () => number
    private status: GitHubAuthStatus
    private hydrated = false
    private hydration: Promise<void> | null = null
    private attempt = 0
    /** Active token reads/writes/clears that a replacement login must not overtake. */
    private readonly tokenOperations = new Set<Promise<unknown>>()
    /** The in-flight challenge's verification page, reopenable until it expires. */
    private activeVerification: { uri: string; expiresAtMs: number } | null = null

    constructor(options: GitHubAuthServiceOptions) {
        this.clientId = options.clientId.trim()
        this.tokenStore = options.tokenStore ?? new GitHubTokenStore()
        this.fetchImpl = options.fetchImpl ?? fetch
        this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
        this.onStatus = options.onStatus
        this.now = options.now ?? Date.now
        this.status = this.clientId
            ? { state: 'signed-out' }
            : {
                state: 'unconfigured',
                message: 'GitHub sign-in needs a public OAuth App client ID.'
            }
    }

    async getStatus(): Promise<GitHubAuthStatus> {
        if (!this.hydrated) {
            this.hydration ??= this.hydrate().finally(() => {
                this.hydration = null
            })
            await this.hydration
        }
        return cloneStatus(this.status)
    }

    async startLogin(): Promise<GitHubDeviceChallenge> {
        if (!this.clientId) {
            throw new Error('GitHub sign-in is not configured for this build.')
        }

        const attempt = ++this.attempt
        const pendingHydration = this.hydration
        this.hydrated = true
        this.publish({ state: 'authorizing', message: 'Requesting a secure GitHub code…' })

        try {
            // A replacement login must not race an older hydration/credential
            // operation. Logout intentionally does not wait here: a late write
            // notices the generation change and removes itself after settling.
            await Promise.allSettled([
                ...(pendingHydration ? [pendingHydration] : []),
                ...this.tokenOperations
            ])
            this.assertCurrentAttempt(attempt)

            // Starting a fresh login replaces any prior local credential. Track
            // the clear so a still newer login cannot overtake it and later have
            // its token removed by this attempt.
            await this.trackTokenOperation(this.tokenStore.clear())
            this.assertCurrentAttempt(attempt)

            const payload = await this.requestJson(DEVICE_CODE_URL, {
                method: 'POST',
                headers: this.formHeaders(),
                body: new URLSearchParams({
                    client_id: this.clientId,
                    scope: 'read:user'
                }).toString()
            })
            this.assertCurrentAttempt(attempt)

            const deviceCode = stringField(payload, 'device_code')
            const userCode = stringField(payload, 'user_code')
            const verificationUri = stringField(payload, 'verification_uri')
            const expiresIn = numberField(payload, 'expires_in')
            const interval = Math.max(5, numberField(payload, 'interval') || 5)
            if (!deviceCode || !userCode || expiresIn <= 0 || !this.isGitHubVerificationUri(verificationUri)) {
                throw new Error('GitHub returned an invalid Device Flow challenge.')
            }

            const expiresAtMs = this.now() + expiresIn * 1000
            const challenge: GitHubDeviceChallenge = {
                userCode,
                verificationUri,
                expiresAt: new Date(expiresAtMs).toISOString()
            }
            this.activeVerification = { uri: verificationUri, expiresAtMs }
            this.publish({
                state: 'authorizing',
                message: 'Enter the code in the GitHub page opened in your browser.'
            })
            await this.openExternal(verificationUri)
            this.assertCurrentAttempt(attempt)
            void this.pollForToken({ attempt, deviceCode, intervalSeconds: interval, expiresAtMs })
            return challenge
        } catch (error) {
            if (attempt === this.attempt) {
                this.publish({
                    state: 'error',
                    message: error instanceof Error ? error.message : 'GitHub sign-in could not start.'
                })
            }
            throw error
        }
    }

    /**
     * Reopen the verification page for the in-flight Device Flow challenge —
     * the rescue path when the user closes the GitHub tab before pasting the
     * code. Only the URI main itself received from GitHub is ever opened.
     */
    async openVerificationPage(): Promise<void> {
        const active = this.activeVerification
        if (!active || this.status.state !== 'authorizing' || this.now() >= active.expiresAtMs) {
            throw new Error('No GitHub code is waiting right now. Start the sign-in again.')
        }
        await this.openExternal(active.uri)
    }

    async logout(): Promise<void> {
        const attempt = ++this.attempt
        // Mark hydration complete before the first await. Otherwise getStatus()
        // could start a fresh hydrate in this logout generation, read the token
        // while clear is blocked, and later overwrite signed-out with signed-in.
        this.hydrated = true
        // Do not wait for an older blocked write: clear immediately. The older
        // operation observes the generation change and clears again if it lands
        // after this call, preventing logout from resurrecting credentials.
        await this.trackTokenOperation(this.tokenStore.clear())
        if (attempt !== this.attempt) return
        this.publish(
            this.clientId
                ? { state: 'signed-out' }
                : {
                    state: 'unconfigured',
                    message: 'GitHub sign-in needs a public OAuth App client ID.'
                }
        )
    }

    dispose(): void {
        this.attempt += 1
    }

    private trackTokenOperation<T>(operation: Promise<T>): Promise<T> {
        const tracked = operation.finally(() => {
            this.tokenOperations.delete(tracked)
        })
        this.tokenOperations.add(tracked)
        return tracked
    }

    private assertCurrentAttempt(attempt: number): void {
        if (attempt !== this.attempt) {
            throw new Error('GitHub sign-in was superseded by a newer request.')
        }
    }

    private async hydrate(): Promise<void> {
        const attempt = this.attempt
        this.hydrated = true
        if (!this.clientId) return
        const token = await this.tokenStore.read()
        if (attempt !== this.attempt) return
        if (!token) {
            this.status = { state: 'signed-out' }
            return
        }
        try {
            const user = await this.fetchUser(token)
            if (attempt !== this.attempt) return
            this.status = { state: 'signed-in', user }
        } catch (error) {
            if (attempt !== this.attempt) return
            if (error instanceof GitHubHttpError && error.status === 401) {
                await this.trackTokenOperation(this.tokenStore.clear())
                if (attempt !== this.attempt) return
                this.status = { state: 'signed-out', message: 'Your GitHub session expired.' }
                return
            }
            this.status = {
                state: 'error',
                message: 'The saved GitHub session could not be verified. Check your connection.'
            }
        }
    }

    private async pollForToken(input: {
        attempt: number
        deviceCode: string
        intervalSeconds: number
        expiresAtMs: number
    }): Promise<void> {
        let intervalSeconds = input.intervalSeconds
        while (input.attempt === this.attempt && this.now() < input.expiresAtMs) {
            await new Promise<void>((resolve) => setTimeout(resolve, intervalSeconds * 1000))
            if (input.attempt !== this.attempt) return
            try {
                const payload = await this.requestJson(ACCESS_TOKEN_URL, {
                    method: 'POST',
                    headers: this.formHeaders(),
                    body: new URLSearchParams({
                        client_id: this.clientId,
                        device_code: input.deviceCode,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                    }).toString()
                })
                // A logout or replacement login can happen while fetch is in
                // flight. Never interpret or publish that stale response.
                if (input.attempt !== this.attempt) return

                const accessToken = stringField(payload, 'access_token')
                if (accessToken) {
                    // Verify identity before persistence so a replacement login
                    // during profile lookup cannot leave this attempt's token on
                    // disk. The tracked write also removes itself if cancelled
                    // while secure storage is still writing.
                    const user = await this.fetchUser(accessToken)
                    if (input.attempt !== this.attempt) return
                    const persisted = await this.trackTokenOperation(
                        (async (): Promise<boolean> => {
                            if (input.attempt !== this.attempt) return false
                            await this.tokenStore.write(accessToken)
                            if (input.attempt !== this.attempt) {
                                await this.tokenStore.clear()
                                return false
                            }
                            return true
                        })()
                    )
                    if (!persisted || input.attempt !== this.attempt) return
                    this.publish({ state: 'signed-in', user })
                    return
                }

                const code = stringField(payload, 'error')
                if (code === 'authorization_pending') continue
                if (code === 'slow_down') {
                    intervalSeconds += 5
                    continue
                }
                if (code === 'access_denied') {
                    this.publish({ state: 'signed-out', message: 'GitHub sign-in was cancelled.' })
                    return
                }
                if (code === 'expired_token') {
                    this.publish({ state: 'signed-out', message: 'The GitHub code expired. Try again.' })
                    return
                }
                throw new Error('GitHub returned an unexpected sign-in response.')
            } catch (error) {
                if (input.attempt !== this.attempt) return
                this.publish({
                    state: 'error',
                    message:
                        error instanceof Error
                            ? error.message
                            : 'GitHub sign-in could not be completed.'
                })
                return
            }
        }
        if (input.attempt === this.attempt) {
            this.publish({ state: 'signed-out', message: 'The GitHub code expired. Try again.' })
        }
    }

    private async fetchUser(token: string): Promise<GitHubUserIdentity> {
        const payload = await this.requestJson(USER_URL, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'Computer-Browser-Copilot',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        })
        const login = stringField(payload, 'login')
        if (!login) throw new Error('GitHub did not return an account identity.')
        const name = stringField(payload, 'name')
        return name ? { login, name } : { login }
    }

    private formHeaders(): Record<string, string> {
        return {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Computer-Browser-Copilot'
        }
    }

    private async requestJson(url: string, init: RequestInit): Promise<JsonRecord> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await this.fetchImpl(url, { ...init, signal: controller.signal })
            const payload = asRecord(await response.json().catch(() => ({})))
            if (!response.ok) {
                const detail = stringField(payload, 'message')
                throw new GitHubHttpError(
                    response.status,
                    detail || `GitHub request failed with status ${response.status}.`
                )
            }
            return payload
        } finally {
            clearTimeout(timeout)
        }
    }

    private isGitHubVerificationUri(value: string): boolean {
        try {
            const url = new URL(value)
            return url.protocol === 'https:' && url.hostname === 'github.com'
        } catch {
            return false
        }
    }

    private publish(status: GitHubAuthStatus): void {
        this.status = cloneStatus(status)
        this.onStatus?.(cloneStatus(status))
    }
}

interface GitHubAuthIpcOptions {
    getSidebarWindow: () => BrowserWindow | null | undefined
    clientId?: string
    service?: GitHubAuthService
}

function trustedSidebarUrl(): string {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']?.replace(/\/+$/, '')
    if (devServerUrl) return new URL(`${devServerUrl}/sidebar/index.html`).href
    return pathToFileURL(join(__dirname, '../renderer/sidebar/index.html')).href
}

function hasTrustedSidebarUrl(value: string): boolean {
    try {
        return new URL(value).href === trustedSidebarUrl()
    } catch {
        return false
    }
}

function isTrustedSidebarSender(
    event: IpcMainInvokeEvent,
    getSidebarWindow: GitHubAuthIpcOptions['getSidebarWindow']
): boolean {
    const sidebar = getSidebarWindow()
    return Boolean(
        sidebar &&
        !sidebar.isDestroyed() &&
        event.sender === sidebar.webContents &&
        event.senderFrame === sidebar.webContents.mainFrame &&
        hasTrustedSidebarUrl(event.senderFrame.url)
    )
}

/** Register the minimal non-secret auth IPC surface used by the sidebar. */
export function registerGitHubAuthIpc(options: GitHubAuthIpcOptions): {
    service: GitHubAuthService
    dispose: () => void
} {
    const service =
        options.service ??
        new GitHubAuthService({
            clientId: options.clientId ?? configuredGitHubClientId(),
            onStatus: (status) => {
                const sidebar = options.getSidebarWindow()
                if (
                    sidebar &&
                    !sidebar.isDestroyed() &&
                    hasTrustedSidebarUrl(sidebar.webContents.mainFrame.url)
                ) {
                    sidebar.webContents.send('github-auth:changed', status)
                }
            }
        })

    const authorize = (event: IpcMainInvokeEvent): void => {
        if (!isTrustedSidebarSender(event, options.getSidebarWindow)) {
            throw new Error('GitHub authentication is only available from the trusted sidebar.')
        }
    }

    ipcMain.handle('github-auth:status', (event): Promise<GitHubAuthStatus> => {
        authorize(event)
        return service.getStatus()
    })
    ipcMain.handle(
        'github-auth:start',
        (event): Promise<GitHubDeviceChallenge> => {
            authorize(event)
            return service.startLogin()
        }
    )
    ipcMain.handle('github-auth:logout', (event): Promise<void> => {
        authorize(event)
        return service.logout()
    })
    ipcMain.handle('github-auth:open-verification', (event): Promise<void> => {
        authorize(event)
        return service.openVerificationPage()
    })

    return {
        service,
        dispose: () => {
            service.dispose()
            ipcMain.removeHandler('github-auth:status')
            ipcMain.removeHandler('github-auth:start')
            ipcMain.removeHandler('github-auth:logout')
            ipcMain.removeHandler('github-auth:open-verification')
        }
    }
}
