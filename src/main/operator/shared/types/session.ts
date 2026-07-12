/**
 * Goal + session models.
 *
 * The natural-language {@link Goal}, the ongoing {@link AgentSession} audit
 * container, the autonomy/status enums that govern it, and the renderer-facing
 * session views (Req 1, 6, 8, 14, 18).
 */

import type { Trajectory, TrajectorySummary, TrajectoryStepView, TokenUsage } from './trajectory'

/** Degree of independence granted to the agent for a session (Req 8). */
export type AutonomyLevel = 'manual' | 'supervised' | 'autonomous'

/**
 * The Execution_Environment a session runs against (Req 22): the local macOS
 * desktop or the sandboxed browser. Selected per session and fixed for its
 * duration (Req 22.2, 22.3, 22.8).
 */
export type EnvironmentId = 'local' | 'container-desktop' | 'browser'

/** Terminal + transient session states reflecting the ending condition (Req 6.5). */
export type SessionStatus =
    | 'idle'
    | 'running'
    | 'paused'
    | 'awaiting-help'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'budget-exhausted'

/** The natural-language task statement the user gives the agent (Req 1). */
export interface Goal {
    /** Non-empty task text (Req 1.2). */
    text: string
    createdAt: string
}

/** The ongoing, ordered record of one operator task (Req 1, 14, 18). */
export interface AgentSession {
    id: string
    goal: Goal
    /** Associated before any Action (Req 1.3). */
    autonomy: AutonomyLevel
    /** Associated before any Action (Req 1.3, 11.1). */
    stepBudget: number
    /** Append-only, chronological audit record (Req 14). */
    trajectory: Trajectory
    /** Bounded running context (Req 4). */
    summary: TrajectorySummary
    /** Reflects the ending condition (Req 6.5). */
    status: SessionStatus
    /** The Execution_Environment this session runs against (Req 22.3). Defaults to local. */
    environment?: EnvironmentId
    /**
     * Free-text guidance the user has given mid-session (e.g. answering a
     * question the agent asked). Folded into the reasoning context so the agent
     * acts on the user's answers as the task proceeds.
     */
    guidance?: string[]
    createdAt: string
    updatedAt: string
}

/** A renderer-facing view of an AgentSession (Req 18.2 restore, 18.5). */
export interface AgentSessionView {
    id: string
    goalText: string
    autonomy: AutonomyLevel
    stepBudget: number
    status: SessionStatus
    /** The Execution_Environment this session runs against (Req 22.3). */
    environment?: EnvironmentId
    trajectory: TrajectoryStepView[]
    summary: TrajectorySummary
    /** Summed token usage across every step of the session (observability). */
    usageTotal?: TokenUsage
    createdAt: string
    updatedAt: string
}

/** A compact session entry for the session list (Req 18). */
export interface SessionListItem {
    id: string
    goalText: string
    status: SessionStatus
    createdAt: string
    updatedAt: string
}
