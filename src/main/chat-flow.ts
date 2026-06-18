import type {
    GlassError,
    SessionContext,
    TurnCapture,
    TurnView
} from '@shared/types'
import { GlassErrorException, gatewayFailedError } from './ai'

/**
 * Chat-flow orchestrator (design: "Flow A — User types a message").
 *
 * Owns the end-to-end orchestration that runs when a typed message arrives on
 * `chat:send`. It is deliberately Electron-free and dependency-injected so it
 * can be unit-tested without a window or a real gateway:
 *
 *   1. Append the user turn and emit it (`turn:appended`)        — Req 2.2/2.4.
 *   2. Build the derived `SessionContext` from the session       — Req 3.1.
 *   3. Emit `request:pending` true                                — Req 5.3.
 *   4. Call `AIClient.complete(ctx)` for the next-step guidance   — Req 5.1.
 *   5. Append the assistant turn and emit it (`turn:appended`)    — Req 5.2.
 *   6. Emit `request:pending` false (always, via `finally`)       — Req 5.3.
 *
 * On failure the session is never mutated beyond the already-appended user turn
 * (the AI client holds no session state), the typed {@link GlassError} is
 * surfaced via `error:show` (or `credentials:required` for a missing key), and
 * pending is cleared. Because pending is cleared in a `finally` and no lock or
 * sticky state is held, a follow-up `chat:send` always produces a fresh
 * response even when the prior guidance failed to display (Req 5.4, 7.3).
 */

/**
 * The slice of the Session Manager this flow needs. Declaring it narrowly keeps
 * the orchestrator decoupled from the concrete `SessionManager` and trivially
 * fakeable in tests. The real `SessionManager` satisfies this shape.
 */
export interface ChatFlowSession {
    /** Append a user text turn and return the created turn (Req 2.2). */
    appendUserText(text: string): TurnView
    /**
     * Append a user turn carrying a region capture (with optional accompanying
     * text) and return the created turn (Req 4.5; a text-less capture is
     * interpreted against the existing context per Req 3.3).
     */
    appendUserCapture(capture: TurnCapture, text?: string): TurnView
    /**
     * Append a user turn carrying several staged captures sent together (the
     * screenshot carousel), with optional accompanying text.
     */
    appendUserCaptures(captures: TurnCapture[], text?: string): TurnView
    /** Append an assistant guidance turn and return the created turn (Req 5.2). */
    appendAssistantText(text: string, status?: 'ok' | 'error'): TurnView
    /** Build the derived context (summary + recent turns + capture) (Req 3.1). */
    buildContext(currentCapture?: TurnCapture): SessionContext
    /** The id of the session a request is starting against (its origin chat). */
    activeSessionId?(): string
    /**
     * Deliver an assistant answer to the ORIGIN session id, wherever it now
     * lives: if that session is still active it appends + emits live; if the
     * user has since switched chats, it appends to the origin's persisted copy
     * so the answer is there when they return. Handles pending itself.
     */
    deliverAssistant?(sessionId: string, text: string): Promise<void>
}

/** The slice of the AI client this flow needs (design: "AIClient.complete"). */
export interface ChatFlowAI {
    /** Produce Next_Step_Guidance from the current session context (Req 5.1). */
    complete(ctx: SessionContext): Promise<string>
}

/**
 * Sink for the main -> sidebar events this flow emits. Injecting these (rather
 * than a window) keeps the orchestrator pure and lets tests assert on exact
 * ordering. The owning wiring binds these to the `emit*` helpers in `ipc.ts`.
 */
export interface ChatFlowEmitters {
    /** `turn:appended` — a turn was added to the conversation (Req 2.4, 5.2). */
    turnAppended: (turn: TurnView) => void
    /** `request:pending` — the in-progress state changed (Req 5.3). */
    pending: (pending: boolean) => void
    /** `error:show` — surface a user-facing failure (Req 2.3, 7.3). */
    error: (error: GlassError) => void
    /**
     * `credentials:required` — prompt the user to enter gateway credentials
     * (Req 7.4). Optional: when absent, a missing-credentials failure falls
     * back to `error:show` so it is never silently dropped.
     */
    credentialsRequired?: () => void
    /**
     * The gateway (and its configured fallback) failed. When wired, the context
     * is handed to a zero-config local fallback model that runs in the renderer;
     * it answers and reports back via `chat:fallback-result`, so the request
     * stays pending until then. When absent, the failure surfaces as an error.
     * `originId` is the session the request started in, so the fallback answer
     * lands in the right chat even if the user has since switched.
     */
    fallbackNeeded?: (ctx: SessionContext, originId: string) => void
}

export interface ChatFlowDeps {
    session: ChatFlowSession
    ai: ChatFlowAI
    emitters: ChatFlowEmitters
}

/**
 * Orchestrates Flow A. A single long-lived instance is created in the main
 * process and its {@link handleSendMessage} is wired to the `chat:send` IPC
 * handler. The same instance also owns Flow B's gateway half via
 * {@link handleCapture}, invoked once a region selection has been captured and
 * cropped.
 */
export class ChatFlow {
    private readonly session: ChatFlowSession
    private readonly ai: ChatFlowAI
    private readonly emitters: ChatFlowEmitters

    constructor(deps: ChatFlowDeps) {
        this.session = deps.session
        this.ai = deps.ai
        this.emitters = deps.emitters
    }

    /**
     * Handle a typed message submitted by the user (Flow A). Blank submissions
     * are ignored. The user turn is appended and emitted before the gateway
     * call so it renders immediately (Req 2.2); the assistant turn follows once
     * guidance returns (Req 5.2). Pending is toggled on before the call and off
     * afterward — always, even on failure — so no sticky/locked state can block
     * a follow-up message (Req 5.3, 5.4).
     */
    async handleSendMessage(text: string): Promise<void> {
        const trimmed = (text ?? '').trim()
        if (trimmed.length === 0) {
            // Nothing to send; do not append an empty turn or call the gateway.
            return
        }

        // 1. Append + emit the user turn so the sidebar shows it right away.
        const userTurn = this.session.appendUserText(trimmed)
        this.emitters.turnAppended(userTurn)

        // 2. Build context AFTER the user turn is recorded, so the request
        //    includes the just-typed message (Req 3.1). Capture the origin chat
        //    so a slow answer lands here even if the user switches chats.
        const originId = this.originId()
        const ctx = this.session.buildContext()

        // 3. Enter the in-progress state (Req 5.3).
        this.emitters.pending(true)
        try {
            // 4. Ask the gateway for the next step (Req 5.1).
            const guidance = await this.ai.complete(ctx)

            // 5. Deliver the answer to the origin chat (Req 5.2).
            await this.completeWith(guidance, originId)
        } catch (err) {
            // Gateway failed. When a local fallback is wired, hand it the context
            // (the renderer answers and reports back) and keep the request
            // pending; otherwise surface the typed error and clear pending.
            if (this.emitters.fallbackNeeded) {
                this.emitters.fallbackNeeded(ctx, originId)
                return
            }
            this.surfaceError(err)
            this.emitters.pending(false)
        }
    }

    /**
     * Handle a captured region submitted by the user (Flow B — design "Flow B —
     * Capture a region → next step"). Invoked once the overlay selection has
     * been captured + cropped into a {@link TurnCapture}; mirrors
     * {@link handleSendMessage} but the user turn carries the capture image
     * rather than text.
     *
     *   1. Append + emit the capture user turn so its thumbnail renders
     *      immediately (Req 2.5, 4.5).
     *   2. Build the `SessionContext` WITH the capture as `currentCapture`, so
     *      the image is sent alongside the running summary + recent turns — a
     *      text-less capture is interpreted against the existing session, never
     *      as a contextless screenshot (Req 3.1, 3.3, 5.1).
     *   3. Emit `request:pending` true (Req 5.3).
     *   4. Ask the gateway for the next step grounded in the image + context
     *      (Req 5.1).
     *   5. Append + emit the assistant next-step guidance turn (Req 5.2).
     *   6. Clear pending in `finally` (Req 5.3, 5.4).
     *
     * On failure the capture turn is retained (only it was appended, and the AI
     * client holds no session state); the typed {@link GlassError} is surfaced
     * via `error:show` so the user can retry without losing their capture
     * (Req 7.3, Property 6).
     *
     * Optional `text` lets a future caller attach an accompanying message; when
     * omitted the capture is interpreted purely against the session (Req 3.3).
     */
    async handleCapture(capture: TurnCapture, text?: string): Promise<void> {
        // 1. Append + emit the capture user turn so the thumbnail shows at once.
        const trimmed = text?.trim()
        const captureTurn = this.session.appendUserCapture(
            capture,
            trimmed && trimmed.length > 0 ? trimmed : undefined
        )
        this.emitters.turnAppended(captureTurn)

        // 2. Build context AFTER recording the capture turn and attach the
        //    capture as `currentCapture` so the image + session context go to
        //    the gateway together (Req 3.1, 3.3, 5.1). Capture the origin chat
        //    so a slow answer lands here even if the user switches chats.
        const originId = this.originId()
        const ctx = this.session.buildContext(capture)

        // 3. Enter the in-progress state (Req 5.3).
        this.emitters.pending(true)
        try {
            // 4. Ask the gateway for the next step grounded in image + context.
            const guidance = await this.ai.complete(ctx)

            // 5. Deliver the answer to the origin chat (Req 5.2).
            await this.completeWith(guidance, originId)
        } catch (err) {
            // Gateway failed: hand off to the local fallback when wired (keeps
            // the capture, keeps pending); otherwise surface the error.
            if (this.emitters.fallbackNeeded) {
                this.emitters.fallbackNeeded(ctx, originId)
                return
            }
            this.surfaceError(err)
            this.emitters.pending(false)
        }
    }

    /**
     * Handle several staged captures submitted together with optional text (the
     * screenshot carousel -> Send). Mirrors {@link handleCapture} but records a
     * single user turn carrying every image, so the gateway sees them as one
     * multimodal message alongside the running summary + recent turns.
     *
     * With no captures it degrades to a plain text send (or a no-op when the
     * text is also empty), so the caller never has to special-case an empty
     * carousel.
     */
    async handleCaptures(captures: TurnCapture[], text?: string): Promise<void> {
        if (!captures || captures.length === 0) {
            const trimmed = (text ?? '').trim()
            if (trimmed.length > 0) await this.handleSendMessage(trimmed)
            return
        }

        const trimmed = text?.trim()
        const captureTurn = this.session.appendUserCaptures(
            captures,
            trimmed && trimmed.length > 0 ? trimmed : undefined
        )
        this.emitters.turnAppended(captureTurn)

        // The captures live on the just-appended turn, so buildContext() (which
        // includes it in recentTurns) already carries every image to the gateway.
        const originId = this.originId()
        const ctx = this.session.buildContext()

        this.emitters.pending(true)
        try {
            const guidance = await this.ai.complete(ctx)
            await this.completeWith(guidance, originId)
        } catch (err) {
            if (this.emitters.fallbackNeeded) {
                this.emitters.fallbackNeeded(ctx, originId)
                return
            }
            this.surfaceError(err)
            this.emitters.pending(false)
        }
    }

    /** The origin session id for a request (empty when the manager can't say). */
    private originId(): string {
        return this.session.activeSessionId ? this.session.activeSessionId() : ''
    }

    /**
     * Deliver a successful answer. When the session-aware `deliverAssistant`
     * seam is wired (production), it routes the answer to the ORIGIN chat even
     * if the user has switched away; otherwise it falls back to the simple
     * append-to-active behavior (used by the pure unit tests).
     */
    private async completeWith(guidance: string, originId: string): Promise<void> {
        if (this.session.deliverAssistant && this.session.activeSessionId) {
            await this.session.deliverAssistant(originId, guidance)
            return
        }
        const assistantTurn = this.session.appendAssistantText(guidance)
        this.emitters.turnAppended(assistantTurn)
        this.emitters.pending(false)
    }

    /**
     * Map a thrown failure to a typed {@link GlassError} and surface it. A
     * missing-credentials failure is routed to `credentials:required` (Req 7.4)
     * when that emitter is available; everything else (and credentials-missing
     * without that emitter) is shown via `error:show` (Req 7.3). Untyped throws
     * are wrapped as a `gateway-failed` error.
     */
    private surfaceError(err: unknown): void {
        const glassError =
            err instanceof GlassErrorException ? err.glassError : gatewayFailedError(err)

        if (glassError.kind === 'credentials-missing' && this.emitters.credentialsRequired) {
            this.emitters.credentialsRequired()
            return
        }
        this.emitters.error(glassError)
    }
}
