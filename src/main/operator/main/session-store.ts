/**
 * Session Store — persistence + restore (Task 12.3) — public surface.
 *
 * This used to be one large module; it is now a thin barrel over
 * `./session-store/*` so importers keep importing from `'./session-store'`
 * unchanged. The public API is identical:
 *  - `./session-store/codec` — the JSON codec + persisted-shape validation that
 *    rejects corrupt/foreign files (Req 18.6).
 *  - `./session-store/store` — the `SessionStore` with atomic writes, restore,
 *    archive, and history listing (Req 18.1-18.5, Property 21).
 */

export { jsonAgentSessionCodec } from './session-store/codec'
export type { AgentSessionCodec } from './session-store/codec'

export { SessionStore } from './session-store/store'
export type { SessionFs, SessionStoreOptions } from './session-store/store'
