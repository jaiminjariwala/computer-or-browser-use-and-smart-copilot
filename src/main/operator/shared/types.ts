/**
 * Shared types for Click Operator.
 *
 * This module is the single source of truth for the data models described in
 * the design's "Data Models" section: the typed Action_Space, the Trajectory
 * audit record, Model_Provider configuration, permissions, errors, the derived
 * ReasoningContext, and the renderer-facing {@link OperatorBridge} contract
 * plus its IPC payload/view types.
 *
 * These types are consumed by the sandboxed renderer (via the preload bridge)
 * and by the privileged main-process services. Keep the names exactly as the
 * design specifies so every module can import them from `@shared/types`.
 *
 * The definitions live in domain modules under `./types/` (action, trajectory,
 * session, reasoning, provider, permissions, errors, ipc). This file is a thin
 * barrel that re-exports them so `@shared/types` resolves unchanged for every
 * importer. Node/TS resolves this `types.ts` file ahead of the `types/`
 * directory, so the barrel keeps the public surface identical.
 */

export * from './types/action'
export * from './types/trajectory'
export * from './types/session'
export * from './types/reasoning'
export * from './types/provider'
export * from './types/permissions'
export * from './types/errors'
export * from './types/ipc'
export * from './types/playbook'
