import type { TurnView } from '@shared/types'
import type { AgentSessionView } from '@op-shared/types'
import { describeStep, type StepItem } from './operator'

/**
 * Helpers behind the sidebar rail: chat titles, restored-operator-session
 * views, and small display utilities shared by the rail and the header.
 */

/** Below this window width the rail becomes a floating overlay. */
export const NAV_OVERLAY_BREAKPOINT = 720

/**
 * Sentinel rail id for the operator's draft state. Operator sessions only
 * exist once a goal is submitted (a blank Goal is rejected by design), so
 * after "New task" clears the workspace there is no real session id to pin
 * the rail's current row to. The draft pill stands in until the first goal
 * creates the real session. It is navigation-inert: not openable, no
 * context menu, never persisted.
 */
export const OPERATOR_DRAFT_ID = 'op-draft'

/**
 * Convert a restored operator task (goal + trajectory) into displayable turns so
 * an opened operator session reads like a chat: the goal as a user turn, then
 * each perceive -> reason -> act step as an assistant turn.
 */
export function operatorViewToTurns(view: AgentSessionView): TurnView[] {
    // Only the goal renders as a chat turn; the steps render in the checklist
    // (populated separately from the trajectory when the session is opened).
    const turns: TurnView[] = []
    if (view.goalText && view.goalText.trim().length > 0) {
        turns.push({
            id: `op-goal-${view.id}`,
            role: 'user',
            text: view.goalText,
            createdAt: view.createdAt,
            status: 'ok'
        })
    }
    return turns
}

/** The checklist rows for a (restored) operator session's trajectory. */
export function operatorViewToSteps(view: AgentSessionView): Array<{ id: string } & StepItem> {
    return (view.trajectory ?? []).map((step) => ({
        id: `op-step-${view.id}-${step.index}`,
        ...describeStep(step)
    }))
}

/** Strip markdown noise and clamp for one-line rail labels. */
export function compactSidebarText(value: string | undefined, limit = 120): string {
    const compact = (value ?? '')
        .replace(/[`*_>#\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

/**
 * The rail title for a chat. Tracks the conversation LIVE: the newest user
 * question wins, so a chat that moves from "capital of USA" to a Python
 * problem renames itself the moment the new question is sent.
 */
export function titleFromTurns(turns: TurnView[], fallback: string): string {
    let latestUser: string | undefined
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i]
        if (turn.role === 'user' && typeof turn.text === 'string' && turn.text.trim().length > 0) {
            latestUser = turn.text
            break
        }
    }
    const title = compactSidebarText(latestUser ?? fallback, 54)
    if (title) return title
    return turns.some((turn) => turn.capture || (turn.captures?.length ?? 0) > 0)
        ? 'Screen capture chat'
        : 'Untitled chat'
}

/** Friendly display names for the operator's provider ids (for the status pill). */
const PROVIDER_LABELS: Record<string, string> = {
    primary: 'Primary',
    gemini: 'Gemini',
    openrouter: 'OpenRouter'
}

/** Map an operator provider id to a short human label; fall back to the id. */
export function friendlyProvider(id: string): string {
    return PROVIDER_LABELS[id] ?? id
}
