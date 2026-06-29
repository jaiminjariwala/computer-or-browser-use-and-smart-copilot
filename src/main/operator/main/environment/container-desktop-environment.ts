import { execFile } from 'node:child_process'
import type { Action, ActionResult, Observation, OperatorError } from '@op-shared/types'
import type { CaptureOptions, PerceptionResult } from '../perception'
import { preflightAction } from '../validate'
import type { Environment, EnvironmentHealth, EnvironmentViewport } from './types'

/**
 * ContainerDesktopEnvironment — the full virtual desktop backend.
 *
 * Runs the `docker/` image as a container: a sandboxed Linux desktop (Xvfb +
 * fluxbox + Firefox) the agent operates via an in-container control server
 * (`/screenshot` + `/action` → xdotool/scrot), with a live noVNC view the user
 * watches ({@link novncUrl}). It implements the same {@link Environment} seam as
 * the other backends, so the agent loop, Safety Controller, autonomy gating,
 * Step_Budget, and Emergency_Stop are unchanged (Req 22). It needs no macOS
 * permissions and never touches the host desktop.
 *
 * All Docker/HTTP effects are injectable so this is unit-testable without a real
 * engine.
 */

/** A docker CLI invocation returning stdout. Injectable for tests. */
export type DockerRun = (args: string[]) => Promise<string>

export interface ContainerDesktopEnvironmentDeps {
    /** Image tag to run. Defaults to `click-operator-desktop:latest`. */
    image?: string
    /** Container name. Defaults to `click-operator-desktop`. */
    containerName?: string
    /** Desktop resolution / coordinate space. Defaults to 1280×800. */
    viewport?: { width: number; height: number }
    /** Host loopback the container ports bind to. Defaults to 127.0.0.1. */
    host?: string
    /** Host port mapped to the in-container control server (5000). Defaults to 5000. */
    controlPort?: number
    /** Host port mapped to noVNC (6080). Defaults to 6080. */
    novncPort?: number
    /** Run the docker CLI. Defaults to `execFile('docker', args)`. */
    docker?: DockerRun
    /** HTTP transport. Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch
    /** Max time to wait for the control server to become healthy. Defaults to 60s. */
    readyTimeoutMs?: number
    /** Id factory for Observations (test seam). */
    generateId?: () => string
    /** Clock for `capturedAt` (test seam). */
    now?: () => string
}

let containerObsCounter = 0
function defaultGenerateId(): string {
    containerObsCounter += 1
    return `cdt_${Date.now().toString(36)}_${containerObsCounter.toString(36)}`
}

/** Default docker runner: `docker <args>` capturing stdout. */
const defaultDocker: DockerRun = (args) =>
    new Promise((resolve, reject) => {
        execFile('docker', args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr?.toString().trim() || err.message))
            else resolve(stdout.toString())
        })
    })

export class ContainerDesktopEnvironment implements Environment {
    readonly id = 'container-desktop' as const

    private readonly image: string
    private readonly containerName: string
    private readonly vp: { width: number; height: number }
    private readonly host: string
    private readonly controlPort: number
    private readonly novncPort: number
    private readonly docker: DockerRun
    private readonly fetchImpl: typeof fetch
    private readonly readyTimeoutMs: number
    private readonly generateId: () => string
    private readonly now: () => string

    private running = false

    constructor(deps: ContainerDesktopEnvironmentDeps = {}) {
        this.image = deps.image ?? 'click-operator-desktop:latest'
        this.containerName = deps.containerName ?? 'click-operator-desktop'
        this.vp = deps.viewport ?? { width: 1280, height: 800 }
        this.host = deps.host ?? '127.0.0.1'
        this.controlPort = deps.controlPort ?? 5000
        this.novncPort = deps.novncPort ?? 6080
        this.docker = deps.docker ?? defaultDocker
        this.fetchImpl = deps.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch)
        this.readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
        this.generateId = deps.generateId ?? defaultGenerateId
        this.now = deps.now ?? (() => new Date().toISOString())
    }

    private get controlBase(): string {
        return `http://${this.host}:${this.controlPort}`
    }

    /** The URL of the live noVNC desktop view, for embedding in the Console. */
    novncUrl(): string {
        return `http://${this.host}:${this.novncPort}/vnc.html?autoconnect=1&resize=scale`
    }

    /**
     * Launch the desktop container and wait until its control server is healthy
     * (Req 24.3 analogue). Removes any stale container of the same name first.
     */
    async start(): Promise<void> {
        if (this.running) return
        await this.docker(['rm', '-f', this.containerName]).catch(() => undefined)
        await this.docker([
            'run',
            '-d',
            '--rm',
            '--name',
            this.containerName,
            '-p',
            `${this.host}:${this.controlPort}:5000`,
            '-p',
            `${this.host}:${this.novncPort}:6080`,
            '-e',
            `SCREEN_WIDTH=${this.vp.width}`,
            '-e',
            `SCREEN_HEIGHT=${this.vp.height}`,
            this.image
        ])
        await this.waitForHealthy()
        this.running = true
    }

    /** Stop and remove the container. Safe to call when already stopped. */
    async stop(): Promise<void> {
        this.running = false
        await this.docker(['rm', '-f', this.containerName]).catch(() => undefined)
    }

    /** The desktop resolution is the coordinate space for Coordinate_Mapping (Req 25.1). */
    viewport(): EnvironmentViewport {
        return { width: this.vp.width, height: this.vp.height, scaleFactor: 1 }
    }

    /** Healthy when the in-container control server answers `/health`. */
    async health(): Promise<EnvironmentHealth> {
        try {
            const resp = await this.fetchImpl(`${this.controlBase}/health`)
            if (resp.ok) return { available: true }
            return { available: false, reason: `control server returned ${resp.status}` }
        } catch (err) {
            return {
                available: false,
                reason: `virtual desktop not reachable: ${err instanceof Error ? err.message : String(err)
                    }`
            }
        }
    }

    /** Screenshot the desktop via the control server (Req 24.1). Fails closed. */
    async capture(_options?: CaptureOptions): Promise<PerceptionResult> {
        void _options
        try {
            const resp = await this.fetchImpl(`${this.controlBase}/screenshot`)
            if (!resp.ok) return this.captureFailed(`screenshot returned ${resp.status}`)
            const bytes = Buffer.from(await resp.arrayBuffer())
            const observation: Observation = {
                id: this.generateId(),
                screenshotDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
                imageWidth: this.vp.width,
                imageHeight: this.vp.height,
                displayId: 0,
                displayBounds: { x: 0, y: 0, width: this.vp.width, height: this.vp.height },
                scaleFactor: 1,
                complete: true,
                capturedAt: this.now()
            }
            // Hybrid perception: attach the page's interactive elements (screen
            // coords) so the model can be guided by structured text, not just the
            // image. Best-effort: a DOM read failure never fails the capture.
            const elements = await this.fetchDomElements()
            if (elements.length > 0) observation.a11yElements = elements
            return { ok: true, observation }
        } catch (err) {
            return this.captureFailed(
                `virtual desktop capture failed: ${err instanceof Error ? err.message : String(err)}`
            )
        }
    }

    /** Fetch interactive DOM elements (screen coords) for hybrid perception. */
    private async fetchDomElements(): Promise<
        Array<{ role: string; title: string; bounds: { x: number; y: number; width: number; height: number } }>
    > {
        try {
            const resp = await this.fetchImpl(`${this.controlBase}/dom`)
            if (!resp.ok) return []
            const body = (await resp.json()) as {
                elements?: Array<{ text: string; x: number; y: number; w: number; h: number }>
            }
            return (body.elements ?? []).map((e) => ({
                role: 'element',
                title: e.text,
                // Store the top-left so the element's center is (x, y) again.
                bounds: { x: e.x - e.w / 2, y: e.y - e.h / 2, width: e.w, height: e.h }
            }))
        } catch {
            return []
        }
    }

    /**
     * Validate + map the Action (identity mapping — displayBounds equals the
     * desktop), then POST it to the control server which realizes it via xdotool
     * (Req 25.3, 25.4). Records an ActionResult for every attempt; never throws.
     */
    async execute(
        rawAction: Action,
        observation: Observation,
        meta: { highRisk?: boolean; confirmed?: boolean } = {}
    ): Promise<ActionResult> {
        const executedAt = this.now()
        const base = { highRisk: meta.highRisk ?? false, confirmed: meta.confirmed, executedAt }

        const pre = preflightAction(rawAction, observation)
        if (!pre.ok) {
            const status: ActionResult['status'] = pre.stage === 'validation' ? 'rejected' : 'failure'
            return { status, reason: pre.detail, ...base }
        }

        try {
            const resp = await this.fetchImpl(`${this.controlBase}/action`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(pre.action)
            })
            if (!resp.ok) {
                const detail = await resp.text().catch(() => `${resp.status}`)
                return { status: 'failure', reason: detail.slice(0, 300), ...base }
            }
            return { status: 'success', ...base }
        } catch (err) {
            return {
                status: 'failure',
                reason: err instanceof Error ? err.message : String(err),
                ...base
            }
        }
    }

    /** Poll the control server until healthy or the ready timeout elapses. */
    private async waitForHealthy(): Promise<void> {
        const deadline = Date.now() + this.readyTimeoutMs
        for (; ;) {
            const h = await this.health()
            if (h.available) return
            if (Date.now() >= deadline) {
                throw new Error('virtual desktop did not become ready before timeout')
            }
            await new Promise((r) => setTimeout(r, 500))
        }
    }

    private captureFailed(message: string): PerceptionResult {
        const error: OperatorError = {
            kind: 'capture-failed',
            message,
            recoverable: true,
            action: 'retry'
        }
        return { ok: false, reason: 'capture-failed', pause: true, error }
    }
}
