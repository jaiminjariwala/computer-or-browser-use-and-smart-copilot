/**
 * Window Manager — barrel.
 *
 * Split by concern under `windows/` while keeping `./windows` as the single
 * import surface:
 *
 *  - `options.ts` — pure, unit-testable BrowserWindow option factories +
 *    window constants (frameless/floating console, transparent non-focusable
 *    indicator, both renderers locked down).
 *  - `manager.ts` — the stateful {@link WindowManager} that owns window
 *    lifecycle and drives the Control_Indicator in lockstep with the "agent in
 *    control" flag (Req 12.1, 12.2).
 */

export * from './windows/options'
export * from './windows/manager'
