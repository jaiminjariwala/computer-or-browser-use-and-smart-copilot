/**
 * Shared type definitions for Glass.
 *
 * These types are used across the main process, preload bridge, and renderer
 * windows. They mirror the "Data Models" and "Error model" sections of the
 * design document.
 */

/** A rectangular screen region, in display pixels. */
export type Rect = { x: number; y: number; width: number; height: number }

/** Who authored a conversation turn. */
export type TurnRole = 'user' | 'assistant'

/** Ordering metadata for a JPEG sampled from an uploaded or recorded video. */
export interface VideoFrameMetadata {
    /** Opaque id used to group frames without putting a filename in model instructions. */
    sequenceId: string
    /** Display name only; no local filesystem path is exposed. */
    sourceName: string
    /** One-based frame index in chronological order. */
    index: number
    count: number
    timestampSeconds: number
    durationSeconds: number
}

/** Image data attached to a turn (screen capture, upload, PDF page, or video frame). */
export interface TurnCapture {
    /** Base64 image data URL sent through the vision-capable model path. */
    dataUrl: string
    /** Small thumbnail data URL shown in the sidebar (Req 2.5). */
    thumbnailUrl: string
    /** The source rectangle, or rendered image dimensions for local attachments. */
    rect: Rect
    /** Present only when this image is one frame in an ordered local video sample. */
    videoFrame?: VideoFrameMetadata
}

/** A single chronological entry in a session conversation. */
export interface Turn {
    id: string
    role: TurnRole
    /** User message text or assistant guidance. */
    text?: string
    /** Present when the turn carries a single Region_Capture. */
    capture?: TurnCapture
    /**
     * Present when the turn carries several staged Region_Captures sent
     * together (the screenshot carousel). When set, this supersedes `capture`.
     */
    captures?: TurnCapture[]
    /** ISO timestamp of when the turn was created. */
    createdAt: string
    /** 'error' retains failed-render turns (Req 2.3). */
    status: 'ok' | 'error'
}

/** Condensed, running record of session progress (Req 6). */
export interface SessionSummary {
    /** The user's goal inferred from the conversation (Req 6.4). */
    inferredIntent: string
    /** Steps the user has completed so far (Req 6.4). */
    completedSteps: string[]
    /** The last turn id that has been folded into this summary, or null. */
    updatedThroughTurnId: string | null
}

/** The full, persisted record of a conversation. */
export interface Session {
    id: string
    /** Full chronological record of turns (Req 3.2). */
    turns: Turn[]
    /** Running condensed progress (Req 6.1). */
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
    /** Optional model overrides for the built-in free hosted fallback chain. */
    openrouterModel?: string
    glmModel?: string
    geminiModel?: string
    /** How the capture region is drawn (defaults to 'circle'). */
    captureMode?: CaptureMode
}

/**
 * The payload the renderer sends to save gateway configuration (Req 7.2).
 * The API key is included here in transit but is persisted separately and
 * encrypted via `safeStorage`; it is never written to `config.json`.
 *
 * An empty/whitespace `apiKey` means "leave the stored key unchanged", so the
 * user can update `baseURL`/`model` without re-entering their key.
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
    /**
     * Built-in free hosted fallback chain (tried in order after the primary,
     * before the on-device model). Each key is persisted encrypted; empty
     * leaves the stored key unchanged. The model fields are optional overrides.
     */
    openrouterApiKey?: string
    openrouterModel?: string
    glmApiKey?: string
    glmModel?: string
    geminiApiKey?: string
    geminiModel?: string
    /** How the capture region is drawn. */
    captureMode?: CaptureMode
}

/**
 * Non-secret status of the saved configuration (Req 7.4). Returned by
 * `config:get-status`. `hasCredentials` reflects whether the app is ready to
 * talk to the gateway (an encrypted API key is stored AND a baseURL is set);
 * the secret key value is never included.
 */
export interface ConfigStatus {
    hasCredentials: boolean
    baseURL: string
    model: string
    /** Fallback gateway settings (non-secret) + whether it is configured. */
    fallbackBaseURL: string
    fallbackModel: string
    hasFallback: boolean
    /** Built-in free hosted fallback chain: whether each has a key + its model. */
    hasOpenrouter: boolean
    openrouterModel: string
    hasGlm: boolean
    glmModel: string
    hasGemini: boolean
    geminiModel: string
    /** How the capture region is drawn. */
    captureMode: CaptureMode
}

/**
 * Renderer-facing view of a single turn. The sidebar consumes turns through
 * the preload bridge rather than touching the persisted `Session` directly, so
 * `TurnView` is kept as its own name even though it currently mirrors `Turn`.
 * This lets later tasks trim or reshape what crosses the bridge (e.g. dropping
 * the full-resolution capture `dataUrl`) without changing renderer code.
 */
export type TurnView = Turn

/**
 * Renderer-facing view of the active session, returned by `session:get` on
 * load so the sidebar can restore the conversation (Req 9.3).
 */
export interface SessionView {
    id: string
    /** Full chronological record of turns, oldest first. */
    turns: TurnView[]
    /** Running condensed progress. */
    summary: SessionSummary
}

/**
 * Lightweight metadata for a past (archived) session, used to populate the
 * chat-history list without loading every full conversation.
 */
export interface SessionListItem {
    id: string
    /** A short title derived from the first user message (or inferred intent). */
    title: string
    /** A compact local-only summary of the latest progress or response. */
    description?: string
    /** ISO timestamp of the last update, for sorting newest-first. */
    updatedAt: string
    /** Number of turns in the session. */
    turnCount: number
}

/** Public GitHub identity shown after a successful Device Flow sign-in. */
export interface GitHubUserIdentity {
    login: string
    /** Optional display name from the user's GitHub profile. */
    name?: string
}

/** Non-secret renderer view of the GitHub authentication lifecycle. */
export interface GitHubAuthStatus {
    state: 'unconfigured' | 'signed-out' | 'authorizing' | 'signed-in' | 'error'
    user?: GitHubUserIdentity
    /** Safe user-facing detail; never contains an access or device token. */
    message?: string
}

/** Short-lived Device Flow details that are safe to show in the renderer. */
export interface GitHubDeviceChallenge {
    userCode: string
    verificationUri: string
    expiresAt: string
}

/** Kinds of failures surfaced to the user. */
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

/**
 * The typed API exposed on `window.glass` via `contextBridge` (design: "Preload
 * bridge"). All request methods are async; event subscriptions register a
 * listener and return an unsubscribe function so the renderer can clean up.
 *
 * Sidebar -> main calls map to `ipcRenderer.invoke`; main -> sidebar events map
 * to `ipcRenderer.on` for the channels in the design's IPC channel map. Methods
 * whose backing services land in later tasks (chat, capture, session) are wired
 * here but resolve against stub handlers until those services exist.
 */
export interface GlassBridge {
    /** Sentinel the renderer can check to confirm the bridge was injected. */
    ready: boolean

    // Sidebar -> main
    /** Send a typed chat message (Req 2.2, 3.1). */
    sendMessage(text: string): Promise<void>
    /**
     * Send one or more staged screenshot captures as a single message, with an
     * optional accompanying text (the screenshot carousel -> Send).
     */
    sendCaptures(captures: TurnCapture[], text?: string): Promise<void>
    /** Begin an on-demand region capture (Req 4.1). */
    triggerCapture(): Promise<void>
    /** Start a fresh session, archiving the current one (Req 9.1). */
    newSession(): Promise<void>
    /** Fetch the active session to restore the conversation on load (Req 9.3). */
    getSession(): Promise<SessionView>
    /** List past (archived) sessions for the chat-history panel. */
    listSessions(): Promise<SessionListItem[]>
    /** Open a past session by id, making it the active conversation. */
    openSession(id: string): Promise<void>
    /** Delete one or more archived sessions by id. */
    deleteSessions(ids: string[]): Promise<void>
    /** List model ids available on the configured gateway. */
    listModels(): Promise<string[]>
    /** Transcribe a recorded audio clip (base64) to text (speech-to-text). */
    transcribe(audioBase64: string, format: string): Promise<string>
    /** Read non-secret config/credential status (Req 7.4). */
    getConfigStatus(): Promise<ConfigStatus>
    /** Persist gateway settings; the API key is stored encrypted (Req 7.2). */
    saveConfig(cfg: GatewayConfigInput): Promise<void>
    /** Pin/unpin the window on top of other windows (floating-panel toggle). */
    setPinned(pinned: boolean): Promise<void>
    /** Read the non-secret GitHub authentication state. */
    getGitHubAuthStatus(): Promise<GitHubAuthStatus>
    /** Begin GitHub Device Flow and open its verification page in the browser. */
    startGitHubLogin(): Promise<GitHubDeviceChallenge>
    /** Remove the encrypted GitHub token and local identity state. */
    logoutGitHub(): Promise<void>

    // main -> Sidebar (event subscriptions; each returns an unsubscribe fn)
    /** GitHub sign-in state changed; access tokens never cross this bridge. */
    onGitHubAuthChanged(cb: (status: GitHubAuthStatus) => void): () => void
    /** A turn was appended to the conversation (Req 2.4, 2.5, 5.2). */
    onTurnAppended(cb: (turn: TurnView) => void): () => void
    /** The in-progress/pending state changed (Req 5.3). */
    onPending(cb: (pending: boolean) => void): () => void
    /** A user-facing error should be shown (Req 2.3, 7.3, 8.x). */
    onError(cb: (err: GlassError) => void): () => void
    /** Gateway credentials are missing and must be entered (Req 7.4). */
    onCredentialsRequired(cb: () => void): () => void
    /** The active session was replaced (e.g. New Session); render it (Req 9.1). */
    onSessionState(cb: (session: SessionView) => void): () => void
    /** The running session summary (goal + completed steps) changed (Req 6, tracker). */
    onSummary(cb: (summary: SessionSummary) => void): () => void
    /**
     * A freshly captured region was staged (not yet sent) so the sidebar can add
     * it to the screenshot carousel above the composer.
     */
    onCaptureStaged(cb: (capture: TurnCapture) => void): () => void
    /**
     * The gateway failed and the request should be answered by the zero-config
     * local fallback model in the renderer; the full context is provided.
     */
    onGatewayFallback(cb: (ctx: SessionContext, originId: string) => void): () => void
    /**
     * Report the local fallback model's answer (or null when it failed).
     * `originId` echoes back the session the request started in so the answer
     * lands in the right chat even if the user has since switched chats.
     */
    submitFallbackResult(text: string | null, originId: string): Promise<void>

    // Overlay -> main
    /** Submit the selected capture rectangle with an optional follow-up (Req 4.3). */
    submitRegion(rect: Rect, text?: string): Promise<void>
    /** Cancel an in-progress capture (Req 4.4). */
    cancelRegion(): Promise<void>
}
