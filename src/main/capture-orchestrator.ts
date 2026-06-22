import type { GlassError, Rect, TurnCapture } from '@shared/types'
import type { PermissionCheckOptions, PermissionCheckResult } from './permissions'
import { decideCaptureTrigger } from './capture-trigger'

/**
 * Capture orchestrator (design: "Flow B — Capture a region → next step").
 *
 * Coordinates the three capture IPC handlers — `capture:trigger`,
 * `capture:region`, and `capture:cancel` — by stitching together the existing
 * seams (the permission gate {@link decideCaptureTrigger}, the Capture Service,
 * the Window Manager's overlay, and the {@link ChatFlow} gateway half) without
 * importing Electron. Pulling this wiring out of `index.ts` keeps it free of the
 * `app`/`BrowserWindow` module-load side effects so the capture pipeline can be
 * exercised end-to-end in tests (task 8.4) through the real production logic.
 *
 * Behavioral contract (unchanged from the prior inline `index.ts` wiring):
 *
 *  - `capture:trigger` checks Screen_Recording_Permission FIRST. Granted shows
 *    the full-screen overlay (Req 4.1); anything else skips the overlay and
 *    surfaces the System Settings instructions as a `GlassError` (Req 8.1).
 *    Crucially, NO capture is produced and the Capture Service is never invoked
 *    when permission is not granted (Property 7, Req 8.1).
 *  - `capture:region` (a completed selection) captures the active display, crops
 *    it to the rectangle, closes the overlay, and hands the capture to the chat
 *    flow which sends image + Session_Context to the gateway (Req 4.3, 4.5,
 *    5.1). If the capture throws (e.g. permission was revoked between the
 *    trigger check and the selection completing — Req 8.3), the overlay is
 *    closed, permission is re-checked, the re-grant instructions are surfaced,
 *    and NO capture turn is produced (Req 4.4 semantics / Property 4).
 *  - `capture:cancel` closes the overlay and produces no capture (Req 4.4).
 *
 * Requirements: 4.1, 4.3, 4.4, 4.6, 8.1, 8.3
 */

/** The Capture Service surface the orchestrator depends on. */
export interface CaptureOrchestratorCaptureService {
    captureRegion(rect: Rect): Promise<TurnCapture>
}

/** The overlay window surface the orchestrator depends on (Window Manager). */
export interface CaptureOrchestratorOverlay {
    showOverlay(): void
    closeOverlay(): void
}

/** The chat-flow surface the orchestrator depends on (send-to-gateway half). */
export interface CaptureOrchestratorChatFlow {
    handleCapture(capture: TurnCapture, text?: string): Promise<void>
}

/** Injectable collaborators so the orchestrator can be tested without Electron. */
export interface CaptureOrchestratorDeps {
    /** Read the current screen-recording permission flow (Permission Service). */
    checkPermission: (options?: PermissionCheckOptions) => PermissionCheckResult
    /** Capture + crop the active display (Capture Service). */
    captureService: CaptureOrchestratorCaptureService
    /** Show/close the transparent capture overlay (Window Manager). */
    overlay: CaptureOrchestratorOverlay
    /**
     * Stage the freshly captured region in the sidebar's screenshot carousel
     * (`capture:staged`). Used when the user drew a region but typed NO
     * follow-up during capture, so they can stack more shots before sending.
     */
    stageCapture: (capture: TurnCapture) => void
    /**
     * Send the capture straight to the gateway (Flow B). Used when the user DID
     * type a follow-up during the drag, so the screenshot + text go to the chat
     * and the AI runs immediately.
     */
    chatFlow: CaptureOrchestratorChatFlow
    /** Surface a typed failure to the sidebar (`error:show`). */
    emitError: (error: GlassError) => void
}

/**
 * Orchestrates the capture IPC handlers. A single long-lived instance is
 * created in the main process; its methods are wired to the `capture:trigger`,
 * `capture:region`, and `capture:cancel` handlers in `index.ts`.
 */
export class CaptureOrchestrator {
    private readonly deps: CaptureOrchestratorDeps

    constructor(deps: CaptureOrchestratorDeps) {
        this.deps = deps
    }

    /**
     * Handle `capture:trigger`. Checks permission first: granted shows the
     * overlay (Req 4.1); otherwise surfaces the permission error and shows no
     * overlay and produces no capture (Req 8.1, Property 7).
     */
    handleTrigger(): void {
        const decision = decideCaptureTrigger(this.deps.checkPermission())
        if (decision.kind === 'show-overlay') {
            this.deps.overlay.showOverlay()
        } else {
            this.deps.emitError(decision.error)
        }
    }

    /**
     * Handle `capture:region` (a completed selection). Captures + crops the
     * active display, closes the overlay, then routes on the follow-up text the
     * user typed during the drag (Req 4.3, 4.5):
     *
     *  - text present  -> send the screenshot + text straight to the gateway so
     *    the AI answers immediately (the fast "capture and ask" path).
     *  - text empty     -> stage the screenshot in the composer's carousel so the
     *    user can add more shots or type later before sending.
     *
     * On failure (e.g. permission revoked mid-flow — Req 8.3) the overlay is
     * closed, permission re-checked, the re-grant instructions surfaced, and no
     * capture is produced.
     */
    async handleSubmitRegion(rect: Rect, text?: string): Promise<void> {
        // Close the overlay FIRST and let the screen repaint, so the capture
        // does not include the overlay's dim/selection tint. Then capture the
        // clean screen and route it.
        this.deps.overlay.closeOverlay()
        await new Promise((resolve) => setTimeout(resolve, 250))
        try {
            const capture = await this.deps.captureService.captureRegion(rect)
            const trimmed = text?.trim()
            if (trimmed && trimmed.length > 0) {
                // The user asked something during capture: send it now.
                await this.deps.chatFlow.handleCapture(capture, trimmed)
            } else {
                // No question yet: park it in the carousel above the input.
                this.deps.stageCapture(capture)
            }
        } catch {
            const recheck = this.deps.checkPermission({ previouslyGranted: true })
            if (!recheck.granted && recheck.error) {
                this.deps.emitError(recheck.error)
            }
        }
    }

    /** Handle `capture:cancel`. Closes the overlay; produces no capture (Req 4.4). */
    handleCancel(): void {
        this.deps.overlay.closeOverlay()
    }
}
