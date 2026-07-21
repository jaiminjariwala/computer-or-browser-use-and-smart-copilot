import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Session, SessionListItem, SessionSummary, Turn } from '@shared/types'

/**
 * Session Store (design: "Persistence & Restore").
 *
 * Persists the active {@link Session} to `userData/sessions/current.json` and
 * loads it back on launch (Req 9.2, 9.3). It is deliberately a *separate*
 * module from {@link SessionManager} so disk I/O never collides with the
 * manager's concurrent in-memory edits:
 *  - The manager owns the in-memory state and fires `onSessionChanged` after
 *    each mutation (append/new/restore).
 *  - This store is wired to that hook and persists the session, coalescing and
 *    serializing writes so overlapping mutations cannot interleave on disk
 *    (Req 9.2).
 *  - On launch the owning wiring calls {@link load} and, if a session is found,
 *    `sessionManager.restore(loaded)` so `session:get` returns the restored
 *    conversation and the sidebar can render it (Req 9.3).
 *
 * Writes are *atomic*: the JSON is written to a temp file and then renamed over
 * `current.json`, so a crash mid-write can never leave a half-written file that
 * would be lost on restart.
 *
 * Reads tolerate a missing or corrupt file by returning `null`, so a fresh
 * install or a damaged file simply starts an empty session rather than crashing
 * (mirrors {@link ConfigStore.readConfig}'s missing/malformed handling).
 *
 * Like {@link ConfigStore}, the base directory and the JSON codec are injectable
 * so the persist→load round-trip and the corrupt/missing-file paths can be
 * unit-tested against a temp directory without touching the real Electron APIs.
 */

const SESSIONS_DIRNAME = 'sessions'
const CURRENT_FILENAME = 'current.json'
/** Temp file written before the atomic rename onto {@link CURRENT_FILENAME}. */
const TEMP_FILENAME = 'current.json.tmp'

/**
 * Serializes a {@link Session} to a string and back. Injectable for tests; the
 * default encodes pretty-printed JSON and decodes with shape validation so a
 * corrupt or foreign file is rejected (yielding `null` from {@link load}).
 */
export interface SessionCodec {
    encode(session: Session): string
    decode(raw: string): Session
}

/** Type guard for the persisted {@link SessionSummary} shape. */
function isValidSummary(value: unknown): value is SessionSummary {
    if (typeof value !== 'object' || value === null) return false
    const summary = value as Record<string, unknown>
    if (typeof summary.inferredIntent !== 'string') return false
    if (!Array.isArray(summary.completedSteps)) return false
    if (!summary.completedSteps.every((step) => typeof step === 'string')) return false
    const through = summary.updatedThroughTurnId
    if (through !== null && typeof through !== 'string') return false
    return true
}

/** Type guard for a persisted {@link Turn}. */
function isValidTurn(value: unknown): value is Turn {
    if (typeof value !== 'object' || value === null) return false
    const turn = value as Record<string, unknown>
    if (typeof turn.id !== 'string') return false
    if (turn.role !== 'user' && turn.role !== 'assistant') return false
    if (typeof turn.createdAt !== 'string') return false
    if (turn.status !== 'ok' && turn.status !== 'error') return false
    if (turn.text !== undefined && typeof turn.text !== 'string') return false
    return true
}

/** Type guard for the persisted {@link Session} shape. */
function isValidSession(value: unknown): value is Session {
    if (typeof value !== 'object' || value === null) return false
    const session = value as Record<string, unknown>
    if (typeof session.id !== 'string') return false
    if (typeof session.createdAt !== 'string') return false
    if (typeof session.updatedAt !== 'string') return false
    if (!Array.isArray(session.turns)) return false
    if (!session.turns.every(isValidTurn)) return false
    if (!isValidSummary(session.summary)) return false
    return true
}

/**
 * Default codec: pretty-printed JSON. `decode` validates the parsed object is a
 * well-formed {@link Session} and throws otherwise so {@link load} can treat a
 * corrupt/foreign file the same as a missing one.
 */
export const jsonSessionCodec: SessionCodec = {
    encode: (session) => JSON.stringify(session, null, 2),
    decode: (raw) => {
        const parsed: unknown = JSON.parse(raw)
        if (!isValidSession(parsed)) {
            throw new Error('Persisted session is not a valid Session')
        }
        return parsed
    }
}

export interface SessionStoreOptions {
    /** Directory to store files in. Defaults to `app.getPath('userData')`. */
    userDataDir?: string
    /** Serialization seam. Defaults to {@link jsonSessionCodec}. */
    codec?: SessionCodec
}

export class SessionStore {
    private readonly dir: string
    private readonly codec: SessionCodec
    /**
     * Serializes writes so overlapping `onSessionChanged` calls cannot interleave
     * the temp-write/rename of two saves. Each save encodes a snapshot of the
     * session *immediately* (synchronously) and only the file I/O is queued, so
     * later in-memory mutations never corrupt an in-flight write.
     */
    private writeChain: Promise<void> = Promise.resolve()

    constructor(options: SessionStoreOptions = {}) {
        this.dir = options.userDataDir ?? app.getPath('userData')
        this.codec = options.codec ?? jsonSessionCodec
    }

    private get sessionsDir(): string {
        return join(this.dir, SESSIONS_DIRNAME)
    }

    private get currentPath(): string {
        return join(this.sessionsDir, CURRENT_FILENAME)
    }

    private get tempPath(): string {
        return join(this.sessionsDir, TEMP_FILENAME)
    }

    /** Path of the archived copy for a session, keyed by its id. */
    private archivePath(id: string): string {
        return join(this.sessionsDir, `${id}.json`)
    }

    /**
     * Load the persisted active session, or `null` if none is stored or the
     * file is missing/corrupt (Req 9.3). Never throws for the missing/corrupt
     * cases so launch can simply start an empty session.
     */
    async load(): Promise<Session | null> {
        let raw: string
        try {
            raw = await fs.readFile(this.currentPath, 'utf-8')
        } catch {
            // ENOENT (or unreadable) -> nothing to restore.
            return null
        }
        try {
            return this.codec.decode(raw)
        } catch {
            // Corrupt/foreign content -> treat as no saved session.
            return null
        }
    }

    /**
     * Persist the session to `current.json` (Req 9.2). The session is encoded
     * synchronously (a snapshot of its current state) and the atomic file write
     * is appended to the serialized write chain. The returned promise resolves
     * when *this* write has been flushed to disk; callers that fire-and-forget
     * (e.g. the `onSessionChanged` hook) may ignore it safely.
     */
    save(session: Session): Promise<void> {
        // Encode now so later in-memory mutations don't affect this snapshot.
        const body = this.codec.encode(session)
        const run = this.writeChain.then(() => this.writeAtomic(body))
        // Keep the chain alive even if a write fails, so one failure doesn't
        // permanently wedge subsequent saves; the failure still surfaces to the
        // caller of *this* save via the returned promise.
        this.writeChain = run.catch(() => undefined)
        return run
    }

    /**
     * Await all queued writes. Primarily for tests and graceful shutdown so a
     * pending coalesced write is guaranteed flushed.
     */
    async flush(): Promise<void> {
        await this.writeChain
    }

    /**
     * Archive a session to `sessions/<id>.json` so the prior conversation is
     * preserved when the user starts a new session (Req 9.1, design
     * "Persistence & Restore"). Like {@link save}, the session is encoded to a
     * snapshot synchronously and the atomic write is appended to the serialized
     * write chain so it cannot interleave with an in-flight `current.json`
     * write. Archiving an empty/new session is harmless — it simply writes a
     * file named after that session's id.
     */
    archive(session: Session): Promise<void> {
        const body = this.codec.encode(session)
        const target = this.archivePath(session.id)
        const temp = `${target}.tmp`
        const run = this.writeChain.then(() => this.writeAtomic(body, target, temp))
        this.writeChain = run.catch(() => undefined)
        return run
    }

    /** Atomic write: temp file then rename over the target path. */
    private async writeAtomic(
        body: string,
        target: string = this.currentPath,
        temp: string = this.tempPath
    ): Promise<void> {
        await fs.mkdir(this.sessionsDir, { recursive: true })
        await fs.writeFile(temp, body, 'utf-8')
        await fs.rename(temp, target)
    }

    /**
     * Derive a short, human-readable title for a session. Mirrors the
     * renderer's live rule: the LATEST user question names the chat, so
     * archived rows agree with what the rail showed while the chat was open.
     */
    private titleFor(session: Session): string {
        let latestUserText: string | undefined
        for (let i = session.turns.length - 1; i >= 0; i--) {
            const t = session.turns[i]
            if (t.role === 'user' && typeof t.text === 'string' && t.text.trim().length > 0) {
                latestUserText = t.text
                break
            }
        }
        // A parked empty chat keeps reading "New chat" in the rail, exactly
        // like its pill did while it was open.
        if (session.turns.length === 0) return 'New chat'
        const raw = latestUserText ?? session.summary.inferredIntent
        const trimmed = (raw ?? '').trim()
        if (trimmed.length === 0) {
            return session.turns.some((t) => t.capture) ? 'Screen capture chat' : 'Untitled chat'
        }
        return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
    }

    /** Derive a compact, local-only description for the history rail. */
    private descriptionFor(session: Session): string {
        const lastCompleted = session.summary.completedSteps.at(-1)
        const lastAssistant = [...session.turns]
            .reverse()
            .find(
                (turn) =>
                    turn.role === 'assistant' &&
                    typeof turn.text === 'string' &&
                    turn.text.trim().length > 0
            )?.text
        const raw = lastCompleted ?? lastAssistant ?? session.summary.inferredIntent
        const compact = (raw ?? '')
            .replace(/[`*_>#\[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
        if (compact.length === 0) {
            return session.turns.length === 1 ? '1 message' : `${session.turns.length} messages`
        }
        return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact
    }

    /**
     * List past (archived) sessions, newest first, for the chat-history panel.
     * Reads every `sessions/<id>.json` file (excluding `current.json` and temp
     * files), tolerating corrupt entries by skipping them.
     */
    async listSessions(): Promise<SessionListItem[]> {
        // Settle queued archive/save writes first so a list issued right after
        // archiving (e.g. the renderer's refresh on New chat) always sees the
        // just-archived session instead of racing the rename.
        await this.flush()
        let files: string[]
        try {
            files = await fs.readdir(this.sessionsDir)
        } catch {
            return []
        }
        const items: SessionListItem[] = []
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            if (file === CURRENT_FILENAME || file.endsWith('.tmp')) continue
            try {
                const raw = await fs.readFile(join(this.sessionsDir, file), 'utf-8')
                const session = this.codec.decode(raw)
                // Skip empty sessions so never-used chats never appear in history.
                if (session.turns.length === 0) continue
                items.push({
                    id: session.id,
                    title: this.titleFor(session),
                    description: this.descriptionFor(session),
                    updatedAt: session.updatedAt,
                    turnCount: session.turns.length
                })
            } catch {
                // Skip corrupt/foreign files.
            }
        }
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return items
    }

    /** Read a single archived session by id, or null if missing/corrupt. */
    async readSessionById(id: string): Promise<Session | null> {
        try {
            const raw = await fs.readFile(this.archivePath(id), 'utf-8')
            return this.codec.decode(raw)
        } catch {
            return null
        }
    }

    /** Delete one or more archived sessions by id (best-effort per id). */
    async deleteSessions(ids: string[]): Promise<void> {
        await Promise.all(
            ids.map((id) => fs.rm(this.archivePath(id), { force: true }).catch(() => undefined))
        )
    }
}
