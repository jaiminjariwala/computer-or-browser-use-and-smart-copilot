import type {
    Session,
    SessionContext,
    SessionSummary,
    SessionView,
    Turn,
    TurnCapture,
    TurnRole
} from '@shared/types'

/**
 * Session Manager (design: "Session Manager", "Data Models", "SessionContext").
 *
 * The in-memory source of truth for the active {@link Session}. It:
 *  - Holds the active session and exposes it as a renderer-facing
 *    {@link SessionView} (Req 9.3 restore surface).
 *  - Appends turns in strict chronological order, minting ids + timestamps for
 *    each (Req 3.2, Correctness Property 6).
 *  - Builds a derived {@link SessionContext} = running summary + the most recent
 *    {@link KEEP_RECENT} turns + an optional current capture (Req 3.1,
 *    Correctness Properties 1 and 2).
 *  - Can start a fresh empty session (Req 9.1) and adopt a restored session.
 *
 * Scope: this module owns only the in-memory session state and context
 * building. It is intentionally pure and free of any Electron dependency so it
 * can be unit-tested directly. Persistence (task 10) and summarization
 * triggering (task 9) are deliberately left as clean seams:
 *  - {@link SessionManagerHooks.onSessionChanged} fires after every mutation —
 *    task 10 will persist the session here.
 *  - {@link SessionManagerHooks.onTurnAppended} fires after each append — task 9
 *    will inspect the turn count past `summary.updatedThroughTurnId` and trigger
 *    summarization here.
 * Neither summarization nor disk I/O is performed in this module.
 */

/**
 * The number of most-recent turns carried verbatim in a {@link SessionContext}
 * (design: "Summarization trigger", Correctness Property 2). Older turns are
 * represented by the running summary rather than replayed turn-by-turn. Task 9
 * tunes this alongside the summarization threshold.
 */
export const KEEP_RECENT = 4

/** Produces a unique id for a session or a turn. Injectable for tests. */
export type IdGenerator = () => string

/** Produces the current time as an ISO-8601 timestamp. Injectable for tests. */
export type Clock = () => string

/** Fields a caller supplies to append a new turn; ids/timestamps are minted. */
export interface AppendTurnInput {
    role: TurnRole
    /** User message text or assistant guidance. */
    text?: string
    /** Region capture carried by the turn, if any. */
    capture?: TurnCapture
    /** Several staged region captures carried by the turn, if any. */
    captures?: TurnCapture[]
    /** Defaults to 'ok'; 'error' retains a failed-render turn (Req 2.3). */
    status?: 'ok' | 'error'
}

/**
 * Optional lifecycle hooks — the seams for later tasks. They are invoked
 * synchronously after a mutation has been applied to the in-memory session; any
 * returned promise is intentionally not awaited so the manager stays a simple,
 * synchronous state holder. The owning wiring (index/ipc) is responsible for
 * awaiting/handling async work such as disk persistence.
 */
export interface SessionManagerHooks {
    /**
     * Fires after any mutation that changes the active session (append, new
     * session, restore). Persistence seam for task 10.
     */
    onSessionChanged?: (session: Session) => void | Promise<void>
    /**
     * Fires after a turn is appended, with the appended turn and the updated
     * session. Summarization-trigger seam for task 9.
     */
    onTurnAppended?: (turn: Turn, session: Session) => void | Promise<void>
}

export interface SessionManagerOptions {
    /** Id factory for sessions and turns. Defaults to a unique generator. */
    generateId?: IdGenerator
    /** Clock for `createdAt`/`updatedAt`. Defaults to `Date.now()` as ISO. */
    now?: Clock
    /** How many recent turns a built context carries. Defaults to {@link KEEP_RECENT}. */
    keepRecent?: number
    /** Lifecycle hooks for persistence/summarization seams. */
    hooks?: SessionManagerHooks
}

/** Build a fresh, empty running summary (no intent/steps inferred yet). */
export function createEmptySummary(): SessionSummary {
    return { inferredIntent: '', completedSteps: [], updatedThroughTurnId: null }
}

/** Build a fresh, empty {@link Session} with a new id and matching timestamps. */
export function createEmptySession(generateId: IdGenerator, now: Clock): Session {
    const timestamp = now()
    return {
        id: generateId(),
        turns: [],
        summary: createEmptySummary(),
        createdAt: timestamp,
        updatedAt: timestamp
    }
}

/**
 * Default id generator. Combines a monotonic counter with a time component and
 * a random suffix so ids are unique even when minted within the same
 * millisecond (turns appended in a tight loop must not collide — Req 3.2).
 */
function createDefaultIdGenerator(): IdGenerator {
    let counter = 0
    return () => {
        counter += 1
        const time = Date.now().toString(36)
        const seq = counter.toString(36)
        const rand = Math.random().toString(36).slice(2, 8)
        return `${time}-${seq}-${rand}`
    }
}

/** Default clock: current time as an ISO-8601 string. */
function defaultClock(): string {
    return new Date().toISOString()
}

/** Deep clone a turn so callers can never mutate the manager's state. */
function cloneTurn(turn: Turn): Turn {
    return structuredClone(turn)
}

/** Deep clone a summary so callers can never mutate the manager's state. */
function cloneSummary(summary: SessionSummary): SessionSummary {
    return structuredClone(summary)
}

/**
 * In-memory holder for the active {@link Session}. Pure and Electron-free; see
 * the module doc for the persistence/summarization seams.
 */
export class SessionManager {
    private session: Session
    private readonly generateId: IdGenerator
    private readonly now: Clock
    private readonly keepRecent: number
    private readonly hooks: SessionManagerHooks

    constructor(options: SessionManagerOptions = {}) {
        this.generateId = options.generateId ?? createDefaultIdGenerator()
        this.now = options.now ?? defaultClock
        this.keepRecent = options.keepRecent ?? KEEP_RECENT
        this.hooks = options.hooks ?? {}
        this.session = createEmptySession(this.generateId, this.now)
    }

    /**
     * The live active session (internal reference). Used by the owning wiring
     * to read summary/turns and to grab the current session before starting a
     * new one (task 10 archive). Callers must treat it as read-only; use
     * {@link getSessionView} when hand­ing data to the renderer.
     */
    getSession(): Session {
        return this.session
    }

    /**
     * A cloned, renderer-facing view of the active session for `session:get`
     * restore (Req 9.3). Cloning guarantees the renderer cannot mutate the
     * manager's turns or summary (supports Correctness Property 6).
     */
    getSessionView(): SessionView {
        return {
            id: this.session.id,
            turns: this.session.turns.map(cloneTurn),
            summary: cloneSummary(this.session.summary)
        }
    }

    /**
     * Append a turn to the end of the chronological record, minting its id,
     * `createdAt`, and `status`. Returns a clone of the created turn so the
     * caller can emit it (`turn:appended`) without aliasing internal state.
     * Appending only ever grows the list and never reorders it (Req 3.2,
     * Correctness Property 6).
     */
    appendTurn(input: AppendTurnInput): Turn {
        const turn: Turn = {
            id: this.generateId(),
            role: input.role,
            createdAt: this.now(),
            status: input.status ?? 'ok'
        }
        if (input.text !== undefined) turn.text = input.text
        if (input.capture !== undefined) turn.capture = input.capture
        if (input.captures !== undefined && input.captures.length > 0) {
            turn.captures = input.captures
        }

        this.session.turns.push(turn)
        this.session.updatedAt = turn.createdAt

        // Summarization-trigger seam (task 9) then persistence seam (task 10).
        void this.hooks.onTurnAppended?.(cloneTurn(turn), this.session)
        void this.hooks.onSessionChanged?.(this.session)

        return cloneTurn(turn)
    }

    /** Convenience: append a user text turn (Flow A, Req 2.2). */
    appendUserText(text: string): Turn {
        return this.appendTurn({ role: 'user', text })
    }

    /**
     * Convenience: append an assistant guidance turn (Req 5.2). Pass
     * `status: 'error'` to retain a turn whose guidance failed to render.
     */
    appendAssistantText(text: string, status: 'ok' | 'error' = 'ok'): Turn {
        return this.appendTurn({ role: 'assistant', text, status })
    }

    /**
     * Convenience: append a user turn carrying a region capture, with optional
     * accompanying text (Req 4.5; text-less captures are interpreted against the
     * existing context per Req 3.3).
     */
    appendUserCapture(capture: TurnCapture, text?: string): Turn {
        return this.appendTurn({ role: 'user', text, capture })
    }

    /**
     * Convenience: append a user turn carrying several staged region captures
     * sent together (the screenshot carousel), with optional accompanying text.
     */
    appendUserCaptures(captures: TurnCapture[], text?: string): Turn {
        return this.appendTurn({ role: 'user', text, captures })
    }

    /**
     * Replace the active session's running {@link SessionSummary}. Used by the
     * Summarizer (task 9) to store a freshly condensed summary after folding
     * older turns. The summary is cloned on the way in so the caller cannot
     * retain an alias to the manager's state, and `onSessionChanged` fires so
     * the persistence seam (task 10) observes the update. This only swaps the
     * summary; turns are never touched, so summarization can never reorder or
     * drop history (Correctness Property 6).
     */
    setSummary(summary: SessionSummary): void {
        this.session.summary = cloneSummary(summary)
        this.session.updatedAt = this.now()
        void this.hooks.onSessionChanged?.(this.session)
    }

    /**
     * Build the derived {@link SessionContext} for a gateway request: the
     * running summary, the most recent {@link KEEP_RECENT} turns verbatim, and
     * an optional `currentCapture` being interpreted on this request.
     *
     * Invariants:
     *  - The summary and `recentTurns` are always present, so a capture is never
     *    sent without session context (Correctness Property 1, Req 3.1, 3.3).
     *  - `recentTurns` never exceeds `keepRecent`, so request size stays bounded
     *    as the session grows — the full history is never replayed (Correctness
     *    Property 2, Req 6.3).
     * Returned data is cloned so the caller cannot mutate manager state.
     */
    buildContext(currentCapture?: TurnCapture): SessionContext {
        const recent =
            this.keepRecent > 0 ? this.session.turns.slice(-this.keepRecent) : []
        const context: SessionContext = {
            summary: cloneSummary(this.session.summary),
            recentTurns: recent.map(cloneTurn)
        }
        if (currentCapture !== undefined) {
            context.currentCapture = currentCapture
        }
        return context
    }

    /**
     * Start a fresh, empty session (Req 9.1). The previous session is dropped
     * from this manager; the caller is responsible for archiving it first (task
     * 10.2) by reading {@link getSession} before calling this. Returns the new
     * active session.
     */
    newSession(): Session {
        this.session = createEmptySession(this.generateId, this.now)
        void this.hooks.onSessionChanged?.(this.session)
        return this.session
    }

    /**
     * Adopt a session loaded from persistence on launch (Req 9.3). Persistence
     * seam for task 10; does not perform any I/O itself. Triggers
     * `onSessionChanged` so downstream wiring can react (e.g. emit to the
     * renderer).
     */
    restore(session: Session): void {
        this.session = session
        void this.hooks.onSessionChanged?.(this.session)
    }
}
