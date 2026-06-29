import type { Action, ActionResult, Observation, PermissionSnapshot } from '@op-shared/types'
import type { CaptureOptions, PerceptionResult, PerceptionService } from '../perception'
import { defaultGetActiveDisplay } from '../perception/capture'
import type { DisplayInfo } from '../perception/observation'
import type { ActionExecutor, ExecuteMeta } from '../executor'
import type { Environment, EnvironmentHealth, EnvironmentViewport } from './types'

/**
 * LocalEnvironment (Task 20.2 / Req 23) — the macOS desktop backend.
 *
 * The pre-existing behavior, now expressed as one {@link Environment}: it
 * perceives via the {@link PerceptionService} (`desktopCapturer`) and acts via
 * the native/`cliclick` {@link ActionExecutor}, reporting the host display as
 * its coordinate space and folding the macOS Screen Recording + Accessibility
 * permissions into {@link health}. All prior behavior is preserved verbatim —
 * this is a wrapper, not a rewrite.
 */

export interface LocalEnvironmentDeps {
    /** The perception service that captures the host screen. */
    perception: PerceptionService
    /** The action executor that synthesizes real OS input events. */
    executor: ActionExecutor
    /**
     * The live macOS permission snapshot. Screen Recording + Accessibility are
     * required ONLY for this environment (Req 23.2); missing/revoked permission
     * makes the environment unhealthy so the loop fails closed.
     */
    getPermissions: () => PermissionSnapshot
    /** Resolve the active display for {@link viewport}. Injectable for tests. */
    getActiveDisplay?: () => DisplayInfo
}

export class LocalEnvironment implements Environment {
    readonly id = 'local' as const

    private readonly perception: PerceptionService
    private readonly executor: ActionExecutor
    private readonly getPermissions: () => PermissionSnapshot
    private readonly getActiveDisplay: () => DisplayInfo

    constructor(deps: LocalEnvironmentDeps) {
        this.perception = deps.perception
        this.executor = deps.executor
        this.getPermissions = deps.getPermissions
        this.getActiveDisplay = deps.getActiveDisplay ?? defaultGetActiveDisplay
    }

    /** The local desktop is always "up"; nothing to boot or tear down. */
    async start(): Promise<void> {
        /* no-op */
    }
    async stop(): Promise<void> {
        /* no-op */
    }

    capture(options?: CaptureOptions): Promise<PerceptionResult> {
        return this.perception.capture(options)
    }

    execute(action: Action, observation: Observation, meta?: ExecuteMeta): Promise<ActionResult> {
        return this.executor.execute(action, observation, meta)
    }

    /** The host display bounds/scale are the local coordinate space (Req 23.3, 25.1). */
    viewport(): EnvironmentViewport {
        const display = this.getActiveDisplay()
        return {
            width: display.size.width,
            height: display.size.height,
            // scaleFactor is optional on DisplayInfo (unknown on some displays);
            // default to 1 so the viewport is always fully specified.
            scaleFactor: display.scaleFactor ?? 1
        }
    }

    /**
     * Healthy only when BOTH macOS permissions are granted (Req 23.2). A missing
     * or revoked permission makes the environment unavailable so the loop
     * produces no Observation and pauses, consistent with the fail-closed gate.
     */
    async health(): Promise<EnvironmentHealth> {
        const perms = this.getPermissions()
        const missing: string[] = []
        if (perms.screenRecording !== 'granted') missing.push('Screen Recording')
        if (perms.accessibility !== 'granted') missing.push('Accessibility')
        if (missing.length > 0) {
            return {
                available: false,
                reason: `Missing macOS permission(s): ${missing.join(' + ')}.`
            }
        }
        return { available: true }
    }
}
