import type { ProviderStatus, StartGoalInput, StartResult } from '@op-shared/types'
import { toAgentSessionView } from '../session'
import { registerConfigIpc } from '../config-ipc'
import { registerOperatorIpc, emitPermissionChanged, EMPTY_SESSION_VIEW } from '../ipc'
import { createModelProvider } from '../providers/model-provider'
import type { OperatorServices } from './services'

/** Disposers returned by {@link wireOperatorIpc}, invoked on quit/teardown. */
export interface IpcDisposers {
    disposeOperatorIpc: () => void
    disposeConfigIpc: () => void
}

/**
 * Register both halves of the design's IPC channel map and return their
 * disposers.
 *
 * The map is split across two registrars to avoid duplicate `ipcMain.handle`
 * registrations: `registerConfigIpc` owns `config:*` / `providers:get` /
 * `providers:save`, and `registerOperatorIpc` owns every other channel
 * (including `providers:test`). They compose to cover the full map.
 *
 * Session restore adopts a session for review only; acting stays gated behind an
 * explicit start (Req 18.5).
 */
export function wireOperatorIpc(
    services: OperatorServices,
    handleStartGoal: (input: StartGoalInput) => Promise<StartResult>
): IpcDisposers {
    const { consoleWindow, configStore, sessions, sessionManager, safety, loop, readPermissions } =
        services

    const configReg = registerConfigIpc({ store: configStore, getConsoleWindow: consoleWindow })

    const disposeOperatorIpc = registerOperatorIpc({
        getConsoleWindow: consoleWindow,
        onStartGoal: handleStartGoal,
        onPauseSession: () => loop.pause(),
        onResumeSession: () => {
            void loop.resume()
        },
        onStopSession: () => loop.stop(),
        onConfirmAction: (decision) => {
            void loop.confirm(decision)
        },
        // The user's chat answer to a question the agent asked: record it as
        // guidance the next Reasoning_Step will see, then resume the loop.
        onAnswerHelp: (text) => {
            sessionManager.addGuidance(text)
            void loop.resume()
        },
        // On-screen Emergency_Stop (Req 7.2, 7.8): same handler as the hotkey.
        onEmergencyStop: () => safety.onEmergencyStop(),
        getSession: () => sessionManager.getSessionView() ?? EMPTY_SESSION_VIEW,
        onListSessions: () => sessions.listSessions(),
        onOpenSession: async (id) => {
            const loaded = await sessions.readSessionById(id)
            if (!loaded) return EMPTY_SESSION_VIEW
            // Adopt for review; acting stays gated behind an explicit start (Req 18.5).
            sessionManager.restore(loaded)
            return toAgentSessionView(loaded)
        },
        onDeleteSessions: (ids) => sessions.deleteSessions(ids),
        getPermissions: () => {
            const snapshot = readPermissions()
            emitPermissionChanged(consoleWindow(), snapshot)
            return snapshot
        },
        onTestProvider: async (id): Promise<ProviderStatus> => {
            const config = await configStore.readConfig()
            const cfg = config.providers.find((p) => p.id === id)
            if (!cfg) return { id, available: false, visionModels: [] }
            const provider = createModelProvider(cfg, {
                getApiKey: () => configStore.getProviderKey(id)
            })
            const [available, visionModels] = await Promise.all([
                provider.isAvailable().catch(() => false),
                provider.listVisionModels().catch(() => [])
            ])
            return { id, available, visionModels }
        }
    })

    return { disposeOperatorIpc, disposeConfigIpc: configReg.dispose }
}
