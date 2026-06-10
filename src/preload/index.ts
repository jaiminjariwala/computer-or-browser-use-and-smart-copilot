import { contextBridge, ipcRenderer } from 'electron'
import type {
    ConfigStatus,
    GatewayConfigInput,
    GlassBridge,
    GlassError,
    Rect,
    SessionContext,
    SessionListItem,
    SessionSummary,
    SessionView,
    TurnCapture,
    TurnView
} from '@shared/types'

/**
 * Preload bridge (design: "Preload bridge (renderer-facing API)").
 *
 * Exposes the full typed {@link GlassBridge} on `window.glass`. Request methods
 * map to `ipcRenderer.invoke` on the channels in the design's IPC channel map;
 * event subscriptions register an `ipcRenderer.on` listener and return an
 * unsubscribe function.
 *
 * The Config / Credential surface (`getConfigStatus`, `saveConfig`,
 * `onCredentialsRequired`) is backed by handlers registered in
 * `src/main/config.ts`; the chat/capture/session surface is backed by
 * `src/main/ipc.ts` (stub handlers until those services land in later tasks).
 */

/** Subscribe to a main -> renderer channel; returns an unsubscribe function. */
function subscribe<Args extends unknown[]>(
    channel: string,
    cb: (...args: Args) => void
): () => void {
    const listener = (_event: unknown, ...args: unknown[]): void => cb(...(args as Args))
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: GlassBridge = {
    ready: true,

    // Sidebar -> main
    sendMessage: (text: string): Promise<void> => ipcRenderer.invoke('chat:send', { text }),
    sendCaptures: (captures: TurnCapture[], text?: string): Promise<void> =>
        ipcRenderer.invoke('chat:send-captures', { captures, text }),
    triggerCapture: (): Promise<void> => ipcRenderer.invoke('capture:trigger'),
    newSession: (): Promise<void> => ipcRenderer.invoke('session:new'),
    getSession: (): Promise<SessionView> => ipcRenderer.invoke('session:get'),
    listSessions: (): Promise<SessionListItem[]> => ipcRenderer.invoke('session:list'),
    openSession: (id: string): Promise<void> => ipcRenderer.invoke('session:open', { id }),
    deleteSessions: (ids: string[]): Promise<void> =>
        ipcRenderer.invoke('session:delete', { ids }),
    listModels: (): Promise<string[]> => ipcRenderer.invoke('models:list'),
    transcribe: (audioBase64: string, format: string): Promise<string> =>
        ipcRenderer.invoke('audio:transcribe', { audioBase64, format }),
    getConfigStatus: (): Promise<ConfigStatus> => ipcRenderer.invoke('config:get-status'),
    saveConfig: (cfg: GatewayConfigInput): Promise<void> => ipcRenderer.invoke('config:save', cfg),
    setPinned: (pinned: boolean): Promise<void> => ipcRenderer.invoke('window:set-pinned', pinned),

    // main -> Sidebar (event subscriptions)
    onTurnAppended: (cb: (turn: TurnView) => void): (() => void) =>
        subscribe<[TurnView]>('turn:appended', cb),
    onPending: (cb: (pending: boolean) => void): (() => void) =>
        subscribe<[boolean]>('request:pending', cb),
    onError: (cb: (err: GlassError) => void): (() => void) => subscribe<[GlassError]>('error:show', cb),
    onCredentialsRequired: (cb: () => void): (() => void) =>
        subscribe<[]>('credentials:required', cb),
    onSessionState: (cb: (session: SessionView) => void): (() => void) =>
        subscribe<[SessionView]>('session:state', cb),
    onSummary: (cb: (summary: SessionSummary) => void): (() => void) =>
        subscribe<[SessionSummary]>('summary:state', cb),
    onCaptureStaged: (cb: (capture: TurnCapture) => void): (() => void) =>
        subscribe<[TurnCapture]>('capture:staged', cb),
    onGatewayFallback: (cb: (ctx: SessionContext, originId: string) => void): (() => void) =>
        subscribe<[SessionContext, string]>('chat:fallback', cb),
    submitFallbackResult: (text: string | null, originId: string): Promise<void> =>
        ipcRenderer.invoke('chat:fallback-result', { text, originId }),

    // Overlay -> main
    submitRegion: (rect: Rect, text?: string): Promise<void> =>
        ipcRenderer.invoke('capture:region', { rect, text }),
    cancelRegion: (): Promise<void> => ipcRenderer.invoke('capture:cancel')
}

contextBridge.exposeInMainWorld('glass', bridge)

// ---------------------------------------------------------------------------
// Operator bridge (merged Click Operator engine) — window.operator
// ---------------------------------------------------------------------------
//
// The autonomous operator engine is vendored into `src/main/operator` and wired
// through its own `op:`-prefixed IPC channels so it never collides with Click
// Copilot's own `glass` channels. This bridge is the ONLY path from the sandbox
// renderer to those channels: renderers can start/steer a task and subscribe to
// its activity, but capture, reasoning, and input synthesis have no channel
// here (they stay in the privileged main process).
import type {
    OperatorBridge,
    StartGoalInput,
    StartResult,
    ConfirmActionInput,
    ConfirmationRequest,
    AgentSessionView,
    LoopStateView,
    TrajectoryStepView,
    OperatorError,
    PermissionSnapshot,
    ProviderChainView,
    ProviderChainInput,
    ProviderStatus
} from '@op-shared/types'

const operatorBridge: OperatorBridge = {
    ready: true,

    // Sidebar -> main : task lifecycle
    startGoal: (input: StartGoalInput): Promise<StartResult> =>
        ipcRenderer.invoke('op:goal:start', input),
    pauseSession: (): Promise<void> => ipcRenderer.invoke('op:session:pause'),
    resumeSession: (): Promise<void> => ipcRenderer.invoke('op:session:resume'),
    stopSession: (): Promise<void> => ipcRenderer.invoke('op:session:stop'),
    confirmAction: (decision: ConfirmActionInput): Promise<void> =>
        ipcRenderer.invoke('op:confirm:action', decision),
    answerHelp: (text: string): Promise<void> => ipcRenderer.invoke('op:help:answer', { text }),
    getSession: (): Promise<AgentSessionView> => ipcRenderer.invoke('op:session:get'),
    listSessions: () => ipcRenderer.invoke('op:session:list'),
    openSession: (id: string): Promise<AgentSessionView> =>
        ipcRenderer.invoke('op:session:open', { id }),
    deleteSessions: (ids: string[]): Promise<void> =>
        ipcRenderer.invoke('op:session:delete', { ids }),
    getConfigStatus: () => ipcRenderer.invoke('op:config:get-status'),
    saveConfig: (cfg): Promise<void> => ipcRenderer.invoke('op:config:save', cfg),
    getPermissions: (): Promise<PermissionSnapshot> => ipcRenderer.invoke('op:perm:get'),

    // Model_Provider management
    getProviders: (): Promise<ProviderChainView> => ipcRenderer.invoke('op:providers:get'),
    saveProviders: (input: ProviderChainInput): Promise<void> =>
        ipcRenderer.invoke('op:providers:save', input),
    testProvider: (id: string): Promise<ProviderStatus> =>
        ipcRenderer.invoke('op:providers:test', { id }),

    // On-screen Emergency_Stop (fail-closed fallback)
    emergencyStop: (): Promise<void> => ipcRenderer.invoke('op:emergency:stop'),

    // main -> renderers : event subscriptions (each returns an unsubscribe so the
    // renderer can rebind cleanly across re-mounts / hot reloads).
    onStateChanged: (cb: (s: LoopStateView) => void): (() => void) =>
        subscribe<[LoopStateView]>('op:state:changed', cb),
    onTrajectoryAppended: (cb: (step: TrajectoryStepView) => void): (() => void) =>
        subscribe<[TrajectoryStepView]>('op:trajectory:appended', cb),
    onConfirmationRequired: (cb: (req: ConfirmationRequest) => void): (() => void) =>
        subscribe<[ConfirmationRequest]>('op:confirmation:required', cb),
    onHelpRequired: (cb: (question: string) => void): (() => void) =>
        subscribe<[string]>('op:help:required', cb),
    onIndicatorVisibility: (cb: (visible: boolean) => void): (() => void) => {
        const a = subscribe('op:indicator:show', () => cb(true))
        const b = subscribe('op:indicator:hide', () => cb(false))
        return () => {
            a()
            b()
        }
    },
    onError: (cb: (err: OperatorError) => void): (() => void) =>
        subscribe<[OperatorError]>('op:error:show', cb),
    onPermissionChanged: (cb: (p: PermissionSnapshot) => void): (() => void) =>
        subscribe<[PermissionSnapshot]>('op:permission:changed', cb),
    onCredentialsRequired: (cb: () => void): (() => void) =>
        subscribe('op:credentials:required', cb)
}

contextBridge.exposeInMainWorld('operator', operatorBridge)
