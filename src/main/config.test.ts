import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Electron is not available in the Vitest (node) environment. Mock the bits the
// module imports at load time; ConfigStore itself is exercised with an injected
// directory and codec so the real electron APIs are never invoked.
vi.mock('electron', () => ({
    app: { getPath: () => tmpdir() },
    ipcMain: { handle: vi.fn() },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => ''
    }
}))

import { ipcMain } from 'electron'
import {
    ConfigStore,
    EncryptionUnavailableError,
    registerConfigIpc,
    emitCredentialsRequiredIfMissing,
    type SecretCodec
} from './config'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** Pull a registered ipcMain.handle handler out of the mocked electron module. */
function getHandler(channel: string): IpcHandler {
    const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const entry = calls.find((c) => c[0] === channel)
    if (!entry) throw new Error(`no handler registered for ${channel}`)
    return entry[1] as IpcHandler
}

/**
 * A reversible fake codec that mimics `safeStorage`: it base64-wraps the
 * plaintext so we can assert the stored bytes are NOT plaintext while still
 * round-tripping the value.
 */
function makeFakeCodec(available = true): SecretCodec {
    const PREFIX = 'enc:'
    return {
        isEncryptionAvailable: () => available,
        encryptString: (plain) => Buffer.from(PREFIX + Buffer.from(plain, 'utf-8').toString('base64'), 'utf-8'),
        decryptString: (data) => {
            const s = data.toString('utf-8')
            if (!s.startsWith(PREFIX)) throw new Error('bad ciphertext')
            return Buffer.from(s.slice(PREFIX.length), 'base64').toString('utf-8')
        }
    }
}

describe('ConfigStore', () => {
    let dir: string
    let store: ConfigStore
    let codec: SecretCodec

    beforeEach(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'glass-config-'))
        codec = makeFakeCodec(true)
        store = new ConfigStore({ userDataDir: dir, codec })
    })

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true })
    })

    describe('non-secret config', () => {
        it('returns an empty config when nothing is stored', async () => {
            expect(await store.readConfig()).toEqual({
                baseURL: '',
                model: '',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })

        it('writes and reads baseURL and model round-trip', async () => {
            await store.writeConfig({ baseURL: 'https://gw.example/v1', model: 'gemini-vision' })
            expect(await store.readConfig()).toEqual({
                baseURL: 'https://gw.example/v1',
                model: 'gemini-vision',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })

        it('never writes the API key into config.json', async () => {
            await store.save({
                baseURL: 'https://gw.example/v1',
                model: 'm',
                apiKey: 'super-secret-key'
            })
            const raw = await fs.readFile(join(dir, 'config.json'), 'utf-8')
            expect(raw).not.toContain('super-secret-key')
            expect(JSON.parse(raw)).toEqual({
                baseURL: 'https://gw.example/v1',
                model: 'm',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })

        it('falls back to empty config on malformed JSON', async () => {
            await fs.writeFile(join(dir, 'config.json'), '{ not valid json', 'utf-8')
            expect(await store.readConfig()).toEqual({
                baseURL: '',
                model: '',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })
    })

    describe('API key storage', () => {
        it('reports no key before one is set', async () => {
            expect(await store.hasApiKey()).toBe(false)
            expect(await store.getApiKey()).toBeNull()
        })

        it('encrypts the key on disk and decrypts it back', async () => {
            await store.setApiKey('my-key-123')
            // Stored bytes must not be the plaintext.
            const stored = await fs.readFile(join(dir, 'gateway-key.enc'))
            expect(stored.toString('utf-8')).not.toContain('my-key-123')
            // Round-trips through the codec.
            expect(await store.getApiKey()).toBe('my-key-123')
            expect(await store.hasApiKey()).toBe(true)
        })

        it('clears the stored key', async () => {
            await store.setApiKey('my-key-123')
            await store.clearApiKey()
            expect(await store.hasApiKey()).toBe(false)
            expect(await store.getApiKey()).toBeNull()
        })

        it('returns null when the stored key cannot be decrypted', async () => {
            await fs.writeFile(join(dir, 'gateway-key.enc'), Buffer.from('garbage'))
            expect(await store.getApiKey()).toBeNull()
        })

        it('throws when encryption is unavailable', async () => {
            const unavailable = new ConfigStore({ userDataDir: dir, codec: makeFakeCodec(false) })
            await expect(unavailable.setApiKey('x')).rejects.toBeInstanceOf(EncryptionUnavailableError)
        })
    })

    describe('save() semantics', () => {
        it('persists config and key together', async () => {
            await store.save({ baseURL: 'https://gw', model: 'm', apiKey: 'k' })
            expect(await store.readConfig()).toEqual({
                baseURL: 'https://gw',
                model: 'm',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
            expect(await store.getApiKey()).toBe('k')
        })

        it('leaves an existing key untouched when apiKey is blank', async () => {
            await store.save({ baseURL: 'https://gw', model: 'm', apiKey: 'first-key' })
            await store.save({ baseURL: 'https://gw2', model: 'm2', apiKey: '   ' })
            expect(await store.readConfig()).toEqual({
                baseURL: 'https://gw2',
                model: 'm2',
                openrouterModel: '',
                geminiModel: '',
                captureMode: 'rectangle'
            })
            expect(await store.getApiKey()).toBe('first-key')
        })
    })

    describe('getStatus()', () => {
        it('hasCredentials is false when unconfigured', async () => {
            expect(await store.getStatus()).toEqual({
                hasCredentials: false,
                baseURL: '',
                model: '',
                hasOpenrouter: false,
                openrouterModel: '',
                hasGemini: false,
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })

        it('hasCredentials is false with a key but no baseURL', async () => {
            await store.setApiKey('k')
            const status = await store.getStatus()
            expect(status.hasCredentials).toBe(false)
        })

        it('hasCredentials is false with a baseURL but no key', async () => {
            await store.writeConfig({ baseURL: 'https://gw', model: 'm' })
            const status = await store.getStatus()
            expect(status.hasCredentials).toBe(false)
        })

        it('hasCredentials is true with both a key and a baseURL', async () => {
            await store.save({ baseURL: 'https://gw', model: 'm', apiKey: 'k' })
            const status = await store.getStatus()
            expect(status).toEqual({
                hasCredentials: true,
                baseURL: 'https://gw',
                model: 'm',
                hasOpenrouter: false,
                openrouterModel: '',
                hasGemini: false,
                geminiModel: '',
                captureMode: 'rectangle'
            })
        })
    })
})

describe('config IPC', () => {
    let dir: string
    let store: ConfigStore
    let sent: string[]
    let fakeWindow: { webContents: { send: (channel: string) => void } }

    beforeEach(async () => {
        ; (ipcMain.handle as unknown as { mockClear: () => void }).mockClear()
        dir = await fs.mkdtemp(join(tmpdir(), 'glass-config-ipc-'))
        store = new ConfigStore({ userDataDir: dir, codec: makeFakeCodec(true) })
        sent = []
        fakeWindow = { webContents: { send: (channel: string) => sent.push(channel) } }
    })

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true })
    })

    it('registers config:get-status and config:save', () => {
        registerConfigIpc({ store, getSidebarWindow: () => null })
        expect(ipcMain.handle).toHaveBeenCalledWith('config:get-status', expect.any(Function))
        expect(ipcMain.handle).toHaveBeenCalledWith('config:save', expect.any(Function))
    })

    it('config:get-status returns the current status', async () => {
        await store.save({ baseURL: 'https://gw', model: 'm', apiKey: 'k' })
        registerConfigIpc({ store, getSidebarWindow: () => fakeWindow as never })
        const status = await getHandler('config:get-status')({})
        expect(status).toEqual({
            hasCredentials: true,
            baseURL: 'https://gw',
            model: 'm',
            hasOpenrouter: false,
            openrouterModel: '',
            hasGemini: false,
            geminiModel: '',
            captureMode: 'rectangle'
        })
    })

    it('config:save persists and does not emit when credentials become complete', async () => {
        registerConfigIpc({ store, getSidebarWindow: () => fakeWindow as never })
        await getHandler('config:save')({}, { baseURL: 'https://gw', model: 'm', apiKey: 'k' })
        expect(await store.getApiKey()).toBe('k')
        expect(sent).not.toContain('credentials:required')
    })

    it('config:save emits credentials:required when the key is still absent', async () => {
        registerConfigIpc({ store, getSidebarWindow: () => fakeWindow as never })
        await getHandler('config:save')({}, { baseURL: 'https://gw', model: 'm', apiKey: '' })
        expect(sent).toContain('credentials:required')
    })

    it('emitCredentialsRequiredIfMissing notifies only when incomplete', async () => {
        await emitCredentialsRequiredIfMissing(store, fakeWindow as never)
        expect(sent).toContain('credentials:required')

        sent = []
        const win2 = { webContents: { send: (c: string) => sent.push(c) } }
        await store.save({ baseURL: 'https://gw', model: 'm', apiKey: 'k' })
        await emitCredentialsRequiredIfMissing(store, win2 as never)
        expect(sent).not.toContain('credentials:required')
    })
})
