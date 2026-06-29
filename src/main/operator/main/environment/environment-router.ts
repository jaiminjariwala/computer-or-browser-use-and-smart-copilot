import type { Action, ActionResult, EnvironmentId, Observation } from '@op-shared/types'
import type { CaptureOptions, PerceptionResult } from '../perception'
import type { ExecuteMeta } from '../executor'
import type { Environment, EnvironmentHealth, EnvironmentViewport } from './types'

/**
 * EnvironmentRouter (Task 23 / Req 22).
 *
 * The Agent Loop is constructed ONCE with a single Environment; to let the user
 * pick the backend per session (Req 22.2) without rebuilding the loop, the loop
 * holds this router. It implements {@link Environment} and forwards every call
 * to whichever backend is currently active. Switching backends
 * ({@link selectEnvironment}) stops the previous one and starts the next, and is
 * refused while a session is mid-run so the environment is fixed for a session's
 * duration (Req 22.8) — the caller (start gate) only ever switches before
 * `loop.start()`.
 */
export class EnvironmentRouter implements Environment {
    private activeId: EnvironmentId
    private readonly backends: Record<EnvironmentId, Environment>

    constructor(backends: Record<EnvironmentId, Environment>, initial: EnvironmentId = 'local') {
        this.backends = backends
        this.activeId = initial
    }

    /** The active backend's id (drives the gate's environment-aware permission check). */
    get id(): EnvironmentId {
        return this.activeId
    }

    private get active(): Environment {
        return this.backends[this.activeId]
    }

    /**
     * Switch the active backend before a run starts. Stops the outgoing backend
     * and starts the incoming one so the sandbox browser boots exactly when
     * selected and is torn down otherwise.
     */
    async selectEnvironment(id: EnvironmentId): Promise<void> {
        if (id === this.activeId) {
            await this.active.start()
            return
        }
        await this.backends[this.activeId].stop()
        this.activeId = id
        await this.backends[id].start()
    }

    start(): Promise<void> {
        return this.active.start()
    }
    stop(): Promise<void> {
        return this.active.stop()
    }
    capture(options?: CaptureOptions): Promise<PerceptionResult> {
        return this.active.capture(options)
    }
    execute(action: Action, observation: Observation, meta?: ExecuteMeta): Promise<ActionResult> {
        return this.active.execute(action, observation, meta)
    }
    viewport(): EnvironmentViewport {
        return this.active.viewport()
    }
    health(): Promise<EnvironmentHealth> {
        return this.active.health()
    }
}
