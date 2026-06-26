/**
 * Session / Trajectory Manager (Task 12.1, 12.2) — public surface.
 *
 * Migrated onto the design's data model (`AgentSession`, `Trajectory`,
 * `TrajectorySummary`) from the Click Copilot `session.ts` primitive vendored in
 * Task 2. Reuse rule (Req 19): Click Operator owns and evolves this copy; it
 * imports from `@op-shared/types` and nothing here references the `click-copilot`
 * project.
 *
 * This used to be one large module; it is now a thin barrel over `./session/*`
 * so the implementation lives in cohesive files while importers keep importing
 * from `'./session'` unchanged. The public API is identical:
 *  - `./session/factories` — creation inputs, association validation, and value
 *    factories (`isBlankGoal`, `createEmptySummary`, `AppendStepInput`, ...).
 *  - `./session/views`     — renderer-facing view mappers.
 *  - `./session/session-manager` — the in-memory `SessionManager`.
 */

export { KEEP_RECENT, defaultValidateAssociation, isBlankGoal, createEmptySummary } from './session/factories'
export type {
    IdGenerator,
    Clock,
    CreateSessionInput,
    CreateSessionResult,
    AssociationValidator,
    AppendStepReasoning,
    AppendStepInput,
    SessionManagerHooks,
    SessionManagerOptions
} from './session/factories'

export { toTrajectoryStepView, toAgentSessionView } from './session/views'

export { SessionManager } from './session/session-manager'
