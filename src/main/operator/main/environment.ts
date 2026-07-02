/**
 * Execution Environment abstraction (Task 20 / Req 22) — public barrel.
 *
 * The implementation lives under `./environment/`; this file re-exports the
 * public surface so importers use `'./environment'` / `'../environment'`:
 *   - types.ts             — the {@link Environment} interface + health/viewport.
 *   - local-environment.ts — the macOS desktop backend ({@link LocalEnvironment}).
 *
 * The sandboxed-browser backend (Playwright) lands alongside these behind the
 * same interface in a later task.
 */

export type { Environment, EnvironmentHealth, EnvironmentViewport } from './environment/types'
export { LocalEnvironment } from './environment/local-environment'
export type { LocalEnvironmentDeps } from './environment/local-environment'
export { EnvironmentRouter } from './environment/environment-router'
export { ContainerDesktopEnvironment } from './environment/container-desktop-environment'
export type { ContainerDesktopEnvironmentDeps } from './environment/container-desktop-environment'
export { PlaywrightBrowserEnvironment } from './environment/browser-environment'
export type { BrowserEnvironmentDeps } from './environment/browser-environment'
