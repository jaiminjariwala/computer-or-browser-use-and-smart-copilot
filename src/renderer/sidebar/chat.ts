import type { Turn, TurnRole } from '@shared/types'

/**
 * Pure chat helpers for the Sidebar_Panel.
 *
 * Kept free of React/DOM so the conversation logic can be unit-tested without
 * a renderer. The Sidebar accepts typed text only (Req 2.6); these helpers
 * normalize and gate that input.
 */

/** Generate a reasonably unique turn id without external dependencies. */
export function createTurnId(): string {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** A submitted message is only valid when it has non-whitespace content. */
export function isSubmittable(text: string): boolean {
    return text.trim().length > 0
}

/**
 * Build a conversation Turn from typed text. Returns null when the input is
 * empty/whitespace so callers can ignore no-op submits.
 */
export function makeTextTurn(role: TurnRole, text: string): Turn | null {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
        return null
    }
    return {
        id: createTurnId(),
        role,
        text: trimmed,
        createdAt: new Date().toISOString(),
        status: 'ok'
    }
}
