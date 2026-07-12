import type {
    AgentSession,
    AgentSessionView,
    SafetyEvent,
    SessionStatus,
    TrajectoryStep,
    TrajectoryStepView,
    TrajectorySummary
} from '@op-shared/types'
import {
    clone,
    createDefaultIdGenerator,
    createSession as buildSession,
    defaultClock,
    defaultValidateAssociation,
    isBlankGoal,
    type AppendStepInput,
    type AssociationValidator,
    type Clock,
    type CreateSessionInput,
    type CreateSessionResult,
    type IdGenerator,
    type SessionManagerHooks,
    type SessionManagerOptions
} from './factories'
import { toAgentSessionView, toTrajectoryStepView } from './views'

/**
 * Session / Trajectory Manager (Task 12.1, 12.2).
 *
 * The in-memory source of truth for the active {@link AgentSession}. It:
 *  - **creates** a session recording the Goal and associating the Autonomy_Level
 *    + Step_Budget *before any Action* (Req 1.1, 1.3), rejecting empty/whitespace
 *    Goals (Req 1.2) and surfacing `association-failed` when association fails
 *    (Req 1.5);
 *  - keeps an **append-only, chronological** Trajectory with strictly increasing
 *    indices — steps are never reordered or deleted (Req 14.2, Property 19);
 *  - records the chosen Action + parameters + rationale, the ActionResult, and
 *    blocked/declined SafetyEvents with reasons (Req 14.3, 14.5);
 *  - retains the complete Trajectory after the session ends (Req 14.4);
 *  - gates *acting* behind an explicit user start/resume (Req 1.4, 13.3, 18.3,
 *    18.5, Property 22): a freshly created, restored, or loaded session takes no
 *    Action until {@link SessionManager.start}/{@link SessionManager.resume};
 *  - preserves the prior session when a new one is created (Req 18.4,
 *    Property 23) via the {@link SessionManagerHooks.onArchive} seam.
 *
 * It is pure and Electron-free so it can be unit-tested directly. Disk I/O lives
 * in the Session Store (Task 12.3) and summarization triggering in the Summarizer
 * (Task 12.4), both wired through the {@link SessionManagerHooks} seams.
 */
export class SessionManager {
    private session: AgentSession | null = null
    /**
     * Explicit-start gate (Req 1.4, 13.3, 18.3, 18.5, Property 22). Acting is
     * only ever permitted after the user explicitly starts/resumes the session;
     * creation, restore, and load all leave this `false`.
     */
    private started = false
    private readonly generateId: IdGenerator
    private readonly now: Clock
    private readonly validateAssociation: AssociationValidator
    private readonly hooks: SessionManagerHooks

    constructor(options: SessionManagerOptions = {}) {
        this.generateId = options.generateId ?? createDefaultIdGenerator()
        this.now = options.now ?? defaultClock
        this.validateAssociation = options.validateAssociation ?? defaultValidateAssociation
        this.hooks = options.hooks ?? {}
    }

    /** The live active session (internal reference), or null if none exists yet. */
    getSession(): AgentSession | null {
        return this.session
    }

    /** True once a session exists (created, restored, or loaded). */
    hasSession(): boolean {
        return this.session !== null
    }

    /**
     * The explicit-start gate other components (e.g. the Safety Controller)
     * consult: acting is permitted only when a session exists, the user has
     * explicitly started/resumed it, and it is in an actable state (Req 13.3,
     * 18.3, 18.5, Property 22).
     */
    isActingAllowed(): boolean {
        if (this.session === null || !this.started) return false
        return this.session.status === 'running'
    }

    /** Whether the user has explicitly started/resumed the current session. */
    isStarted(): boolean {
        return this.started
    }

    /**
     * Create a new {@link AgentSession} recording the Goal and associating the
     * Autonomy_Level + Step_Budget *before any Action* (Req 1.1, 1.3). Rejects
     * empty/whitespace Goals with no session created (Req 1.2, Property 25) and
     * surfaces `association-failed` when the association is invalid (Req 1.5).
     *
     * If a session already exists it is preserved via {@link SessionManagerHooks.onArchive}
     * before the new (empty-Trajectory) session replaces it (Req 18.4,
     * Property 23). The new session is *not* started — acting stays gated behind
     * an explicit {@link SessionManager.start} (Req 1.4, Property 22).
     */
    createSession(input: CreateSessionInput): CreateSessionResult {
        if (isBlankGoal(input.goal)) {
            return { ok: false, reason: 'empty-goal' }
        }

        const associated = this.validateAssociation(input.autonomy, input.stepBudget)
        if (associated === null) {
            return {
                ok: false,
                reason: 'association-failed',
                error: {
                    kind: 'association-failed',
                    message:
                        'Could not associate the autonomy level or step budget with the session.',
                    recoverable: true,
                    action: 'restart-session'
                }
            }
        }

        // Preserve the prior session before replacing it (Req 18.4, Property 23).
        const previous = this.session
        if (previous !== null) {
            void this.hooks.onArchive?.(clone(previous))
        }

        const timestamp = this.now()
        const session = buildSession(
            this.generateId(),
            input.goal.trim(),
            associated.autonomy,
            associated.stepBudget,
            timestamp
        )
        // Record the selected Execution_Environment (Req 22.3); defaults to local.
        session.environment = input.environment ?? 'local'

        this.session = session
        this.started = false
        void this.hooks.onSessionChanged?.(this.session)
        return { ok: true, session: clone(session) }
    }

    /**
     * Explicit user start of the current session (Req 1.4, 13.3). Opens the
     * acting gate and moves an idle/paused session to `running`. Returns false
     * when there is no session to start.
     */
    start(): boolean {
        if (this.session === null) return false
        this.started = true
        if (this.session.status === 'idle' || this.session.status === 'paused') {
            this.session.status = 'running'
            this.session.updatedAt = this.now()
        }
        void this.hooks.onSessionChanged?.(this.session)
        return true
    }

    /**
     * Explicit user resume of a paused/restored/loaded session (Req 10.4, 18.3,
     * 18.5). Semantically identical to {@link SessionManager.start} for the acting
     * gate: no further Action runs until this explicit action.
     */
    resume(): boolean {
        return this.start()
    }

    /** The next strictly-increasing, chronological Trajectory index (Req 14.2). */
    private nextIndex(): number {
        const trajectory = this.session?.trajectory ?? []
        if (trajectory.length === 0) return 0
        return trajectory[trajectory.length - 1].index + 1
    }

    /**
     * Append a Trajectory step to the end of the chronological record, minting
     * its strictly-increasing {@link TrajectoryStep.index} and the reasoning
     * step's id/timestamp. Appending only ever grows the list and never reorders
     * or deletes existing steps (Req 14.2, Property 19). Returns a clone of the
     * appended step so callers can emit it without aliasing state.
     *
     * @throws if no session exists.
     */
    appendStep(input: AppendStepInput): TrajectoryStep {
        const session = this.requireSession()
        const step: TrajectoryStep = {
            index: this.nextIndex(),
            observation: clone(input.observation),
            reasoning: {
                id: input.reasoning.id ?? this.generateId(),
                outcome: input.reasoning.outcome,
                rationale: input.reasoning.rationale,
                providerId: input.reasoning.providerId ?? null,
                createdAt: input.reasoning.createdAt ?? this.now()
            }
        }
        if (input.reasoning.model !== undefined) step.reasoning.model = input.reasoning.model
        if (input.reasoning.usage !== undefined) step.reasoning.usage = clone(input.reasoning.usage)
        if (input.action !== undefined) step.action = clone(input.action)
        if (input.result !== undefined) step.result = clone(input.result)
        if (input.events !== undefined && input.events.length > 0) {
            step.events = clone(input.events)
        }

        session.trajectory.push(step)
        session.updatedAt = step.reasoning.createdAt

        void this.hooks.onStepAppended?.(clone(step), session)
        void this.hooks.onSessionChanged?.(session)

        return clone(step)
    }

    /**
     * Attach a {@link SafetyEvent} (emergency-stop, declined, or blocked, with its
     * reason) to the most recent Trajectory step (Req 7.6, 14.5). Returns false
     * when there is no step to attach it to. The Trajectory itself is never
     * reordered — this only augments the last step's `events`.
     */
    recordSafetyEvent(event: Omit<SafetyEvent, 'at'> & { at?: string }): boolean {
        const session = this.session
        if (session === null || session.trajectory.length === 0) return false
        const last = session.trajectory[session.trajectory.length - 1]
        const full: SafetyEvent = {
            type: event.type,
            reason: event.reason,
            at: event.at ?? this.now()
        }
        last.events = last.events ? [...last.events, full] : [full]
        session.updatedAt = full.at
        void this.hooks.onSessionChanged?.(session)
        return true
    }

    /**
     * Replace the active session's running {@link TrajectorySummary}. Used by the
     * Summarizer to store a freshly folded summary. Cloned on the way in so the
     * caller cannot retain an alias; only the summary is swapped, so folding can
     * never reorder or drop Trajectory history (Property 19).
     */
    setSummary(summary: TrajectorySummary): void {
        const session = this.requireSession()
        session.summary = clone(summary)
        session.updatedAt = this.now()
        void this.hooks.onSessionChanged?.(session)
    }

    /**
     * Set the terminal status reflecting the ending condition (Req 6.5) and close
     * the acting gate. The complete Trajectory is retained for review after the
     * session ends (Req 14.4) — this method never touches it.
     */
    end(status: SessionStatus): void {
        const session = this.requireSession()
        session.status = status
        session.updatedAt = this.now()
        this.started = false
        void this.hooks.onSessionChanged?.(session)
    }

    /**
     * Record free-text user guidance (e.g. an answer to a question the agent
     * asked) so the next Reasoning_Step can act on it. No-op when no session.
     */
    addGuidance(text: string): void {
        const session = this.session
        if (session === null) return
        const trimmed = text.trim()
        if (trimmed.length === 0) return
        session.guidance = session.guidance ? [...session.guidance, trimmed] : [trimmed]
        session.updatedAt = this.now()
        void this.hooks.onSessionChanged?.(session)
    }

    /** Update the transient status (e.g. `paused`) without ending the session. */
    setStatus(status: SessionStatus): void {
        const session = this.requireSession()
        session.status = status
        session.updatedAt = this.now()
        void this.hooks.onSessionChanged?.(session)
    }

    /**
     * Adopt a session loaded from persistence on launch (Req 18.2) or from
     * history (Req 18.5). Acting stays gated behind an explicit
     * {@link SessionManager.start}/{@link SessionManager.resume} (Req 18.3, 18.5,
     * Property 22): a restored/loaded session takes no Action until the user acts.
     * Persistence seam; performs no I/O.
     */
    restore(session: AgentSession): void {
        this.session = session
        this.started = false
        void this.hooks.onSessionChanged?.(this.session)
    }

    /**
     * A cloned, renderer-facing {@link AgentSessionView} of the active session, or
     * null when none exists. Cloning guarantees the renderer cannot mutate the
     * manager's Trajectory or summary.
     */
    getSessionView(): AgentSessionView | null {
        return this.session === null ? null : toAgentSessionView(this.session)
    }

    /** The renderer-facing views of every recorded Trajectory step (Req 14.1). */
    getStepViews(): TrajectoryStepView[] {
        return (this.session?.trajectory ?? []).map(toTrajectoryStepView)
    }

    private requireSession(): AgentSession {
        if (this.session === null) {
            throw new Error('No active AgentSession; create or restore one first.')
        }
        return this.session
    }
}
