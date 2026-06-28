import type {
    Action,
    ActionResult,
    AgentSession,
    ConfirmationRequest,
    LoopStateView,
    Observation,
    OperatorError,
    PermissionSnapshot,
    ReasoningContext,
    RoutedOutcome,
    SessionStatus,
    TrajectoryStepView
} from '@op-shared/types'
import type { ExternalGateInputs, GateDecision } from '../safety'
import type { ClassificationContext } from '../classify'
import type { AppendStepInput } from '../session'
import type { CaptureOptions, PerceptionResult } from '../perception'

/**
 * Injected collaborator surfaces for the Agent Loop Controller.
 *
 * The loop is deliberately dependency-injected and Electron-free so the whole
 * state machine can be exercised headlessly by unit + property tests. Each
 * interface here is the narrow slice of a real main-process service the loop
 * actually depends on — nothing more — which keeps the loop testable and its
 * coupling honest. The concrete services (Perception, ProviderChain, Safety
 * Controller, Executor, Session Manager) satisfy these shapes at wiring time.
 */

/** The Perception Service surface the loop drives. */
export interface LoopPerception {
    capture(options?: CaptureOptions): Promise<PerceptionResult>
}

/** The reasoning entry point (ProviderChain router). */
export interface LoopReasoning {
    reason(ctx: ReasoningContext): Promise<RoutedOutcome>
}

/**
 * The fail-closed Safety gate surface. This is the single chokepoint: the loop
 * routes EVERY proposed Action through `evaluate` and never touches the Executor
 * without an `allow` decision first. Keeping the gate a distinct injected
 * interface makes that invariant structural rather than a matter of discipline.
 */
export interface LoopSafetyGate {
    evaluate(action: unknown, external: ExternalGateInputs): GateDecision
    isStopped(): boolean
    setInControl(value: boolean): void
}

/** Per-attempt metadata handed to the executor (echoed into the ActionResult). */
export interface LoopExecuteMeta {
    highRisk?: boolean
    confirmed?: boolean
}

/** The Action Executor surface — only ever invoked AFTER the gate allows. */
export interface LoopExecutor {
    execute(
        rawAction: Action,
        observation: Observation,
        meta?: LoopExecuteMeta
    ): Promise<ActionResult>
}

/** The Session / Trajectory Manager surface the loop records through. */
export interface LoopSession {
    getSession(): AgentSession | null
    isActingAllowed(): boolean
    start(): boolean
    resume(): boolean
    appendStep(input: AppendStepInput): unknown
    recordSafetyEvent(event: { type: 'emergency-stop' | 'declined' | 'blocked'; reason: string; at?: string }): boolean
    setStatus(status: SessionStatus): void
    end(status: SessionStatus): void
}

/** Side-effect emitters (map to the design's main -> renderer channels). */
export interface LoopEmitters {
    /** `state:changed` (Req 6.5, 12). */
    emitState?: (view: LoopStateView) => void
    /** `trajectory:appended` (Req 14.1-14.3). */
    emitTrajectoryAppended?: (step: TrajectoryStepView) => void
    /** `confirmation:required` (Req 9.5, 10.1). */
    emitConfirmationRequired?: (req: ConfirmationRequest) => void
    /** `indicator:show` (Req 12.1). */
    emitIndicatorShow?: () => void
    /** `indicator:hide` (Req 12.2). */
    emitIndicatorHide?: () => void
    /** `error:show` (Req 2.7, 3.4, 5.4). */
    emitError?: (error: OperatorError) => void
    /** Present the completion result to the user (Req 6.2). */
    presentCompletion?: (summary: string) => void
    /** Present the agent's help question to the user (Req 6.4). */
    presentHelp?: (question: string) => void
}

/** Everything the loop needs to run. */
export interface AgentLoopDeps {
    perception: LoopPerception
    reasoning: LoopReasoning
    safety: LoopSafetyGate
    executor: LoopExecutor
    session: LoopSession
    /** Current macOS permission snapshot for the gate (Req 16, 17). */
    getPermissions: () => PermissionSnapshot
    emitters?: LoopEmitters
    /** Injectable clock (test seam). */
    now?: () => string
    /** Injectable id factory for confirmation correlation ids (test seam). */
    generateId?: () => string
    /** Recent steps carried verbatim in reasoning context. Defaults to `KEEP_RECENT`. */
    keepRecent?: number
    /** Capture options for each Observation (full-screen vs active-window, a11y). */
    captureOptions?: CaptureOptions
    /** Optional classification context provider for the gate's High_Risk decision (Req 9). */
    getClassification?: (action: Action) => ClassificationContext | undefined
}
