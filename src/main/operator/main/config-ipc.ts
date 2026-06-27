import { ipcMain, type BrowserWindow } from 'electron'
import type { GatewayConfigInput, ProviderChainInput, ProviderChainView } from '@op-shared/types'
import { ConfigStore } from './config'

/**
 * Config / Model_Provider IPC wiring (Task 4).
 *
 * Exposes the Config / Credential Store over the design's `config:*` and
 * `providers:*` channels and pushes `credentials:required` to the console when
 * a required key is absent (Req 15.4, 15.7).
 *
 * This lives in its own module (not `ipc.ts`) so it can be registered
 * independently; the final integration pass wires it into the main process.
 * The register function returns the {@link ConfigStore} (so other services can
 * reuse it, e.g. to read a provider key when building a request) plus a
 * disposer that removes every handler it registered.
 */

/** A target window for an event emit; tolerant of null/undefined. */
type WindowRef = BrowserWindow | null | undefined

export interface ConfigIpcDeps {
    /** The store to use. Defaults to a new `ConfigStore()`. */
    store?: ConfigStore
    /** Accessor for the console window that receives `credentials:required`. */
    getConsoleWindow: () => WindowRef
}

export interface ConfigIpcRegistration {
    store: ConfigStore
    /** Removes every handler registered by this call. */
    dispose: () => void
}

/** The `config:*` + `providers:*` channels registered here. */
const CHANNELS = ['op:config:get-status', 'op:config:save', 'op:providers:get', 'op:providers:save'] as const

/**
 * Register the config + provider IPC handlers.
 *
 *  - `config:get-status` → `{ hasCredentials, models }` (Req 15.4, 15.6)
 *  - `config:save` → upsert the default OpenAI-compatible primary provider (Req 15.2)
 *  - `providers:get` → {@link ProviderChainView} (Req 21.1, 21.2)
 *  - `providers:save` → add/remove/reorder + endpoints/keys (Req 21.1, 21.2, 21.8)
 *
 * After a save, if a required key is still absent, the console is notified via
 * `credentials:required` (Req 15.4, 15.7).
 */
export function registerConfigIpc(deps: ConfigIpcDeps): ConfigIpcRegistration {
    const store = deps.store ?? new ConfigStore()

    ipcMain.handle('op:config:get-status', async () => {
        return store.getConfigStatus()
    })

    ipcMain.handle('op:config:save', async (_event, input: GatewayConfigInput): Promise<void> => {
        await store.saveConfig(input)
        await emitCredentialsRequiredIfMissing(store, deps.getConsoleWindow())
    })

    ipcMain.handle('op:providers:get', async (): Promise<ProviderChainView> => {
        return store.getProviders()
    })

    ipcMain.handle('op:providers:save', async (_event, input: ProviderChainInput): Promise<void> => {
        await store.saveProviders(input)
        await emitCredentialsRequiredIfMissing(store, deps.getConsoleWindow())
    })

    return {
        store,
        dispose: () => {
            for (const channel of CHANNELS) ipcMain.removeHandler(channel)
        }
    }
}

/**
 * Push `credentials:required` to the console when a provider that requires a
 * key does not have one stored (Req 15.4, 15.7). Also emitted on launch so the
 * user is prompted to configure a provider before starting a session.
 */
export async function emitCredentialsRequiredIfMissing(
    store: ConfigStore,
    window: WindowRef
): Promise<void> {
    const missing = await store.firstProviderMissingKey()
    if (missing) {
        window?.webContents.send('op:credentials:required')
    }
}
