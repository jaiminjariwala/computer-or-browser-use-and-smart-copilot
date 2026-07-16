import type {
    Action,
    ActionResult,
    ConfirmActionInput,
    EnvironmentId,
    LoopState,
    Observation,
    PermissionSnapshot,
    TokenUsage
} from '@op-shared/types'
import {
    blockedActionResult,
    type ConfirmationState,
    type ExternalGateInputs,
    type GateBlocked,
    type GateDecision
} from '../safety'
import type { ClassificationContext } from '../classify'
import { toTrajectoryStepView, type AppendStepInput } from '../session'
import { buildReasoningContext, KEEP_RECENT } from '../summarizer'
import type { CaptureOptions } from '../perception'
import type {
    AgentLoopDeps,
    LoopEmitters,
    LoopExecutor,
    LoopPerception,
    LoopReasoning,
    LoopSafetyGate,
    LoopSession
} from './deps'
import { isTerminalState, type TerminalState } from './states'
import { actionSignature, buildProgressHint, hardStuckReason } from './progress'

/** Most-recent executed Actions retained for stuck/repeat detection. */
const PROGRESS_WINDOW = 8

/**
 * Agent Loop Controller (Task 13) — the perceive → reason → act → observe state
 * machine and the single orchestrator of a run.
 *
 * The loop drives perceive → reason → act → observe and:
 *
 *  - checks the **Step_Budget BEFORE acting** — reaching the budget stops the
 *    loop before a further Action and sets status `budget-exhausted`
 *    (Req 6.3, 11.2, 11.3, 11.4 — Property 15);
 *  - sets the terminal session status reflecting the ending condition on
 *    completion/help/failure/stop/budget (Req 6.2, 6.4, 6.5 — Property 16);
 *  - routes every proposed Action through the Safety gate and only executes an
 *    allowed Action; a required Confirmation suspends the loop at
 *    `awaiting-confirmation` until the user approves (→ act) or declines
 *    (→ record + re-observe) (Req 6.2, 6.4, 10.1, 10.3, 10.4);
 *  - honours **Pause** after the current Action completes and starts no new
 *    Reasoning_Step until Resume (Req 10.3, 10.4 — Property 18);
 *  - records an {@link ActionResult} for **every** attempt and produces a fresh
 *    Observation before the next Reasoning_Step regardless of outcome (Req 5.3,
 *    5.7 — Property 9);
 *  - emits `state:changed` on every transition and drives the Control_Indicator
 *    show/hide in lockstep with in-control state (Req 6.5, 12.1, 12.2), and
 *    records the trajectory through the Session Manager (Req 14).
 *
 * The collaborator interfaces live in `./deps`; see that file for the fail-closed
 * gate invariant. States: `idle`, `perceiving`, `reasoning`,
 * `awaiting-confirmation`, `acting`, `paused`, `awaiting-help`, `stopped`,
 * `completed`, `failed`, `budget-exhausted`.
 *
 * _Requirements: 5.3, 5.7, 6.1-6.5, 10.1, 10.3, 10.4, 11.2-11.4, 12.1, 12.2 —
 * Properties 9, 15, 16, 18._
 */

/** A proposed Action awaiting the gate / confirmation before execution. */
interface PendingAction {
    /** Correlation id echoed in the ConfirmationRequest / confirm decision. */
    stepId: string
    action: Action
    rationale: string
    providerId: string | null
    /** The concrete model id that proposed this Action (observability). */
    model?: string
    /** Token usage reported for the reasoning call that proposed this Action. */
    usage?: TokenUsage
    classification?: ClassificationContext
}

function errorMessage(err: unknown): string {
    if (err instanceof Error && err.message.trim().length > 0) return err.message.trim()
    if (typeof err === 'string' && err.trim().length > 0) return err.trim()
    return 'unknown error'
}

/**
 * How many consecutive reasoning failures (unparseable output or
 * all-providers-failed) the loop tolerates — retrying a different approach each
 * time — before giving up on the task. Reset after any successful step.
 */
const MAX_REASONING_RETRIES = 5

/** Backoff before retrying after a provider/infra failure (transient 429s). */
const RETRY_BACKOFF_MS = 4000

/** Resolve after `ms` milliseconds (used for the failure-retry backoff). */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The perceive → reason → act → observe state machine. Construct with injected
 * collaborators; drive with {@link start} / {@link pause} / {@link resume} /
 * {@link stop} / {@link confirm}.
 */
export class AgentLoop {
    private readonly perception: LoopPerception
    private readonly reasoning: LoopReasoning
    private readonly safety: LoopSafetyGate
    private readonly executor: LoopExecutor
    private readonly session: LoopSession
    private readonly getPermissions: () => PermissionSnapshot
    private readonly emitters: LoopEmitters
    private readonly now: () => string
    private readonly generateId: () => string
    private readonly keepRecent: number
    private readonly captureOptions?: CaptureOptions
    private readonly getClassification?: (action: Action) => ClassificationContext | undefined

    private state: LoopState = 'idle'
    private inControl = false
    /** Reasoning steps recorded so far in this run (Req 11.2). */
    private stepCount = 0
    /** The Observation the current Reasoning_Step reasons over. */
    private currentObservation: Observation | null = null
    /** Set when a Pause is requested; takes effect after the current Action (Req 10.3). */
    private pauseRequested = false
    /** True once the loop has been stopped and must not run again (Req 7.4). */
    private stopped = false
    /** Re-entrancy guard for the async drive loop. */
    private driving = false
    /** Public async controls currently waiting on perception/reasoning/execution. */
    private readonly inFlightOperations = new Set<Promise<void>>()
    /** Blocks a new run while deletion waits for all active work to settle. */
    private quiescing = false
    /** The Action currently held between reasoning and execution. */
    private pendingAction: PendingAction | null = null
    /** The outstanding confirmation correlation, if suspended at awaiting-confirmation. */
    private pendingConfirmation: { stepId: string } | null = null
    /**
     * Consecutive reasoning failures (unparseable output or all-providers-failed)
     * since the last successful step. The loop retries a different approach up to
     * {@link MAX_REASONING_RETRIES} before giving up, so a transient provider
     * hiccup or one bad model turn no longer aborts the whole task.
     */
    private reasoningFailures = 0
    /**
     * The most-recent executed Actions (capped at {@link PROGRESS_WINDOW}), used
     * to detect the agent repeating the same ineffective Action so it can be
     * nudged to self-correct (and, if it persists, fail fast). Only executed
     * Actions are tracked — blocked/declined Actions never reach the executor.
     */
    private readonly recentActions: Action[] = []
    /**
     * Consecutive executed Actions that ended in a non-success ActionResult
     * (failure/blocked/rejected) since the last successful Action. Reset to 0 on
     * any success. Feeds the self-correction guidance and the hard stuck-limit.
     */
    private consecutiveActionFailures = 0

    constructor(deps: AgentLoopDeps) {
        this.perception = deps.perception
        this.reasoning = deps.reasoning
        this.safety = deps.safety
        this.executor = deps.executor
        this.session = deps.session
        this.getPermissions = deps.getPermissions
        this.emitters = deps.emitters ?? {}
        this.now = deps.now ?? (() => new Date().toISOString())
        this.generateId = deps.generateId ?? createIdGenerator()
        this.keepRecent = deps.keepRecent ?? KEEP_RECENT
        this.captureOptions = deps.captureOptions
        this.getClassification = deps.getClassification
    }

    // ---- Public inspection -------------------------------------------------

    /** The current state-machine state. */
    getState(): LoopState {
        return this.state
    }

    /** Reasoning steps recorded so far this run. */
    getStepCount(): number {
        return this.stepCount
    }

    /** Whether the agent is currently in control (indicator shown). */
    isInControl(): boolean {
        return this.inControl
    }

    // ---- Public controls ---------------------------------------------------

    /**
     * Begin the run on an explicitly-started session (Req 1.4, 13.3). Opens the
     * Session Manager's acting gate, shows the Control_Indicator, and drives the
     * loop from `perceiving`. No-op if the loop is already terminal. The returned
     * promise resolves when the loop next suspends (awaiting confirmation/help,
     * paused) or terminates.
     */
    start(): Promise<void> {
        if (this.quiescing) return Promise.resolve()
        // Ignore a Start while a run is already actively in progress.
        if (this.isActiveRunState()) return Promise.resolve()
        // Begin a FRESH run. The loop is a single long-lived instance, so a new
        // Start (new goal / new session) must clear the per-run state left by a
        // completed/stopped/failed previous run — otherwise the terminal state
        // would block the new run and nothing would happen.
        this.resetRunState()
        // Explicit user start opens the acting gate (Req 1.4, 13.3).
        if (!this.session.start()) return Promise.resolve()
        this.setControl(true)
        this.transition('perceiving')
        return this.trackOperation(this.drive())
    }

    /** Whether a run is actively in progress (not idle/paused/terminal). */
    private isActiveRunState(): boolean {
        return (
            this.state === 'perceiving' ||
            this.state === 'reasoning' ||
            this.state === 'acting' ||
            this.state === 'awaiting-confirmation'
        )
    }

    /** Clear all per-run state so a new Start begins from a clean slate. */
    private resetRunState(): void {
        this.state = 'idle'
        this.stepCount = 0
        this.stopped = false
        this.pauseRequested = false
        this.driving = false
        this.currentObservation = null
        this.pendingAction = null
        this.pendingConfirmation = null
        this.reasoningFailures = 0
        this.recentActions.length = 0
        this.consecutiveActionFailures = 0
    }

    /**
     * Request a Pause. It takes effect after the current Action completes: the
     * loop suspends at `paused` and starts no new Reasoning_Step until
     * {@link resume} (Req 10.3, 10.4). While suspended at awaiting-confirmation,
     * the pause applies once the pending decision is resolved.
     */
    pause(): void {
        if (this.isTerminal() || this.state === 'paused') return
        this.pauseRequested = true
    }

    /**
     * Resume a paused (or awaiting-help) session from the suspended point
     * (Req 10.4). Re-opens the acting gate, re-shows the indicator, and drives
     * from `perceiving`. Progress (step count, Trajectory) is preserved
     * (Property 18).
     */
    resume(): Promise<void> {
        if (this.quiescing) return Promise.resolve()
        if (this.state !== 'paused' && this.state !== 'awaiting-help') return Promise.resolve()
        if (this.stopped) return Promise.resolve()
        this.pauseRequested = false
        this.session.resume()
        const session = this.session.getSession()
        if (session && session.status !== 'running') this.session.setStatus('running')
        this.setControl(true)
        this.transition('perceiving')
        return this.trackOperation(this.drive())
    }

    /**
     * Stop the loop from any active state (user Stop / on-screen path, Req 7.3).
     * Records the stop in the Trajectory (Req 7.6), cancels any pending
     * confirmation, and sets the terminal status `stopped` (Req 7.4). No further
     * Action executes until a new run is started.
     */
    stop(): void {
        if (this.isTerminal()) return
        this.stopped = true
        this.pendingConfirmation = null
        // Record the stop event in the Trajectory (Req 7.6).
        this.recordStopEvent('Session stopped by user')
        this.pendingAction = null
        this.enterTerminal('stopped')
    }

    /**
     * Stop and wait until every already-started async control path has settled.
     * New starts/resumes/confirmations are rejected during this boundary. This
     * is used before deleting the active SessionManager state so an executor or
     * provider cannot resume and append into a detached session.
     */
    async stopAndWait(): Promise<void> {
        this.quiescing = true
        if (
            this.session.getSession() &&
            (this.inFlightOperations.size > 0 || this.isActiveRunState())
        ) {
            this.stop()
        } else {
            this.stopped = true
            this.pendingConfirmation = null
            this.pendingAction = null
            if (this.inControl) this.setControl(false)
        }
        try {
            while (this.inFlightOperations.size > 0) {
                await Promise.allSettled([...this.inFlightOperations])
            }
        } finally {
            this.quiescing = false
        }
    }

    /** Track a public async control without creating an unhandled derived promise. */
    private trackOperation(operation: Promise<void>): Promise<void> {
        this.inFlightOperations.add(operation)
        const remove = (): void => {
            this.inFlightOperations.delete(operation)
        }
        void operation.then(remove, remove)
        return operation
    }

    /**
     * Record the Emergency_Stop in the Trajectory (Req 7.6). Attaches the event
     * to the most recent step when one exists; otherwise — e.g. a stop while
     * suspended at awaiting-confirmation before the pending Action's step was
     * written — records the pending Action as blocked-by-stop carrying the event
     * so the audit is never missing the stop (Req 14.5).
     */
    private recordStopEvent(reason: string): void {
        const event = { type: 'emergency-stop' as const, reason, at: this.now() }
        const attached = this.session.recordSafetyEvent(event)
        if (attached) return
        if (!this.currentObservation) return
        if (this.pendingAction) {
            this.recordStep({
                observation: this.currentObservation,
                reasoning: {
                    outcome: 'action',
                    rationale: this.pendingAction.rationale,
                    providerId: this.pendingAction.providerId,
                    model: this.pendingAction.model,
                    usage: this.pendingAction.usage
                },
                action: this.pendingAction.action,
                result: {
                    status: 'blocked',
                    reason,
                    highRisk: false,
                    confirmed: false,
                    executedAt: this.now()
                },
                events: [event]
            })
        }
    }

    /**
     * Halt callback for the Safety Controller's Emergency_Stop (wired to its
     * `haltLoop`). The controller has already recorded the stop event and
     * cancelled in-flight work, so this only drives the loop to the terminal
     * `stopped` state without double-recording.
     */
    handleHalt(): void {
        if (this.isTerminal()) return
        this.stopped = true
        this.pendingConfirmation = null
        this.pendingAction = null
        this.enterTerminal('stopped')
    }

    /**
     * Resolve an outstanding Confirmation for the proposed Action (Req 9.3-9.5,
     * 10.1, 10.5). An approval routes the Action back through the gate and, if
     * allowed, executes it; a decline records the declined Action and re-observes
     * (Req 9.4, 10.5). Ignored unless the loop is suspended at
     * `awaiting-confirmation` for this exact `stepId`.
     */
    confirm(decision: ConfirmActionInput): Promise<void> {
        if (this.quiescing) return Promise.resolve()
        return this.trackOperation(this.resolveConfirmation(decision))
    }

    private async resolveConfirmation(decision: ConfirmActionInput): Promise<void> {
        if (this.state !== 'awaiting-confirmation' || this.stopped) return
        if (!this.pendingConfirmation || decision.stepId !== this.pendingConfirmation.stepId) return
        this.pendingConfirmation = null

        const confirmation: ConfirmationState = decision.approved ? 'approved' : 'declined'
        const gateDecision = this.evaluateGate(confirmation)
        if (gateDecision.allow) {
            await this.performAction(gateDecision.action, gateDecision.highRisk, confirmation === 'approved')
        } else {
            this.recordBlockedAndContinue(gateDecision)
        }
        await this.drive()
    }

    // ---- The drive loop ----------------------------------------------------

    /**
     * Advance the state machine until it suspends (awaiting confirmation/help,
     * paused) or reaches a terminal state. Re-entrancy-guarded so overlapping
     * calls (e.g. a resume racing an in-flight drive) are safe.
     */
    private async drive(): Promise<void> {
        if (this.driving) return
        this.driving = true
        try {
            for (; ;) {
                if (this.stopped) return
                if (
                    this.isTerminal() ||
                    this.state === 'paused' ||
                    this.state === 'awaiting-help' ||
                    this.state === 'awaiting-confirmation'
                ) {
                    return
                }

                let cont: boolean
                if (this.state === 'perceiving') cont = await this.doPerceive()
                else if (this.state === 'reasoning') cont = await this.doReason()
                else return

                if (!cont) return
            }
        } finally {
            this.driving = false
        }
    }

    /** Perceive phase: capture an Observation (or fail closed). */
    private async doPerceive(): Promise<boolean> {
        // Pause takes effect before starting a new cycle (Req 10.3).
        if (this.pauseRequested) {
            this.enterPaused()
            return false
        }
        const result = await this.perception.capture(this.captureOptions)
        if (this.stopped || this.safety.isStopped()) {
            this.handleHalt()
            return false
        }
        if (!result.ok) {
            // Capture failure pauses the loop and is surfaced (Req 2.7); a
            // session-inactive result also fails closed to paused.
            if (result.reason === 'capture-failed' && result.error) {
                this.emitters.emitError?.(result.error)
            }
            this.enterPaused()
            return false
        }
        this.currentObservation = result.observation
        this.transition('reasoning')
        return true
    }

    /** Reason phase: budget check BEFORE acting, then one Reasoning_Step. */
    private async doReason(): Promise<boolean> {
        if (this.pauseRequested) {
            this.enterPaused()
            return false
        }
        const session = this.session.getSession()
        if (!session) {
            this.enterPaused()
            return false
        }
        // Step_Budget is checked BEFORE taking a further Action (Req 6.3, 11.3).
        if (this.stepCount >= session.stepBudget) {
            this.enterTerminal('budget-exhausted')
            return false
        }
        if (!this.currentObservation) {
            this.enterPaused()
            return false
        }

        // Reliability: if the agent is hopelessly stuck (same Action repeated
        // many times, or a long run of consecutive failures), fail fast with a
        // clear reason instead of grinding through the whole Step_Budget.
        const stuck = hardStuckReason(this.recentActions, this.consecutiveActionFailures)
        if (stuck) {
            this.recordStep({
                observation: this.currentObservation,
                reasoning: { outcome: 'failure', rationale: stuck, providerId: null }
            })
            this.emitters.emitError?.({
                kind: 'action-failed',
                message: stuck,
                recoverable: true,
                action: 'retry'
            })
            this.enterTerminal('failed')
            return false
        }

        // Reliability: below the hard limit, fold a one-shot corrective hint into
        // this reasoning turn so the model self-corrects (stops repeating an
        // ineffective Action / a failing approach) rather than looping.
        const progressHint = buildProgressHint(this.recentActions, this.consecutiveActionFailures)
        const guidance =
            progressHint !== null
                ? [...(session.guidance ?? []), progressHint]
                : session.guidance

        const ctx = buildReasoningContext(
            session.goal.text,
            session.summary,
            session.trajectory,
            this.currentObservation,
            this.keepRecent,
            environmentHintFor(session.environment),
            guidance
        )
        const outcome = await this.reasoning.reason(ctx)

        if (this.stopped || this.safety.isStopped()) {
            this.handleHalt()
            return false
        }

        // A non-failure outcome means the agent is making progress again; clear
        // the consecutive-failure counter so future hiccups get a fresh budget.
        if (outcome.kind !== 'failure') this.reasoningFailures = 0

        switch (outcome.kind) {
            case 'failure': {
                // A reasoning failure is unparseable model output or an
                // all-providers-failed (transient rate-limit / outage). Rather
                // than abort the whole task, RETRY a different approach: record
                // the failure (so the model sees it and self-corrects on the next
                // turn), and loop back to perceive+reason. Only after several
                // consecutive failures do we give up. This is the "try again,
                // then try something else" behavior (Req 3.4, 6.5).
                this.recordStep({
                    observation: this.currentObservation,
                    reasoning: {
                        outcome: 'failure',
                        rationale: outcome.reason,
                        providerId: outcome.providerId,
                        model: outcome.model,
                        usage: outcome.usage
                    }
                })
                this.reasoningFailures += 1
                const infra = outcome.reason.startsWith('all-providers-failed')

                if (this.reasoningFailures < MAX_REASONING_RETRIES) {
                    // For a provider/infra failure, back off briefly so a
                    // transient rate-limit (e.g. Gemini 429) can recover before
                    // the next attempt. Unparseable output retries immediately —
                    // the recorded failure nudges the model to emit a valid tool
                    // call next turn.
                    if (infra) await delay(RETRY_BACKOFF_MS)
                    if (this.stopped || this.safety.isStopped()) {
                        this.handleHalt()
                        return false
                    }
                    this.transition('perceiving')
                    return true
                }

                // Exhausted retries → surface the error and terminate.
                this.emitters.emitError?.({
                    kind: infra ? 'all-providers-failed' : 'reasoning-unparseable',
                    message: outcome.reason,
                    recoverable: true,
                    action: 'retry'
                })
                this.enterTerminal('failed')
                return false
            }

            case 'completion':
                // Completion signal → no Action executes; report result (Req 6.2, 3.6).
                this.recordStep({
                    observation: this.currentObservation,
                    reasoning: {
                        outcome: 'completion',
                        rationale: outcome.summary,
                        providerId: outcome.providerId,
                        model: outcome.model,
                        usage: outcome.usage
                    }
                })
                this.enterTerminal('completed')
                this.emitters.presentCompletion?.(outcome.summary)
                return false

            case 'help':
                // Help signal → no Action executes; present the question (Req 6.4, 3.6).
                this.recordStep({
                    observation: this.currentObservation,
                    reasoning: {
                        outcome: 'help',
                        rationale: outcome.question,
                        providerId: outcome.providerId,
                        model: outcome.model,
                        usage: outcome.usage
                    }
                })
                this.enterAwaitingHelp(outcome.question)
                return false

            case 'action':
                this.pendingAction = {
                    stepId: this.generateId(),
                    action: outcome.action,
                    rationale: outcome.rationale,
                    providerId: outcome.providerId,
                    model: outcome.model,
                    usage: outcome.usage,
                    classification: this.getClassification?.(outcome.action)
                }
                return this.decideAction()

            default: {
                const _never: never = outcome
                void _never
                this.enterPaused()
                return false
            }
        }
    }

    /**
     * Route the proposed Action through the fail-closed gate. On `allow`, act;
     * when Confirmation is required, suspend at `awaiting-confirmation`; on any
     * other block, record it and continue/terminate as appropriate.
     */
    private async decideAction(): Promise<boolean> {
        const decision = this.evaluateGate('pending')
        if (decision.allow) {
            return this.performAction(decision.action, decision.highRisk, false)
        }
        if (decision.reason === 'confirmation-required') {
            const pending = this.pendingAction!
            this.pendingConfirmation = { stepId: pending.stepId }
            this.transition('awaiting-confirmation')
            this.emitters.emitConfirmationRequired?.({
                stepId: pending.stepId,
                action: pending.action,
                highRisk: decision.highRisk,
                rationale: pending.rationale
            })
            return false
        }
        return this.recordBlockedAndContinue(decision)
    }

    /**
     * Execute an allowed Action through the Executor, record its ActionResult,
     * then re-observe (produce a fresh Observation) before the next
     * Reasoning_Step (Req 5.3, 5.7 — Property 9).
     */
    private async performAction(action: Action, highRisk: boolean, confirmed: boolean): Promise<boolean> {
        const pending = this.pendingAction!
        this.transition('acting')

        let result: ActionResult
        try {
            // The gate approved `action`; the executor applies Coordinate_Mapping
            // to the ORIGINATING image-space Action against the current Observation.
            result = await this.executor.execute(pending.action, this.currentObservation!, {
                highRisk,
                confirmed
            })
        } catch (err) {
            // The executor is designed never to throw; fail closed if it does.
            result = {
                status: 'failure',
                reason: errorMessage(err),
                highRisk,
                confirmed,
                executedAt: this.now()
            }
        }

        if (result.status !== 'success' && result.reason) {
            this.emitters.emitError?.({
                kind: result.status === 'rejected' ? 'action-rejected' : 'action-failed',
                message: result.reason,
                recoverable: true,
                action: 'retry'
            })
        }

        // Reliability bookkeeping: remember executed Actions (for repeat
        // detection) and track the consecutive-failure streak (reset on success).
        this.recentActions.push(pending.action)
        if (this.recentActions.length > PROGRESS_WINDOW) this.recentActions.shift()
        this.consecutiveActionFailures =
            result.status === 'success' ? 0 : this.consecutiveActionFailures + 1

        this.recordStep({
            observation: this.currentObservation!,
            reasoning: {
                outcome: 'action',
                rationale: pending.rationale,
                providerId: pending.providerId,
                model: pending.model,
                usage: pending.usage
            },
            action: pending.action,
            result
        })
        void action
        this.pendingAction = null

        if (this.stopped || this.safety.isStopped()) {
            this.handleHalt()
            return false
        }
        // Re-observe: a fresh Observation is produced before the next Reasoning_Step.
        this.transition('perceiving')
        return true
    }

    /**
     * Record a gate-blocked (or declined) Action as an ActionResult + safety
     * event in the Trajectory (Req 14.5), then decide the next state:
     *  - declined / rejected → re-observe and continue (Req 9.4, 10.5, 5.5);
     *  - emergency-stop → terminal `stopped`;
     *  - budget-exhausted → terminal `budget-exhausted`;
     *  - any other fail-closed block (indicator/permission/session/state) → pause.
     */
    private recordBlockedAndContinue(decision: GateBlocked): boolean {
        const pending = this.pendingAction!
        const result = blockedActionResult(decision, this.now) as ActionResult
        this.recordStep({
            observation: this.currentObservation!,
            reasoning: {
                outcome: 'action',
                rationale: pending.rationale,
                providerId: pending.providerId,
                model: pending.model,
                usage: pending.usage
            },
            action: pending.action,
            result,
            events: [decision.event]
        })
        this.pendingAction = null

        switch (decision.reason) {
            case 'emergency-stop-active':
                this.stopped = true
                this.enterTerminal('stopped')
                return false
            case 'budget-exhausted':
                this.enterTerminal('budget-exhausted')
                return false
            case 'confirmation-declined':
            case 'invalid-action':
                // Recorded (Req 9.4, 10.5, 5.5); re-observe and keep going.
                this.transition('perceiving')
                return true
            default:
                // indicator / permission / session / illegal-state → fail-closed pause.
                this.emitters.emitError?.({
                    kind: 'action-rejected',
                    message: decision.detail,
                    recoverable: true,
                    action: 'retry'
                })
                this.enterPaused()
                return false
        }
    }

    // ---- Terminal / suspend transitions -----------------------------------

    private enterTerminal(status: TerminalState): void {
        this.setControl(false)
        this.session.end(status)
        this.transition(status)
    }

    private enterPaused(): void {
        this.pauseRequested = false
        this.setControl(false)
        this.session.setStatus('paused')
        this.transition('paused')
    }

    private enterAwaitingHelp(question: string): void {
        this.setControl(false)
        this.session.setStatus('awaiting-help')
        this.transition('awaiting-help')
        this.emitters.presentHelp?.(question)
    }

    // ---- Helpers -----------------------------------------------------------

    private isTerminal(): boolean {
        return isTerminalState(this.state)
    }

    /** Evaluate the proposed Action through the fail-closed Safety gate. */
    private evaluateGate(confirmation: ConfirmationState): GateDecision {
        const session = this.session.getSession()
        const external: ExternalGateInputs = {
            sessionActive: this.session.isActingAllowed(),
            loopState: this.state,
            permissions: this.getPermissions(),
            stepCount: this.stepCount,
            stepBudget: session?.stepBudget ?? 0,
            autonomy: session?.autonomy ?? 'manual',
            confirmation,
            classification: this.pendingAction?.classification
        }
        return this.safety.evaluate(this.pendingAction!.action, external)
    }

    /**
     * Append a Trajectory step through the Session Manager, count it as a
     * Reasoning_Step against the Step_Budget, and emit it to the activity log.
     * Exactly one step is recorded per Reasoning_Step (action / completion /
     * help / failure), so `stepCount` equals the number of recorded steps.
     */
    private recordStep(input: AppendStepInput): void {
        const step = this.session.appendStep(input) as Parameters<typeof toTrajectoryStepView>[0]
        this.stepCount += 1
        this.emitters.emitTrajectoryAppended?.(toTrajectoryStepView(step))
        this.emitState()
    }

    /** Set in-control state, driving the Control_Indicator show/hide (Req 12.1, 12.2). */
    private setControl(value: boolean): void {
        this.inControl = value
        this.safety.setInControl(value)
        if (value) this.emitters.emitIndicatorShow?.()
        else this.emitters.emitIndicatorHide?.()
    }

    /** Transition to a new state and broadcast `state:changed` (Req 6.5). */
    private transition(state: LoopState): void {
        this.state = state
        this.emitState()
    }

    private emitState(): void {
        const session = this.session.getSession()
        this.emitters.emitState?.({
            state: this.state,
            sessionId: session?.id ?? null,
            inControl: this.inControl,
            stepCount: this.stepCount,
            stepBudget: session?.stepBudget ?? 0
        })
    }
}

/** Construct an {@link AgentLoop} with the given collaborators. */
export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
    return new AgentLoop(deps)
}

/**
 * A short environment description folded into the reasoning system prompt so the
 * agent uses the right conventions for where it is operating (Req 22). Without
 * this, the model defaults to macOS habits (Apple menu, Cmd, Spotlight) even in
 * a Linux/browser sandbox.
 */
function environmentHintFor(environment: EnvironmentId | undefined): string | undefined {
    switch (environment) {
        case 'browser':
            return (
                'ENVIRONMENT: You are operating a real WEB BROWSER (Chromium) through its DOM. You ' +
                'do NOT receive a screenshot; each step gives you the page text digest and a list ' +
                'of interactive elements with their (x,y) coordinates. Act from that text.\n' +
                'NAVIGATION: To open or go to a website, use the `type` action with the full URL ' +
                '(e.g. type "https://www.youtube.com"). The browser navigates there directly. Do ' +
                'NOT try to click the address bar, tabs, back/forward, or any browser toolbar — ' +
                'those are browser chrome and are NOT clickable; your clicks only hit the page ' +
                'content area. Do NOT use ["Control","l"] or press Enter to navigate; just `type` ' +
                'the URL.\n' +
                'ON THE PAGE: to search or fill a field, first left_click that field (from the ' +
                'element list) then `type` your text (a non-URL query types into the focused ' +
                'field), then submit with ["Enter"]. Click links/buttons by their listed (x,y), ' +
                'and scroll to reveal more. Read results and content from the provided page text.\n' +
                'CHOOSING RESULTS: do NOT just click the first result — it is often a sponsored ' +
                'ad. Read the page text/elements and pick the item whose title actually matches ' +
                'what the user asked for (e.g. the official song/video, not an ad, playlist, or ' +
                '"mix"). Skip elements labelled Ad/Sponsored. Scroll down if the right result is ' +
                'not yet visible before clicking.\n' +
                'There is NO operating-system UI (no Apple menu, Dock, Spotlight, System Settings) ' +
                '— never look for it. If the goal genuinely cannot be done on the web, use ' +
                'request_help.'
            )
        case 'container-desktop':
            return (
                'ENVIRONMENT: You are operating a WEB BROWSER (Firefox) running full-screen in a ' +
                'sandbox — like an OpenAI Operator session. You can ONLY browse the web. There is ' +
                'NO operating-system UI: no Apple menu, no Start menu, no Dock, no Spotlight, no ' +
                'System Settings, and no OS dark-mode toggle — never look for them. Accomplish the ' +
                'goal purely by navigating websites: click the address bar (or press Ctrl+L) and ' +
                'type a URL to go to a site, click links and buttons, fill in and submit forms, and ' +
                'scroll. Ctrl+T opens a new tab, Ctrl+L focuses the address bar. If the goal cannot ' +
                'be done on the web, use request_help to say so rather than hunting for OS settings.'
            )
        case 'local':
            return 'ENVIRONMENT: You are operating the user\'s macOS desktop; macOS conventions apply (Apple menu, Cmd shortcuts, Spotlight with Cmd+Space).'
        default:
            return undefined
    }
}

/** Default unique id generator for confirmation correlation ids. */
function createIdGenerator(): () => string {
    let counter = 0
    return () => {
        counter += 1
        const time = Date.now().toString(36)
        const seq = counter.toString(36)
        const rand = Math.random().toString(36).slice(2, 8)
        return `step-${time}-${seq}-${rand}`
    }
}
