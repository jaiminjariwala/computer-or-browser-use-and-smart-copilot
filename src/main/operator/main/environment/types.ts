import type { Action, ActionResult, EnvironmentId, Observation } from '@op-shared/types'
import type { CaptureOptions, PerceptionResult } from '../perception'
import type { ExecuteMeta } from '../executor'

/**
 * Execution Environment abstraction (Task 20 / Req 22).
 *
 * The single seam through which the Agent Loop drives BOTH Perception and Action
 * Execution. Before this abstraction the loop held a Perception Service and an
 * Action Executor as two separate collaborators; folding them behind one
 * interface is what lets the *same* loop, Safety Controller, autonomy gating,
 * Step_Budget, Trajectory, and Emergency_Stop drive either the real macOS
 * desktop ({@link import('./local-environment').LocalEnvironment}) or a
 * sandboxed browser — without the loop knowing which (Req 22.4, 22.5).
 *
 * The `capture`/`execute` signatures are intentionally identical to the loop's
 * existing `LoopPerception`/`LoopExecutor` surfaces, so an Environment can be
 * injected wherever those two were, with zero change to the state machine.
 */

/** Whether the environment can currently perceive/act (fail-closed when not). */
export interface EnvironmentHealth {
    available: boolean
    /** Human-readable reason when unavailable (surfaced to the user). */
    reason?: string
}

/**
 * The environment's coordinate space. Coordinate_Mapping resolves model
 * coordinates against THIS viewport rather than assuming the host display
 * (Req 25.1): the host display for the local backend, the browser viewport for
 * the sandbox backend.
 */
export interface EnvironmentViewport {
    width: number
    height: number
    scaleFactor: number
}

/** The one seam the Agent Loop drives Perception + Action Execution through. */
export interface Environment {
    /** Stable backend identity, recorded on the Agent_Session (Req 22.3). */
    readonly id: EnvironmentId | 'container-desktop'

    /**
     * Bring the backend up / tear it down. A no-op for the local desktop; boots
     * and kills the sandboxed browser context (Req 24.3). Safe to call more than
     * once.
     */
    start(): Promise<void>
    stop(): Promise<void>

    /** Produce an Observation of the current environment state (Req 22.6). */
    capture(options?: CaptureOptions): Promise<PerceptionResult>

    /** Perform one gate-approved Action_Space Action in this environment (Req 22.6). */
    execute(action: Action, observation: Observation, meta?: ExecuteMeta): Promise<ActionResult>

    /** The environment's coordinate space / viewport for Coordinate_Mapping (Req 25.1). */
    viewport(): EnvironmentViewport

    /**
     * Availability/health. An unhealthy environment must fail closed: the loop
     * produces no Observation and pauses (Req 22.7, 24.6).
     */
    health(): Promise<EnvironmentHealth>
}
