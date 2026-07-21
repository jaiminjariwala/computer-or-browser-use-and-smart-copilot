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
     * Every provider in the chain failed (or none is configured). When wired,
     * the owner decides what the user sees — e.g. an in-chat setup card on a
     * fresh install, or an error turn in the origin chat — and settles the
     * request via {@link ChatFlow.settleRequest} when done. When absent, the
     * failure surfaces as an error banner and settles immediately. `originId`
     * is the session the request started in; `requestId` is the asking user
     * turn's id.
     */
    providersExhausted?: (ctx: SessionContext, originId: string, requestId: string) => void
    /**
     * `request:started` — a question began processing. `requestId` is the id of
     * the user turn that asked it, so the UI can show a per-question thinking
     * indicator (and a cancel affordance) next to that exact message.
     */
    requestStarted?: (requestId: string) => void
    /** `request:settled` — that question finished (answered, failed, or cancelled). */
    requestSettled?: (requestId: string) => void
}

/** Persistent user memory seam (optional; absent = feature off). */
export interface ChatFlowMemories {
    /** Memory texts to fold into request context (oldest first). */
    list: () => Promise<string[]>
    /** Deterministically capture a "remember ..." command from a message. */
    captureFromMessage: (text: string) => Promise<void>
}

export interface ChatFlowDeps {
    session: ChatFlowSession
    ai: ChatFlowAI
    emitters: ChatFlowEmitters
    memories?: ChatFlowMemories
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
    private readonly memories?: ChatFlowMemories
    /**
     * Questions currently being processed, keyed by the asking user turn's id.
     * Several may be in flight at once: asking a new question NEVER supersedes
     * an earlier one — each request runs to completion and delivers its own
     * answer. `pending` is on while ANY request is in flight.
     */
    private readonly inFlight = new Map<string, string>()
    /** Requests the user cancelled; their late answers are dropped on arrival. */
    private readonly cancelled = new Set<string>()

    constructor(deps: ChatFlowDeps) {
        this.session = deps.session
        this.ai = deps.ai
        this.emitters = deps.emitters
        this.memories = deps.memories
    }

    /**
     * The session context enriched with persistent memory. Memory read
     * failures degrade to a memory-less request — never a blocked chat.
     */
    private async contextWithMemories(): Promise<SessionContext> {
        const ctx = this.session.buildContext()
        if (!this.memories) return ctx
        const memories = await this.memories.list().catch(() => [])
        return memories.length > 0 ? { ...ctx, memories } : ctx
    }

    /** Begin tracking a question; first in-flight request turns pending on. */
    private begin(requestId: string, originId: string): void {
        if (this.inFlight.size === 0) this.emitters.pending(true)
        this.inFlight.set(requestId, originId)
        this.emitters.requestStarted?.(requestId)
    }

    /** Stop tracking a question; last one out turns pending off. */
    private finish(requestId: string): void {
        if (!this.inFlight.delete(requestId)) return
        this.emitters.requestSettled?.(requestId)
        if (this.inFlight.size === 0) this.emitters.pending(false)
    }

    /**
     * Cancel a still-thinking question (by its user-turn id). The underlying
     * provider call keeps running, but its answer is discarded on arrival and
     * the question's thinking state clears immediately.
     */
    cancelRequest(requestId: string): void {
        if (!this.inFlight.has(requestId)) return
        this.cancelled.add(requestId)
        this.finish(requestId)
    }

    /** Consume a cancellation mark. True when this answer should be dropped. */
    private consumeCancelled(requestId: string): boolean {
        return this.cancelled.delete(requestId)
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

        // 1b. "remember ..." messages are ALSO a durable memory write. The
        //     write happens before the model call so the fact survives even a
        //     failed request; the model still sees the message and replies.
        await this.memories?.captureFromMessage(trimmed).catch(() => undefined)

        // 2. Build context AFTER the user turn is recorded, so the request
        //    includes the just-typed message (Req 3.1). Capture the origin chat
        //    so a slow answer lands here even if the user switches chats.
        const originId = this.originId()
        const ctx = await this.contextWithMemories()

        // 3–5. Run the question as an independently tracked request.
        await this.runRequest(userTurn.id, originId, ctx)
    }

    /**
     * Run one question end-to-end: track it (per-question thinking state +
     * shared pending), ask the gateway, deliver the answer (or hand off to the
     * local fallback / surface the error), and settle. Concurrent calls each
     * deliver their own answer — a new question never supersedes an earlier
     * one — and a cancelled question's late answer is dropped on arrival.
     */
    private async runRequest(
        requestId: string,
        originId: string,
        ctx: SessionContext
    ): Promise<void> {
        this.begin(requestId, originId)
        try {
            const guidance = await this.ai.complete(ctx)
            if (!this.consumeCancelled(requestId)) {
                await this.completeWith(guidance, originId)
            }
        } catch (err) {
            if (!this.consumeCancelled(requestId)) {
                // Every provider failed. When the exhaustion handler is wired
                // it owns the user-facing outcome (setup card / error turn)
                // and settles the request itself; otherwise surface the typed
                // error and settle now.
                if (this.emitters.providersExhausted) {
                    this.emitters.providersExhausted(ctx, originId, requestId)
                    return
                }
                this.surfaceError(err)
            }
        }
        this.finish(requestId)
    }

    /** True (and consumed) when this request was cancelled — drop its result. */
    wasCancelled(requestId: string): boolean {
        return this.consumeCancelled(requestId)
    }

    /** Settle a request that completed outside {@link runRequest} (fallback path). */
    settleRequest(requestId: string): void {
        this.finish(requestId)
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

        // 3–5. Run the question as an independently tracked request.
        await this.runRequest(captureTurn.id, originId, ctx)
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
        const ctx = await this.contextWithMemories()

        await this.runRequest(captureTurn.id, originId, ctx)
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
        // Pending clears in runRequest's finish() once no request remains.
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
