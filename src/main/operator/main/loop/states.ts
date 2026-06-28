import type { LoopState } from '@op-shared/types'

/**
 * The terminal states the loop can end in. Each maps 1:1 to a SessionStatus set
 * on the AgentSession when the run ends (Req 6.2, 6.4, 6.5 — Property 16), so a
 * finished loop and its recorded session always agree on how the run concluded.
 */
export type TerminalState = 'completed' | 'failed' | 'stopped' | 'budget-exhausted'

/**
 * Whether `state` is terminal — i.e. the run is over and must not advance or be
 * restarted in place (Req 7.4). This is the guard the public controls consult
 * before doing anything, so "stopped means stopped" holds no matter which path
 * ended the run.
 */
export function isTerminalState(state: LoopState): boolean {
    return (
        state === 'stopped' ||
        state === 'completed' ||
        state === 'failed' ||
        state === 'budget-exhausted'
    )
}
