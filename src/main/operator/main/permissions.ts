/**
 * Permission Service — barrel.
 *
 * The permission logic is split by concern under `permissions/` but this file
 * remains the single import surface other modules use (`./permissions`):
 *
 *  - `instructions.ts` — System Settings deep-links + step-by-step guidance for
 *    both permissions (macOS never lets an app flip a privacy toggle itself).
 *  - `screen.ts`       — the vendored Screen Recording-only flow (legacy
 *    GlassError shape) plus `normalizeScreenStatus`.
 *  - `accessibility.ts`— the Accessibility trust→status mapping.
 *  - `service.ts`      — the extended two-permission service: the injectable
 *    OS probe, snapshot, the fail-closed start gate, and revocation detection.
 *
 * Fail-closed is the through-line: a permission is usable only when it is
 * exactly `granted`, and anything else blocks session start and every Action.
 */

export * from './permissions/instructions'
export * from './permissions/screen'
export * from './permissions/accessibility'
export * from './permissions/service'
