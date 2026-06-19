import type { GlassError, TurnView } from '@shared/types'
import { makeTextTurn } from './chat'

/**
 * Pure conversation state for the Sidebar_Panel (task 2.3).
 *
 * The reducer is intentionally free of React/DOM so the rendering logic for
 * user messages, the in-progress indicator, and the error indicator can be
 * unit-tested in a plain environment. The React component in `App.tsx` holds an
 * instance of this state and re-renders from it.
 *
 * Behavior wired here:
 *  - Submitting typed text optimistically appends a user turn so it shows
 *    immediately in the conversation view (Req 2.2).
 *  - Turns pushed from the main process via `turn:appended` are appended in
 *    arrival order; optimistic user turns are reconciled with their
 *    authoritative counterpart so they are never shown twice (Req 2.4, 5.2).
 *  - `request:pending` toggles an in-progress indicator (Req 5.3).
 *  - `error:show` surfaces an error indicator WITHOUT dropping any turns, so a
 *    message that failed to render/process is retained in the view (Req 2.3).
 */
export interface ConversationState {
    /** Full chronological list of turns shown in the conversation view. */
    turns: TurnView[]
    /** True while awaiting a response from the main process (Req 5.3). */
    pending: boolean
    /** The current error to surface, or null when there is none (Req 2.3). */
    error: GlassError | null
    /**
     * Ids of optimistic user turns not yet confirmed by the main process.
     * Used to reconcile a renderer-generated turn with the authoritative turn
     * the main process later emits, avoiding a duplicate render.
     */
    unconfirmedUserTurnIds: string[]
}

/** Build the initial conversation state, optionally seeded with restored turns. */
export function initialConversationState(turns: TurnView[] = []): ConversationState {
    return {
        turns: [...turns],
        pending: false,
        error: null,
        unconfirmedUserTurnIds: []
    }
}

/**
 * Optimistically append a user turn from typed text (Req 2.2). Returns the new
 * state and the created turn (or null when the input is empty/whitespace so the
 * caller can skip sending). Submitting clears any prior error indicator since a
 * new attempt is under way, while leaving all existing turns intact (Req 5.4).
 */
export function addUserMessage(
    state: ConversationState,
    text: string
): { state: ConversationState; turn: TurnView | null } {
    const turn = makeTextTurn('user', text)
    if (!turn) {
        return { state, turn: null }
    }
    return {
        state: {
            ...state,
            turns: [...state.turns, turn],
            error: null,
            unconfirmedUserTurnIds: [...state.unconfirmedUserTurnIds, turn.id]
        },
        turn
    }
}

/**
 * Append a turn pushed from the main process (`turn:appended`). Idempotent by
 * id, and reconciles optimistic user turns: when the main process echoes a user
 * turn whose text matches an unconfirmed optimistic turn, the optimistic turn is
 * replaced in place rather than duplicated. An assistant turn confirms any
 * pending optimistic user turns.
 */
export function appendTurn(state: ConversationState, incoming: TurnView): ConversationState {
    // Idempotent: ignore a turn we already hold by id.
    if (state.turns.some((t) => t.id === incoming.id)) {
        return state
    }

    if (incoming.role === 'user' && state.unconfirmedUserTurnIds.length > 0) {
        const idx = state.turns.findIndex(
            (t) =>
                state.unconfirmedUserTurnIds.includes(t.id) &&
                t.role === 'user' &&
                t.text === incoming.text
        )
        if (idx !== -1) {
            const optimisticId = state.turns[idx].id
            const turns = [...state.turns]
            turns[idx] = incoming
            return {
                ...state,
                turns,
                unconfirmedUserTurnIds: state.unconfirmedUserTurnIds.filter(
                    (id) => id !== optimisticId
                )
            }
        }
    }

    // An assistant turn means the preceding optimistic user turns are confirmed.
    const unconfirmedUserTurnIds =
        incoming.role === 'assistant' ? [] : state.unconfirmedUserTurnIds

    return {
        ...state,
        turns: [...state.turns, incoming],
        unconfirmedUserTurnIds
    }
}

/** Toggle the in-progress indicator (`request:pending`, Req 5.3). */
export function setPending(state: ConversationState, pending: boolean): ConversationState {
    return { ...state, pending }
}

/**
 * Surface an error indicator (`error:show`, Req 2.3). Existing turns are never
 * dropped or reordered so the submitted message is retained in the view; an
 * error also ends any in-progress state.
 */
export function setError(state: ConversationState, error: GlassError): ConversationState {
    return { ...state, error, pending: false }
}

/** Dismiss the current error indicator without touching the conversation. */
export function clearError(state: ConversationState): ConversationState {
    return { ...state, error: null }
}
