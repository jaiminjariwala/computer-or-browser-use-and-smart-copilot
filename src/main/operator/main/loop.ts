/**
 * Agent Loop Controller (Task 13) — public surface.
 *
 * This module used to hold the whole state machine; it is now a thin barrel over
 * `./loop/*` so the implementation can live in cohesive, readable files while
 * importers keep importing from `'./loop'` unchanged. Nothing about the public
 * API changed — see `./loop/agent-loop` for the state machine and `./loop/deps`
 * for the injected collaborator interfaces.
 */

export type {
    AgentLoopDeps,
    LoopEmitters,
    LoopExecuteMeta,
    LoopExecutor,
    LoopPerception,
    LoopReasoning,
    LoopSafetyGate,
    LoopSession
} from './loop/deps'

export { AgentLoop, createAgentLoop } from './loop/agent-loop'

export {
    actionSignature,
    trailingRepeatCount,
    buildProgressHint,
    hardStuckReason,
    SOFT_REPEAT_THRESHOLD,
    SOFT_FAILURE_THRESHOLD,
    HARD_REPEAT_THRESHOLD,
    HARD_FAILURE_THRESHOLD,
    type ProgressThresholds
} from './loop/progress'
