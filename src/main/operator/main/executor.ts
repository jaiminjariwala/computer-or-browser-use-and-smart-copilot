/**
 * Action Executor barrel (Tasks 9.1 + 9.2) — the "hands" of the agent.
 *
 * The executor is only ever reachable THROUGH the fail-closed Safety gate. It
 * validates + maps every approved Action before any OS event (Property 8) and
 * records an ActionResult for every attempt (Property 9), realizing input via
 * the native CGEvent addon, falling back to `cliclick`, else failing closed.
 *
 * The implementation lives under `./executor/`; this file re-exports the public
 * surface so importers keep using `'./executor'` unchanged:
 *   - backend.ts          — InputBackend, MouseButton, selectInputBackend
 *   - native-backend.ts   — the native CGEvent path (primary)
 *   - cliclick-backend.ts — the `cliclick` subprocess fallback
 *   - action-executor.ts  — the ActionExecutor orchestration
 */

export type { InputBackend, MouseButton } from './executor/backend'
export { selectInputBackend } from './executor/backend'

export type { NativeInputSynth } from './executor/native-backend'
export {
    NativeInputBackend,
    loadNativeInputSynth,
    loadNativeBackend
} from './executor/native-backend'

export {
    CliclickInputBackend,
    cliclickCommands,
    isCliclickAvailable
} from './executor/cliclick-backend'

export type { ActionExecutorDeps, ExecuteMeta } from './executor/action-executor'
export { ActionExecutor, createActionExecutor } from './executor/action-executor'
