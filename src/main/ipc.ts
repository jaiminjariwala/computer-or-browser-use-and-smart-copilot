import { ipcMain, type BrowserWindow } from 'electron'
import type {
    GlassError,
    MailReadResult,
    MemoryEntry,
    Rect,
    SessionContext,
    SessionListItem,
    SessionSummary,
    SessionView,
    TurnCapture,
    TurnView
} from '@shared/types'

/**
 * Glass IPC wiring (design: "IPC channel map").
 *
 * Registers the `ipcMain` handlers for the Sidebar/Overlay -> main channels and
 * provides typed emitter helpers for the main -> Sidebar event channels. The
 * preload bridge (`src/preload/index.ts`) is the renderer-facing counterpart.
 *
 * Backing services (Session Manager, Capture Service, AI Gateway) arrive in
 * later tasks. Until then, the request handlers delegate to optional callbacks
 * in {@link GlassIpcDeps}; when a callback is absent the handler is a safe no-op
 * (or returns an empty session for `session:get`). This keeps the bridge fully
 * callable end-to-end before the services exist.
 *
 * Note: the `config:get-status` / `config:save` channels are owned by
 * `registerConfigIpc` in `config.ts` and are intentionally NOT registered here
 * to avoid duplicate `ipcMain.handle` registrations.
 */

/** A target window for an event emit; tolerant of null/undefined. */
type WindowRef = BrowserWindow | null | undefined

/** Optional backing services, injected as they come online in later tasks. */
export interface GlassIpcDeps {
    /** Accessor for the sidebar window that receives main -> SB events. */
    getSidebarWindow: () => WindowRef
    /** `chat:send` — handle a typed message (Req 2.2, 3.1). */
    onSendMessage?: (text: string) => void | Promise<void>
    /** `chat:send-captures` — send staged screenshot captures + optional text. */
    onSendCaptures?: (captures: TurnCapture[], text?: string) => void | Promise<void>
    /** `capture:trigger` — begin a region capture (Req 4.1). */
    onTriggerCapture?: () => void | Promise<void>
    /** `capture:region` — a rectangle was selected (Req 4.3). */
    onSubmitRegion?: (rect: Rect, text?: string) => void | Promise<void>
    /** `capture:cancel` — the capture was cancelled (Req 4.4). */
    onCancelRegion?: () => void | Promise<void>
    /** `session:new` — archive the current session and start fresh (Req 9.1). */
    onNewSession?: () => void | Promise<void>
    /** `session:get` — return the active session for restore (Req 9.3). */
    getSession?: () => SessionView | Promise<SessionView>
    /** `session:list` — list past (archived) sessions for the history panel. */
    onListSessions?: () => SessionListItem[] | Promise<SessionListItem[]>
    /** `session:open` — make a past session the active conversation. */
    onOpenSession?: (id: string) => void | Promise<void>
    /** `session:delete` — delete one or more archived sessions. */
    onDeleteSessions?: (ids: string[]) => void | Promise<void>
    /** `models:list` — list model ids available on the gateway. */
    onListModels?: () => string[] | Promise<string[]>
    /** `audio:transcribe` — speech-to-text for a recorded audio clip. */
    onTranscribe?: (audioBase64: string, format: string) => string | Promise<string>
    /** `chat:cancel` — the user cancelled a still-thinking question. */
    onCancelRequest?: (requestId: string) => void
    /** `memory:list` — every persistent-memory entry (Settings audit view). */
    onListMemories?: () => MemoryEntry[] | Promise<MemoryEntry[]>
    /** `memory:add` — store a memory typed in Settings. Returns updated list. */
    onAddMemory?: (text: string) => MemoryEntry[] | Promise<MemoryEntry[]>
    /** `memory:delete` — delete one entry. Returns updated list. */
    onDeleteMemory?: (id: string) => MemoryEntry[] | Promise<MemoryEntry[]>
    /** `memory:clear` — forget everything. */
    onClearMemories?: () => MemoryEntry[] | Promise<MemoryEntry[]>
    /** `mail:read-selected` — read the message selected in Mail or Outlook. */
    onReadSelectedMail?: (source: 'mail' | 'outlook') => MailReadResult | Promise<MailReadResult>
}

const EMPTY_SUMMARY: SessionSummary = {
    inferredIntent: '',
    completedSteps: [],
    updatedThroughTurnId: null
}

/** The session view returned before a Session Manager exists (task 5/10). */
export const EMPTY_SESSION_VIEW: SessionView = {
    id: '',
    turns: [],
    summary: EMPTY_SUMMARY
}

/**
 * Register the Sidebar/Overlay -> main IPC handlers. Returns a disposer that
 * removes every handler this call registered (useful for tests and teardown).
 */
export function registerGlassIpc(deps: GlassIpcDeps): () => void {
    ipcMain.handle('chat:send', async (_event, payload: { text: string } | undefined): Promise<void> => {
        await deps.onSendMessage?.(payload?.text ?? '')
    })

    ipcMain.handle(
        'chat:send-captures',
        async (
            _event,
            payload: { captures?: TurnCapture[]; text?: string } | undefined
        ): Promise<void> => {
            const captures = Array.isArray(payload?.captures) ? payload!.captures : []
            await deps.onSendCaptures?.(captures, payload?.text)
        }
    )

    ipcMain.handle('capture:trigger', async (): Promise<void> => {
        await deps.onTriggerCapture?.()
    })

    ipcMain.handle('capture:region', async (_event, payload: { rect: Rect; text?: string } | undefined): Promise<void> => {
        if (payload?.rect) {
            await deps.onSubmitRegion?.(payload.rect, payload.text)
        }
    })

    ipcMain.handle('capture:cancel', async (): Promise<void> => {
        await deps.onCancelRegion?.()
    })

    ipcMain.handle('session:new', async (): Promise<void> => {
        await deps.onNewSession?.()
    })

    ipcMain.handle('session:get', async (): Promise<SessionView> => {
        return (await deps.getSession?.()) ?? EMPTY_SESSION_VIEW
    })

    ipcMain.handle('session:list', async (): Promise<SessionListItem[]> => {
        return (await deps.onListSessions?.()) ?? []
    })

    ipcMain.handle('session:open', async (_event, payload: { id: string } | undefined): Promise<void> => {
        if (payload?.id) {
            await deps.onOpenSession?.(payload.id)
        }
    })

    ipcMain.handle('session:delete', async (_event, payload: { ids: string[] } | undefined): Promise<void> => {
        if (payload?.ids && payload.ids.length > 0) {
            await deps.onDeleteSessions?.(payload.ids)
        }
    })

    ipcMain.handle('models:list', async (): Promise<string[]> => {
        return (await deps.onListModels?.()) ?? []
    })
    ipcMain.handle('memory:list', async (): Promise<MemoryEntry[]> => {
        return (await deps.onListMemories?.()) ?? []
    })
    ipcMain.handle(
        'memory:add',
        async (_event, payload: { text?: string } | undefined): Promise<MemoryEntry[]> => {
            const text = payload?.text?.trim() ?? ''
            if (text.length === 0) return (await deps.onListMemories?.()) ?? []
            return (await deps.onAddMemory?.(text)) ?? []
        }
    )
    ipcMain.handle(
        'memory:delete',
        async (_event, payload: { id?: string } | undefined): Promise<MemoryEntry[]> => {
            if (!payload?.id) return (await deps.onListMemories?.()) ?? []
            return (await deps.onDeleteMemory?.(payload.id)) ?? []
        }
    )
    ipcMain.handle('memory:clear', async (): Promise<MemoryEntry[]> => {
        return (await deps.onClearMemories?.()) ?? []
    })
    ipcMain.handle(
        'mail:read-selected',
        async (_event, payload: { source?: string } | undefined): Promise<MailReadResult> => {
            const source = payload?.source === 'outlook' ? 'outlook' : 'mail'
            return (
                (await deps.onReadSelectedMail?.(source)) ?? {
                    ok: false,
                    error: 'The email integration is not available in this build.'
                }
            )
        }
    )

    ipcMain.handle(
        'audio:transcribe',
        async (
            _event,
            payload: { audioBase64: string; format?: string } | undefined
        ): Promise<string> => {
            if (!payload?.audioBase64) return ''
            return (await deps.onTranscribe?.(payload.audioBase64, payload.format ?? 'wav')) ?? ''
        }
    )

    ipcMain.handle(
        'chat:cancel',
        (_event, payload: { requestId: string } | undefined): void => {
            if (payload?.requestId) deps.onCancelRequest?.(payload.requestId)
        }
    )

    return () => {
        for (const channel of [
            'chat:send',
            'chat:send-captures',
            'chat:cancel',
            'capture:trigger',
            'capture:region',
            'capture:cancel',
            'session:new',
            'session:get',
            'session:list',
            'session:open',
            'session:delete',
            'models:list',
            'audio:transcribe',
            'memory:list',
            'memory:add',
            'memory:delete',
            'memory:clear',
            'mail:read-selected'
        ]) {
            ipcMain.removeHandler(channel)
        }
    }
}

/** Push an appended turn to the sidebar (`turn:appended`, Req 2.4, 2.5, 5.2). */
export function emitTurnAppended(window: WindowRef, turn: TurnView): void {
    window?.webContents.send('turn:appended', turn)
}

/** Push the in-progress/pending state to the sidebar (`request:pending`, Req 5.3). */
export function emitPending(window: WindowRef, pending: boolean): void {
    window?.webContents.send('request:pending', pending)
}

/** Push a user-facing error to the sidebar (`error:show`, Req 2.3, 7.3, 8.x). */
export function emitError(window: WindowRef, error: GlassError): void {
    window?.webContents.send('error:show', error)
}

/**
 * Push the active session state to the sidebar (`session:state`). Emitted after
 * a New Session so the conversation view clears and renders the fresh, empty
 * session (Req 9.1).
 */
export function emitSessionState(window: WindowRef, session: SessionView): void {
    window?.webContents.send('session:state', session)
}

/**
 * Push the running session summary (inferred goal + completed steps) to the
 * sidebar (`summary:state`) so the goal/step tracker can render live progress
 * (Req 6).
 */
export function emitSummary(window: WindowRef, summary: SessionSummary): void {
    window?.webContents.send('summary:state', summary)
}

/**
 * Push a freshly captured region to the sidebar as a staged capture
 * (`capture:staged`) so it lands in the screenshot carousel above the composer
 * instead of being sent to the gateway immediately.
 */
export function emitCaptureStaged(window: WindowRef, capture: TurnCapture): void {
    window?.webContents.send('capture:staged', capture)
}

/**
 * No AI provider is configured at all — tell the sidebar to show the in-chat
 * key setup card (`setup:needed`) so the user can paste a key right there.
 */
export function emitSetupNeeded(window: WindowRef): void {
    window?.webContents.send('setup:needed')
}

/** A question began processing (`request:started`, id = its user turn). */
export function emitRequestStarted(window: WindowRef, requestId: string): void {
    window?.webContents.send('request:started', requestId)
}

/** A question finished — answered, failed, or cancelled (`request:settled`). */
export function emitRequestSettled(window: WindowRef, requestId: string): void {
    window?.webContents.send('request:settled', requestId)
}
