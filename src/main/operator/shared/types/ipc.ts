/**
 * The IPC contract: loop state, request/response payloads, renderer views, and
 * the preload {@link OperatorBridge}.
 *
 * These are the messages that cross the process boundary — Console/Indicator ->
 * main payloads, main -> renderer views/events, and the single bridge exposed
 * on `window.operator`. Renderers can request state changes and subscribe to
 * events, but can never invoke capture, reasoning, or input synthesis directly.
 */

import type { Action } from './action'
import type { AgentSessionView, AutonomyLevel, EnvironmentId, SessionListItem } from './session'
import type { TrajectoryStepView } from './trajectory'
import type {
    GatewayConfigInput,
    ProviderChainInput,
    ProviderChainView,
    ProviderStatus
} from './provider'
import type { PermissionSnapshot } from './permissions'
import type { OperatorError } from './errors'
import type { Playbook, PlaybookInput } from './playbook'

// ---------------------------------------------------------------------------
// Agent-loop state (for the state:changed event view)
// ---------------------------------------------------------------------------

/** The Agent Loop Controller's state-machine states. */
export type LoopState =
    | 'idle'
    | 'perceiving'
    | 'reasoning'
    | 'awaiting-confirmation'
    | 'acting'
    | 'paused'
    | 'awaiting-help'
    | 'stopped'
    | 'completed'
    | 'failed'
    | 'budget-exhausted'

// ---------------------------------------------------------------------------
// IPC payload types (Console/Indicator -> main)
// ---------------------------------------------------------------------------

/** `goal:start` payload (Req 1.1-1.5, 8.1, 11.1). */
export interface StartGoalInput {
    goal: string
    autonomy: AutonomyLevel
    stepBudget: number
    /** Which Execution_Environment to run against (Req 22.2). Defaults to local. */
    environment?: EnvironmentId
}

/** Result of a `goal:start` request. */
export type StartResult =
    | { ok: true; sessionId: string }
    | { ok: false; error: OperatorError }

/** `confirm:action` payload (Req 9.3-9.5, 10.1, 10.5). */
export interface ConfirmActionInput {
    stepId: string
    approved: boolean
}

/** `session:open` payload (Req 18.5). */
export interface OpenSessionInput {
    id: string
}

/** `providers:test` payload (Req 21.6, 21.7). */
export interface TestProviderInput {
    id: string
}

// ---------------------------------------------------------------------------
// IPC view types (main -> renderers)
// ---------------------------------------------------------------------------

/** The loop-state view broadcast on `state:changed` (Req 6.5, 12). */
export interface LoopStateView {
    state: LoopState
    sessionId: string | null
    /** Whether the agent is currently in control (indicator shown). */
    inControl: boolean
    /** Reasoning steps taken so far. */
    stepCount: number
    stepBudget: number
}

/** A request for the user to confirm a concrete proposed Action (Req 9.5, 10.1). */
export interface ConfirmationRequest {
    stepId: string
    action: Action
    /** True when the Action was classified High_Risk (Req 9). */
    highRisk: boolean
    rationale: string
}

// ---------------------------------------------------------------------------
// Preload bridge (renderer-facing API on window.operator)
// ---------------------------------------------------------------------------

/**
 * The renderer-facing bridge exposed on `window.operator` via `contextBridge`.
 *
 * Renderers can request state changes and subscribe to events, but can never
 * invoke capture, reasoning, or input synthesis directly. Every method mirrors
 * a channel in the design's IPC channel map.
 *
 * `ready` is preserved from the scaffold as a health flag. The lifecycle,
 * config/provider, permission, and event-subscription methods are declared
 * optional so the scaffold preload (`{ ready: true }`) remains valid while the
 * backing services are wired up by their owning tasks; each becomes live once
 * its channel is registered.
 */
export interface OperatorBridge {
    /** Scaffold health flag; always true once the bridge is injected. */
    readonly ready: boolean

    // Console -> main : session lifecycle & config
    startGoal?(input: StartGoalInput): Promise<StartResult> // Req 1
    pauseSession?(): Promise<void> // Req 10.3
    resumeSession?(): Promise<void> // Req 10.4
    stopSession?(): Promise<void> // Req 7.3
    confirmAction?(decision: ConfirmActionInput): Promise<void> // Req 9, 10
    /** Answer a question the agent asked (feeds guidance + resumes). */
    answerHelp?(text: string): Promise<void>
    getSession?(): Promise<AgentSessionView> // Req 18.2 restore
    listSessions?(): Promise<SessionListItem[]> // Req 18
    deleteSessions?(ids: string[]): Promise<void> // delete archived operator sessions
    openSession?(id: string): Promise<AgentSessionView> // Req 18.5
    getConfigStatus?(): Promise<{ hasCredentials: boolean; models: string[] }> // Req 15.4, 15.6
    saveConfig?(cfg: GatewayConfigInput): Promise<void> // Req 15.2
    // Playbooks: saved reusable task templates (list / upsert / delete).
    // Save + delete return the updated list (one round-trip for the renderer).
    listPlaybooks?(): Promise<Playbook[]>
    savePlaybook?(input: PlaybookInput): Promise<Playbook[]>
    deletePlaybooks?(ids: string[]): Promise<Playbook[]>
    getPermissions?(): Promise<PermissionSnapshot> // Req 16, 17

    // Console -> main : Model_Provider management (Req 21)
    getProviders?(): Promise<ProviderChainView> // Req 21.1, 21.2, 21.10
    saveProviders?(input: ProviderChainInput): Promise<void> // Req 21.1, 21.2, 21.8
    testProvider?(id: string): Promise<ProviderStatus> // Req 21.6, 21.7

    // Control_Indicator -> main : the on-screen emergency stop (fail-closed fallback)
    emergencyStop?(): Promise<void> // Req 7.2, 7.3, 7.8

    // main -> renderers (event subscriptions). Each returns an unsubscribe so the
    // renderer can rebind cleanly across re-mounts / hot reloads.
    onStateChanged?(cb: (s: LoopStateView) => void): () => void // Req 6.5, 12
    onTrajectoryAppended?(cb: (step: TrajectoryStepView) => void): () => void // Req 14.1-14.3
    onConfirmationRequired?(cb: (req: ConfirmationRequest) => void): () => void // Req 9.5, 10.1
    /** A question the agent is asking the user (rendered in the chat). */
    onHelpRequired?(cb: (question: string) => void): () => void
    onIndicatorVisibility?(cb: (visible: boolean) => void): () => void // Req 12.1, 12.2
    onError?(cb: (err: OperatorError) => void): () => void // Req 2.7, 3.4, 5.4, 15.5
    onPermissionChanged?(cb: (p: PermissionSnapshot) => void): () => void // Req 16.3, 17.3
    onCredentialsRequired?(cb: () => void): () => void // Req 15.4, 15.7
}
