import type { A11yElement, Observation, OperatorError, Rect } from '@op-shared/types'
import {
    defaultGetActiveDisplay,
    defaultGetSources,
    type CaptureImage
} from './capture'
import {
    buildObservation,
    type CaptureMode,
    type DisplayInfo,
    type ImageSize
} from './observation'

/**
 * Perception Service (Task 7) — the Electron-aware shell over the pure
 * {@link buildObservation} pipeline.
 *
 * Evolved from the Click Copilot `capture.ts` pipeline vendored in Task 2 (reuse
 * rule Req 19: a one-time copy Click Operator now owns; it never imports from the
 * `click-copilot` project). Every failure path is fail-closed — it yields NO
 * Observation:
 *  - Capture ONLY while an Agent_Session is active (Req 2.5).
 *  - On capture failure produce no Observation and signal the loop to pause,
 *    surfacing `capture-failed` (Req 2.7).
 *  - Mark the Observation incomplete when bounds/scale are unknown so no
 *    coordinate-based Action can execute from it (Req 2.8).
 */

/** A successful capture carrying the produced Observation. */
export interface PerceptionSuccess {
    ok: true
    observation: Observation
}

/**
 * A capture that produced NO Observation. `reason` distinguishes a benign "no
 * active session" (nothing to do, do not pause) from a capture failure that must
 * pause the loop and be surfaced to the user (Req 2.5, 2.7).
 */
export interface PerceptionFailure {
    ok: false
    reason: 'session-inactive' | 'capture-failed'
    /** True only for capture failures: the loop must pause (Req 2.7). */
    pause: boolean
    /** The user-facing error for capture failures (Req 2.7). */
    error?: OperatorError
}

export type PerceptionResult = PerceptionSuccess | PerceptionFailure

/** Produces a unique id for an Observation. Injectable for tests. */
export type IdGenerator = () => string

/** Produces the current time as an ISO-8601 timestamp. Injectable for tests. */
export type Clock = () => string

/** Options for a single capture request. */
export interface CaptureOptions {
    /** Full-screen (default) or active-window (Req 2.2, 2.3). */
    mode?: CaptureMode
    /** Attach accessibility-tree elements when available (Req 2.6). */
    includeA11y?: boolean
}

/** Injectable seams so the service runs headlessly without real Electron APIs. */
export interface PerceptionServiceDeps {
    /**
     * Whether an Agent_Session is currently active. Capture produces an
     * Observation ONLY while this returns true (Req 2.5). Required.
     */
    isSessionActive: () => boolean
    /**
     * Resolve the display being captured. Defaults to the display nearest the
     * cursor, falling back to the primary display.
     */
    getActiveDisplay?: () => DisplayInfo
    /**
     * Fetch the available screen sources. Defaults to
     * `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`.
     */
    getSources?: (
        thumbnailSize: ImageSize
    ) => Promise<Array<{ display_id: string; thumbnail: CaptureImage }>>
    /** Resolve the active-window rectangle (image pixels) for active-window mode. */
    getActiveWindowRect?: () => Rect | undefined
    /** Resolve accessibility-tree elements when `includeA11y` is requested. */
    getA11yElements?: () => A11yElement[] | undefined
    /** Id factory for Observations. Defaults to a unique generator. */
    generateId?: IdGenerator
    /** Clock for `capturedAt`. Defaults to `new Date().toISOString()`. */
    now?: Clock
}

let observationCounter = 0
/** Default unique id generator for Observations. */
function defaultGenerateId(): string {
    observationCounter += 1
    return `obs_${Date.now().toString(36)}_${observationCounter.toString(36)}`
}

/** Build the fail-closed capture error surfaced to the user (Req 2.7). */
function captureFailed(message: string): PerceptionFailure {
    const error: OperatorError = {
        kind: 'capture-failed',
        message,
        recoverable: true,
        action: 'retry'
    }
    return { ok: false, reason: 'capture-failed', pause: true, error }
}

/**
 * The Perception Service. Captures the active display at its logical resolution
 * so image pixels map 1:1 onto logical points, then assembles the Observation
 * with mapping metadata. Every failure path is fail-closed: it yields NO
 * Observation.
 */
export class PerceptionService {
    private readonly isSessionActive: () => boolean
    private readonly getActiveDisplay: () => DisplayInfo
    private readonly getSources: (
        thumbnailSize: ImageSize
    ) => Promise<Array<{ display_id: string; thumbnail: CaptureImage }>>
    private readonly getActiveWindowRect?: () => Rect | undefined
    private readonly getA11yElements?: () => A11yElement[] | undefined
    private readonly generateId: IdGenerator
    private readonly now: Clock

    constructor(deps: PerceptionServiceDeps) {
        this.isSessionActive = deps.isSessionActive
        this.getActiveDisplay = deps.getActiveDisplay ?? defaultGetActiveDisplay
        this.getSources = deps.getSources ?? defaultGetSources
        this.getActiveWindowRect = deps.getActiveWindowRect
        this.getA11yElements = deps.getA11yElements
        this.generateId = deps.generateId ?? defaultGenerateId
        this.now = deps.now ?? (() => new Date().toISOString())
    }

    /**
     * Produce an Observation of the current screen state, or a fail-closed result
     * carrying no Observation.
     *
     *  - Returns `session-inactive` (no Observation, no pause) when no session is
     *    active — capture is session-scoped (Req 2.5).
     *  - Returns `capture-failed` (no Observation, pause) on any capture error
     *    (Req 2.7).
     *  - Otherwise returns the assembled Observation, marked incomplete when the
     *    display bounds or scale factor are unknown (Req 2.8).
     */
    async capture(options: CaptureOptions = {}): Promise<PerceptionResult> {
        // Session-scoped: never capture outside an active session (Req 2.5).
        if (!this.isSessionActive()) {
            return { ok: false, reason: 'session-inactive', pause: false }
        }

        let display: DisplayInfo
        let image: CaptureImage
        try {
            display = this.getActiveDisplay()
            const sources = await this.getSources(display.size)
            if (!sources || sources.length === 0) {
                throw new Error('No screen source available for capture')
            }
            const source =
                sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
            if (!source || !source.thumbnail) {
                throw new Error('Screen source has no image')
            }
            image = source.thumbnail
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            return captureFailed(`Screen capture failed: ${detail}`)
        }

        const mode: CaptureMode = options.mode ?? 'full-screen'
        const activeWindowRect =
            mode === 'active-window' ? this.getActiveWindowRect?.() : undefined
        const a11yElements = options.includeA11y ? this.getA11yElements?.() : undefined

        try {
            const observation = buildObservation(
                { image, display, mode, activeWindowRect, a11yElements },
                this.generateId(),
                this.now()
            )
            return { ok: true, observation }
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            return captureFailed(`Screen capture failed: ${detail}`)
        }
    }
}
