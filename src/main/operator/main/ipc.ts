import { ipcMain, type BrowserWindow } from 'electron'
import type {
    AgentSessionView,
    ConfirmActionInput,
    ConfirmationRequest,
    LoopStateView,
    OperatorError,
    PermissionSnapshot,
    ProviderStatus,
    SessionListItem,
    StartGoalInput,
    StartResult,
    TrajectoryStepView
} from '@op-shared/types'

/**
 * Operator IPC channel map (Task 3.2).
 *
 * Registers the renderer -> main request handlers and provides the
 * main -> renderer event emitters for the design's IPC channel map. Every
 * handler is backed by an OPTIONAL injected callback so the channel exists
 * (and round-trips) even before its backing service lands — the default is a
 * fail-closed, safe no-op / empty view. Later tasks inject the real services:
 * the agent loop (goal/session/confirm), the Safety controller
 * (emergency-stop), the permission service (`perm:get`), and the
 * ProviderChain (`providers:test`).
 *
 * Ownership split to avoid duplicate `ipcMain.handle` registrations: the
 * `config:get-status`, `config:save`, `providers:get`, and `providers:save`
 * channels are owned by `registerConfigIpc` in `config-ipc.ts`. This module
 * registers every OTHER channel in the map, including `providers:test`. The two
 * registrations compose to cover the full channel map (wired together in the
 * final integration task).
 *
 * Security: there is deliberately NO channel for capture, reasoning, or input
 * synthesis. Those privileged capabilities are never reachable from a renderer.
 */

/** A target window for an event emit; tolerant of null/undefined. */
type WindowRef = BrowserWindow | null | undefined

/** An empty session view returned before the Session Manager exists. */
export const EMPTY_SESSION_VIEW: AgentSessionView = {
    id: '',
    goalText: '',
    autonomy: 'manual',
    stepBudget: 0,
    status: 'idle',
    trajectory: [],
    summary: {
        goalText: '',
        inferredProgress: '',
        completedSubSteps: [],
        updatedThroughIndex: null
    },
    createdAt: '',
    updatedAt: ''
}

/** A fail-closed default permission snapshot (nothing assumed granted). */
export const UNKNOWN_PERMISSIONS: PermissionSnapshot = {
    screenRecording: 'not-determined',
    accessibility: 'not-determined'
}

/** The fail-closed default `StartResult` used until the agent loop is wired. */
function notWiredStartResult(): StartResult {
    return {
        ok: false,
        error: {
            kind: 'no-provider-configured',
            message: 'The operator is not fully configured yet. Configure a Model_Provider to start.',
            recoverable: true,
            action: 'configure-provider'
        }
    }
}

/**
 * Optional backing services, injected as they come online in later tasks. Every
 * one is optional; absent handlers fall back to fail-closed defaults.
 */
export interface OperatorIpcDeps {
    /** Accessor for the console window that receives most main -> renderer events. */
    getConsoleWindow: () => WindowRef

    /** `goal:start` — create a session and start the loop (Req 1). */
    onStartGoal?: (input: StartGoalInput) => StartResult | Promise<StartResult>
    /** `session:pause` (Req 10.3). */
    onPauseSession?: () => void | Promise<void>
    /** `session:resume` (Req 10.4). */
    onResumeSession?: () => void | Promise<void>
    /** `session:stop` (Req 7.3). */
    onStopSession?: () => void | Promise<void>
    /** `confirm:action` — a confirmation decision (Req 9, 10). */
    onConfirmAction?: (decision: ConfirmActionInput) => void | Promise<void>
    /** `emergency:stop` — the on-screen kill-switch (Req 7.2, 7.3, 7.8). */
    onEmergencyStop?: () => void | Promise<void>
    /** `session:get` — return the active session for restore (Req 18.2). */
    getSession?: () => AgentSessionView | Promise<AgentSessionView>
    /** `session:list` — list past sessions (Req 18). */
    onListSessions?: () => SessionListItem[] | Promise<SessionListItem[]>
    /** `session:open` — load a persisted session for review (Req 18.5). */
    onOpenSession?: (id: string) => AgentSessionView | Promise<AgentSessionView>
    /** `session:delete` — delete one or more archived operator sessions. */
    onDeleteSessions?: (ids: string[]) => void | Promise<void>
    /** `perm:get` — current macOS permission snapshot (Req 16, 17). */
    getPermissions?: () => PermissionSnapshot | Promise<PermissionSnapshot>
    /** `providers:test` — availability + vision models for one provider (Req 21.6, 21.7). */
    onTestProvider?: (id: string) => ProviderStatus | Promise<ProviderStatus>
    /** `help:answer` — the user's free-text answer to a question the agent asked. */
    onAnswerHelp?: (text: string) => void | Promise<void>
}

/** The channels registered by {@link registerOperatorIpc}. */
const CHANNELS = [
    'op:goal:start',
    'op:session:pause',
    'op:session:resume',
    'op:session:stop',
    'op:confirm:action',
    'op:emergency:stop',
    'op:session:get',
    'op:session:list',
    'op:session:open',
    'op:session:delete',
    'op:perm:get',
    'op:providers:test',
    'op:help:answer'
] as const

/**
 * Register the renderer -> main IPC handlers for the operator channel map.
 * Returns a disposer that removes every handler this call registered (useful
 * for tests and teardown).
 */
export function registerOperatorIpc(deps: OperatorIpcDeps): () => void {
    ipcMain.handle('op:goal:start', async (_event, input: StartGoalInput): Promise<StartResult> => {
        return (await deps.onStartGoal?.(input)) ?? notWiredStartResult()
    })

    ipcMain.handle('op:session:pause', async (): Promise<void> => {
        await deps.onPauseSession?.()
    })

    ipcMain.handle('op:session:resume', async (): Promise<void> => {
        await deps.onResumeSession?.()
    })

    ipcMain.handle('op:session:stop', async (): Promise<void> => {
        await deps.onStopSession?.()
    })

    ipcMain.handle('op:confirm:action', async (_event, decision: ConfirmActionInput | undefined): Promise<void> => {
        if (decision) {
            await deps.onConfirmAction?.(decision)
        }
    })

    ipcMain.handle('op:emergency:stop', async (): Promise<void> => {
        await deps.onEmergencyStop?.()
    })

    ipcMain.handle('op:session:get', async (): Promise<AgentSessionView> => {
        return (await deps.getSession?.()) ?? EMPTY_SESSION_VIEW
    })

    ipcMain.handle('op:session:list', async (): Promise<SessionListItem[]> => {
        return (await deps.onListSessions?.()) ?? []
    })

    ipcMain.handle('op:session:open', async (_event, payload: { id: string } | undefined): Promise<AgentSessionView> => {
        if (payload?.id) {
            return (await deps.onOpenSession?.(payload.id)) ?? EMPTY_SESSION_VIEW
        }
        return EMPTY_SESSION_VIEW
    })

    ipcMain.handle('op:session:delete', async (_event, payload: { ids: string[] } | undefined): Promise<void> => {
        if (payload?.ids && payload.ids.length > 0) {
            await deps.onDeleteSessions?.(payload.ids)
        }
    })

    ipcMain.handle('op:perm:get', async (): Promise<PermissionSnapshot> => {
        return (await deps.getPermissions?.()) ?? UNKNOWN_PERMISSIONS
    })

    ipcMain.handle('op:providers:test', async (_event, payload: { id: string } | undefined): Promise<ProviderStatus> => {
        const id = payload?.id ?? ''
        return (
            (await deps.onTestProvider?.(id)) ?? { id, available: false, visionModels: [] }
        )
    })

    ipcMain.handle('op:help:answer', async (_event, payload: { text: string } | undefined): Promise<void> => {
        if (payload?.text) {
            await deps.onAnswerHelp?.(payload.text)
        }
    })

    return () => {
        for (const channel of CHANNELS) {
            ipcMain.removeHandler(channel)
        }
    }
}

// ---------------------------------------------------------------------------
// main -> renderer event emitters
// ---------------------------------------------------------------------------

/** Push an appended Trajectory step to the console (`trajectory:appended`). */
export function emitTrajectoryAppended(window: WindowRef, step: TrajectoryStepView): void {
    window?.webContents.send('op:trajectory:appended', step)
}

/** Push the loop-state view to a renderer (`state:changed`). */
export function emitStateChanged(window: WindowRef, state: LoopStateView): void {
    window?.webContents.send('op:state:changed', state)
}

/** Push a confirmation request to the console (`confirmation:required`). */
export function emitConfirmationRequired(window: WindowRef, req: ConfirmationRequest): void {
    window?.webContents.send('op:confirmation:required', req)
}

/** Push a question the agent is asking the user to the console (`help:required`). */
export function emitHelpRequired(window: WindowRef, question: string): void {
    window?.webContents.send('op:help:required', question)
}

/** Show the Control_Indicator in the renderer (`indicator:show`). */
export function emitIndicatorShow(window: WindowRef): void {
    window?.webContents.send('op:indicator:show')
}

/** Hide the Control_Indicator in the renderer (`indicator:hide`). */
export function emitIndicatorHide(window: WindowRef): void {
    window?.webContents.send('op:indicator:hide')
}

/** Push a user-facing error to the console (`error:show`). */
export function emitError(window: WindowRef, error: OperatorError): void {
    window?.webContents.send('op:error:show', error)
}

/** Push a permission snapshot change to the console (`permission:changed`). */
export function emitPermissionChanged(window: WindowRef, snapshot: PermissionSnapshot): void {
    window?.webContents.send('op:permission:changed', snapshot)
}

/** Notify the console that credentials are required (`credentials:required`). */
export function emitCredentialsRequired(window: WindowRef): void {
    window?.webContents.send('op:credentials:required')
}
