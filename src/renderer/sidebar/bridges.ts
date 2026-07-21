import type {
    GlassError,
    MailReadResult,
    MemoryEntry,
    SessionListItem,
    SessionSummary,
    SessionView,
    TurnCapture,
    TurnView
} from '@shared/types'

/**
 * Typed access to the preload bridges. The interfaces are declared locally
 * (rather than importing the full `window.glass` typing) so the chat UI only
 * depends on the slice it actually calls, and tests can fake it trivially.
 */

export interface ChatBridge {
    sendMessage(text: string): Promise<void>
    sendCaptures(captures: TurnCapture[], text?: string): Promise<void>
    newSession(): Promise<void>
    getSession(): Promise<SessionView>
    listSessions(): Promise<SessionListItem[]>
    openSession(id: string): Promise<void>
    deleteSessions(ids: string[]): Promise<void>
    listModels(): Promise<string[]>
    onTurnAppended(cb: (turn: TurnView) => void): void | (() => void)
    onPending(cb: (pending: boolean) => void): void | (() => void)
    onError(cb: (err: GlassError) => void): void | (() => void)
    onSessionState?(cb: (session: SessionView) => void): void | (() => void)
    onCredentialsRequired?(cb: () => void): void | (() => void)
    onSummary?(cb: (summary: SessionSummary) => void): void | (() => void)
    onCaptureStaged?(cb: (capture: TurnCapture) => void): void | (() => void)
    onSetupNeeded?(cb: () => void): void | (() => void)
    onRequestStarted?(cb: (requestId: string) => void): void | (() => void)
    onRequestSettled?(cb: (requestId: string) => void): void | (() => void)
    cancelRequest?(requestId: string): Promise<void>
    // Persistent memory (Settings audit surface); optional so older preloads
    // and test fakes stay valid.
    listMemories?(): Promise<MemoryEntry[]>
    addMemory?(text: string): Promise<MemoryEntry[]>
    deleteMemory?(id: string): Promise<MemoryEntry[]>
    clearMemories?(): Promise<MemoryEntry[]>
    /** Email connector: the message currently selected in Mail or Outlook. */
    readSelectedMail?(source?: 'mail' | 'outlook'): Promise<MailReadResult>
}

export function getChatBridge(): ChatBridge | null {
    const glass = (window as unknown as { glass?: Partial<ChatBridge> }).glass
    if (glass && typeof glass.sendMessage === 'function') {
        return glass as ChatBridge
    }
    return null
}

/** The merged operator engine bridge, or null when it is not injected. */
export function getOperatorBridge(): NonNullable<typeof window.operator> | null {
    const op = window.operator
    return op && typeof op.startGoal === 'function' ? op : null
}
