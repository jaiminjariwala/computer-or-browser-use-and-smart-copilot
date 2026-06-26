/**
 * Vendored legacy types (Task 2 — "Vendor Click Copilot primitives").
 *
 * These types were COPIED from Click Copilot (`click-copilot/src/shared/types.ts`)
 * so the freshly vendored primitives in this folder compile independently while
 * Click Operator evolves its own copies. They are intentionally *local* to the
 * vendored main-process modules and are NOT the project's shared data model.
 *
 * The design's real data model — `AutonomyLevel`, `AgentSession`, `Observation`,
 * the `Action` discriminated union (Action_Space), `ActionResult`, `Trajectory`,
 * the provider/config models, `OperatorError`, etc. — lives in
 * `src/shared/types.ts` (authored by the shared-types task). Later adaptation
 * tasks (5, 6, 7, 12) migrate these vendored modules onto those design names
 * (e.g. `Session` → `AgentSession`, `Turn` → Trajectory step, `SessionSummary`
 * → `TrajectorySummary`, `GatewayConfig` → the ProviderChain/ModelProvider
 * models, `GlassError` → `OperatorError`).
 *
 * Reuse rule (Req 19): this file is a one-time vendor of Click Copilot concepts.
 * Nothing here imports from, references, or depends on the `click-copilot`
 * project — Click Operator owns and evolves these copies.
 */

/** A rectangular screen region, in display pixels. */
export type Rect = { x: number; y: number; width: number; height: number }

/** Who authored a conversation turn. */
export type TurnRole = 'user' | 'assistant'

/** Image data attached to a turn when it carries a capture. */
export interface TurnCapture {
    /** Base64 PNG data URL of the full captured region (kept locally). */
    dataUrl: string
    /** Small thumbnail data URL. */
    thumbnailUrl: string
    /** The rectangle that was selected, in display pixels. */
    rect: Rect
}

/** A single chronological entry in a session conversation. */
export interface Turn {
    id: string
    role: TurnRole
    /** User message text or assistant guidance. */
    text?: string
    /** Present when the turn carries a capture. */
    capture?: TurnCapture
    /** ISO timestamp of when the turn was created. */
    createdAt: string
    /** 'error' retains failed-render turns. */
    status: 'ok' | 'error'
}

/** Condensed, running record of session progress. */
export interface SessionSummary {
    /** The user's goal inferred from the conversation. */
    inferredIntent: string
    /** Steps the user has completed so far. */
    completedSteps: string[]
    /** The last turn id that has been folded into this summary, or null. */
    updatedThroughTurnId: string | null
}

/** The full, persisted record of a conversation. */
export interface Session {
    id: string
    /** Full chronological record of turns. */
    turns: Turn[]
    /** Running condensed progress. */
    summary: SessionSummary
    createdAt: string
    updatedAt: string
}

/**
 * The data sent to the gateway for a request. Derived from the Session, never
 * stored directly.
 */
export interface SessionContext {
    /** Condensed older history. */
    summary: SessionSummary
    /** The last N turns, verbatim. */
    recentTurns: Turn[]
    /** The capture being interpreted on this request, if any. */
    currentCapture?: TurnCapture
}

/** How the user draws the capture region. */
export type CaptureMode = 'circle' | 'rectangle'

/** Gateway connection settings. The API key is stored separately, encrypted. */
export interface GatewayConfig {
    baseURL: string
    /** Vision-capable model id on the gateway. */
    model: string
    /** Optional fallback gateway used when the primary is unavailable. */
    fallbackBaseURL?: string
    /** Model id to use on the fallback gateway. */
    fallbackModel?: string
    /** How the capture region is drawn. */
    captureMode?: CaptureMode
}

/**
 * The payload the renderer sends to save gateway configuration. The API key is
 * included in transit but is persisted separately and encrypted via
 * `safeStorage`; it is never written to `config.json`.
 */
export interface GatewayConfigInput {
    baseURL: string
    model: string
    apiKey: string
    /** Optional fallback gateway (e.g. local Ollama) used when primary fails. */
    fallbackBaseURL?: string
    fallbackModel?: string
    /** Empty/whitespace leaves the stored fallback key unchanged. */
    fallbackApiKey?: string
    /** How the capture region is drawn. */
    captureMode?: CaptureMode
}

/** Non-secret status of the saved configuration. Returned by `config:get-status`. */
export interface ConfigStatus {
    hasCredentials: boolean
    baseURL: string
    model: string
    /** Fallback gateway settings (non-secret) + whether it is configured. */
    fallbackBaseURL: string
    fallbackModel: string
    hasFallback: boolean
    /** How the capture region is drawn. */
    captureMode: CaptureMode
}

/** Renderer-facing view of a single turn. */
export type TurnView = Turn

/** Renderer-facing view of the active session. */
export interface SessionView {
    id: string
    /** Full chronological record of turns, oldest first. */
    turns: TurnView[]
    /** Running condensed progress. */
    summary: SessionSummary
}

/** Lightweight metadata for a past (archived) session. */
export interface SessionListItem {
    id: string
    /** A short title derived from the first user message (or inferred intent). */
    title: string
    /** ISO timestamp of the last update, for sorting newest-first. */
    updatedAt: string
    /** Number of turns in the session. */
    turnCount: number
}

/** Kinds of failures surfaced to the user (superseded by `OperatorError`). */
export type GlassErrorKind =
    | 'hotkey-conflict'
    | 'hotkey-failed'
    | 'render-failed'
    | 'permission-missing'
    | 'permission-revoked'
    | 'gateway-failed'
    | 'credentials-missing'

/** Recovery actions a user can take in response to an error. */
export type GlassErrorAction =
    | 'open-settings'
    | 'choose-hotkey'
    | 'enter-credentials'
    | 'retry'

/** A typed, user-facing failure. Failures never discard session content. */
export interface GlassError {
    kind: GlassErrorKind
    /** User-facing message describing the failure. */
    message: string
    /** Whether a retry/action can resolve it. */
    recoverable: boolean
    /** An optional recovery action the UI can offer. */
    action?: GlassErrorAction
}
