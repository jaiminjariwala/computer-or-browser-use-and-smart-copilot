import { describe, it, expect, vi } from 'vitest'
import { CaptureService, type CaptureImage, type ImageSize } from './capture'
import { CaptureOrchestrator } from './capture-orchestrator'
import { ChatFlow, type ChatFlowEmitters } from './chat-flow'
import { SessionManager } from './session'
import { mapStatusToResult, type ScreenPermissionStatus } from './permissions'
import type { GlassError, Rect, SessionContext, TurnCapture, TurnView } from '@shared/types'

/**
 * Integration tests for the capture pipeline / Flow B (task 8.4).
 *
 * These wire together the REAL production seams — the permission gate, the
 * {@link CaptureService} crop pipeline, the {@link ChatFlow} gateway half, and
 * the {@link CaptureOrchestrator} that stitches them into the capture IPC
 * handlers — exactly as `index.ts` does, substituting fakes only for the
 * Electron-bound pieces (the screen image source, the overlay window, and the
 * gateway client).
 *
 * Three branches of design "Flow B — Capture a region → next step" are covered:
 *
 *   1. Granted: trigger → overlay shown → rect submitted → CaptureService crops
 *      the display → ChatFlow.handleCapture sends the cropped image + session
 *      context to the gateway, and the next-step guidance turn is appended.
 *   2. Cancel: trigger → overlay shown → cancel → overlay closed, NO capture.
 *   3. Permission denied: trigger → permission error surfaced → NO overlay, and
 *      the Capture Service is NEVER invoked (Property 7).
 *
 * Plus the revocation edge (Req 8.3): a capture that throws mid-flow closes the
 * overlay, surfaces the re-grant error, and appends no turn.
 *
 * Validates: Requirements 4.4, 4.6, 8.1 (Properties 4 & 7)
 */

// --- Fakes ------------------------------------------------------------------

/** Fake `NativeImage` recording crop/resize calls; mirrors capture.test.ts. */
function makeFakeImage(size: ImageSize): CaptureImage & { cropCalls: Rect[] } {
    const cropCalls: Rect[] = []
    const build = (current: ImageSize): CaptureImage => ({
        getSize: () => current,
        crop: (rect: Rect) => {
            cropCalls.push(rect)
            return build({ width: rect.width, height: rect.height })
        },
        resize: (options: { width?: number; height?: number }) =>
            build({
                width: options.width ?? current.width,
                height: options.height ?? current.height
            }),
        toDataURL: () => `data:image/png;base64,${current.width}x${current.height}`
    })
    return Object.assign(build(size), { cropCalls })
}

/** A fake overlay window (Window Manager surface) with show/close counters. */
function makeOverlay() {
    let shows = 0
    let closes = 0
    return {
        get shows() {
            return shows
        },
        get closes() {
            return closes
        },
        showOverlay: () => {
            shows++
        },
        closeOverlay: () => {
            closes++
        }
    }
}

/** A fake gateway client that records the contexts it was asked to complete. */
function makeRecordingAI(reply = 'Next: click Add permissions') {
    const contexts: SessionContext[] = []
    return {
        contexts,
        complete: (ctx: SessionContext): Promise<string> => {
            // Snapshot so later mutations cannot retroactively change assertions.
            contexts.push(JSON.parse(JSON.stringify(ctx)))
            return Promise.resolve(reply)
        }
    }
}

/** Deterministic session manager so ids/timestamps are predictable. */
function makeSession(): SessionManager {
    let n = 0
    let ms = Date.UTC(2024, 0, 1, 0, 0, 0)
    return new SessionManager({
        generateId: () => `id-${++n}`,
        now: () => {
            const iso = new Date(ms).toISOString()
            ms += 1000
            return iso
        }
    })
}

/** Collect every emitter event so ordering/branches can be asserted. */
function makeEmitters() {
    const turns: TurnView[] = []
    const pending: boolean[] = []
    const errors: GlassError[] = []
    const emitters: ChatFlowEmitters = {
        turnAppended: (t) => turns.push(t),
        pending: (p) => pending.push(p),
        error: (e) => errors.push(e)
    }
    return { emitters, turns, pending, errors }
}

interface HarnessOptions {
    status?: ScreenPermissionStatus
    /** Status returned on the post-failure re-check (Req 8.3). */
    recheckStatus?: ScreenPermissionStatus
    /** Display the capture service reports. */
    display?: { id: number; size: ImageSize }
    /** Force the capture to throw (simulating revocation mid-flow). */
    failCapture?: boolean
}

/**
 * Assemble the real Flow B pipeline (CaptureService + ChatFlow +
 * CaptureOrchestrator) with fakes for the Electron-bound collaborators, mirroring
 * the `index.ts` wiring.
 */
function makeHarness(options: HarnessOptions = {}) {
    const display = options.display ?? { id: 1, size: { width: 1440, height: 900 } }
    const screenImage = makeFakeImage(display.size)

    const captureService = new CaptureService({
        getActiveDisplay: () => display,
        getSources: options.failCapture
            ? async () => {
                throw new Error('Screen Recording permission revoked')
            }
            : async () => [{ display_id: String(display.id), thumbnail: screenImage }]
    })
    const captureSpy = vi.spyOn(captureService, 'captureRegion')

    const session = makeSession()
    const { emitters, turns, pending, errors } = makeEmitters()
    const ai = makeRecordingAI()
    const chatFlow = new ChatFlow({ session, ai, emitters })

    const overlay = makeOverlay()
    const orchestratorErrors: GlassError[] = []

    let firstCheck = true
    const checkPermission = (permOptions?: { previouslyGranted?: boolean }) => {
        // The first call is the pre-capture trigger check; a later call with
        // `previouslyGranted` is the post-failure revocation re-check (Req 8.3).
        if (permOptions?.previouslyGranted) {
            return mapStatusToResult(options.recheckStatus ?? 'denied', {
                previouslyGranted: true
            })
        }
        firstCheck = false
        return mapStatusToResult(options.status ?? 'granted')
    }
    void firstCheck

    // Captures are staged in the sidebar carousel rather than sent immediately;
    // the test drives the "Send" step by calling chatFlow.handleCaptures(staged).
    const staged: TurnCapture[] = []

    const orchestrator = new CaptureOrchestrator({
        checkPermission,
        captureService,
        overlay,
        stageCapture: (c) => staged.push(c),
        chatFlow,
        emitError: (e) => orchestratorErrors.push(e)
    })

    return {
        orchestrator,
        overlay,
        session,
        ai,
        chatFlow,
        staged,
        turns,
        pending,
        chatFlowErrors: errors,
        orchestratorErrors,
        captureSpy,
        screenImage
    }
}

// --- Branch 1: granted → overlay → rect → cropped image reaches the AI -------

describe('Flow B integration — granted capture reaches the gateway with context', () => {
    it('trigger → overlay → rect → staged → Send → cropped image + context → guidance', async () => {
        const h = makeHarness({ status: 'granted' })

        // Seed prior conversation so the capture is interpreted in context.
        h.session.appendUserText('I am stuck in the IAM console')

        // Trigger: permission granted → overlay shown (Req 4.1).
        h.orchestrator.handleTrigger()
        expect(h.overlay.shows).toBe(1)
        expect(h.orchestratorErrors).toHaveLength(0)

        // Selection completed: capture + crop + close overlay + STAGE (not send).
        await h.orchestrator.handleSubmitRegion({ x: 10, y: 20, width: 300, height: 200 })

        // Overlay was closed after the capture (Req 4.3).
        expect(h.overlay.closes).toBe(1)

        // The Capture Service cropped the display to the selected rect.
        expect(h.captureSpy).toHaveBeenCalledTimes(1)
        expect(h.screenImage.cropCalls).toEqual([
            { x: 10, y: 20, width: 300, height: 200 }
        ])

        // The capture was staged in the carousel, and the gateway was NOT yet
        // called (the user has not hit Send).
        expect(h.staged).toHaveLength(1)
        expect(h.staged[0].rect).toEqual({ x: 10, y: 20, width: 300, height: 200 })
        expect(h.ai.contexts).toHaveLength(0)

        // The user hits Send: the staged capture is submitted as one message.
        await h.chatFlow.handleCaptures(h.staged)

        // The gateway was called once. The image now rides on the last user
        // turn (via `captures`), alongside the running summary + recent turns.
        expect(h.ai.contexts).toHaveLength(1)
        const ctx = h.ai.contexts[0]
        expect(ctx.summary).toBeDefined()
        const lastRecent = ctx.recentTurns.at(-1)
        expect(lastRecent?.captures?.[0].dataUrl).toBe('data:image/png;base64,300x200')
        expect(lastRecent?.captures?.[0].rect).toEqual({ x: 10, y: 20, width: 300, height: 200 })
        const recentTexts = ctx.recentTurns.map((t) => t.text)
        expect(recentTexts).toContain('I am stuck in the IAM console')

        // The capture turn + the assistant guidance turn were appended in order.
        const roles = h.session.getSessionView().turns.map((t) => t.role)
        expect(roles).toEqual(['user', 'user', 'assistant'])
        const last = h.session.getSessionView().turns.at(-1)
        expect(last?.role).toBe('assistant')
        expect(last?.text).toBe('Next: click Add permissions')

        // The capture turn carries the thumbnail for the sidebar (Req 2.5, 4.5).
        const captureTurn = h.session.getSessionView().turns[1]
        expect(captureTurn.captures?.[0].rect).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    })

    it('a follow-up typed during capture sends straight to the gateway (no staging)', async () => {
        const h = makeHarness({ status: 'granted' })

        h.orchestrator.handleTrigger()
        // The user typed a question during the drag, so it sends immediately.
        await h.orchestrator.handleSubmitRegion({ x: 0, y: 0, width: 120, height: 90 }, 'what is this?')

        // Nothing was staged; the gateway was called once with the capture + text.
        expect(h.staged).toHaveLength(0)
        expect(h.ai.contexts).toHaveLength(1)
        expect(h.ai.contexts[0].currentCapture).toBeDefined()

        // The conversation holds the capture turn (with the question) + guidance.
        const turns = h.session.getSessionView().turns
        expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        expect(turns[0].text).toBe('what is this?')
        expect(turns[0].capture?.rect).toEqual({ x: 0, y: 0, width: 120, height: 90 })
    })
})

// --- Branch 2: cancel → overlay closed, NO capture --------------------------

describe('Flow B integration — cancel produces no capture (Req 4.4)', () => {
    it('trigger → overlay shown → cancel → overlay closed, no capture, no gateway call', () => {
        const h = makeHarness({ status: 'granted' })

        h.orchestrator.handleTrigger()
        expect(h.overlay.shows).toBe(1)

        h.orchestrator.handleCancel()

        expect(h.overlay.closes).toBe(1)
        // No capture produced and the gateway was never called (Req 4.4, 4.6).
        expect(h.captureSpy).not.toHaveBeenCalled()
        expect(h.ai.contexts).toHaveLength(0)
        // No capture/assistant turn was appended.
        expect(h.session.getSessionView().turns).toHaveLength(0)
    })
})

// --- Branch 3: permission denied → no overlay, error, NO capture (Property 7) -

describe('Flow B integration — permission denied surfaces error and never captures', () => {
    it.each(['denied', 'restricted', 'not-determined', 'unknown'] as const)(
        'status "%s": trigger surfaces a permission error, shows no overlay, never captures (Property 7, Req 8.1)',
        (status) => {
            const h = makeHarness({ status })

            h.orchestrator.handleTrigger()

            // No overlay (Req 8.1), a permission error surfaced, and the
            // Capture Service was NEVER invoked (Property 7).
            expect(h.overlay.shows).toBe(0)
            expect(h.orchestratorErrors).toHaveLength(1)
            expect(h.orchestratorErrors[0].kind).toBe('permission-missing')
            expect(h.orchestratorErrors[0].action).toBe('open-settings')
            expect(h.captureSpy).not.toHaveBeenCalled()
            expect(h.ai.contexts).toHaveLength(0)
        }
    )
})

// --- Edge: permission revoked mid-flow (Req 8.3) ----------------------------

describe('Flow B integration — revocation between trigger and selection (Req 8.3)', () => {
    it('a capture failure closes the overlay, surfaces the re-grant error, and appends no turn', async () => {
        const h = makeHarness({
            status: 'granted',
            failCapture: true,
            recheckStatus: 'denied'
        })

        // Permission was granted at trigger time → overlay shown.
        h.orchestrator.handleTrigger()
        expect(h.overlay.shows).toBe(1)

        // The selection completes but the capture throws (permission revoked).
        await h.orchestrator.handleSubmitRegion({ x: 0, y: 0, width: 100, height: 100 })

        // Overlay closed, re-grant instructions surfaced (Req 8.3), and NO
        // capture turn was produced (Req 4.4 semantics / Property 4).
        expect(h.overlay.closes).toBe(1)
        expect(h.orchestratorErrors).toHaveLength(1)
        expect(h.orchestratorErrors[0].kind).toBe('permission-revoked')
        expect(h.ai.contexts).toHaveLength(0)
        expect(h.session.getSessionView().turns).toHaveLength(0)
    })
})
