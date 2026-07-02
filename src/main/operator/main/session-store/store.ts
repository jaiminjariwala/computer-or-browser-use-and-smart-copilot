import { promises as nodeFs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession, SessionListItem } from '@op-shared/types'
import { jsonAgentSessionCodec, type AgentSessionCodec } from './codec'

/**
 * Session Store — atomic persistence + restore/archive (Task 12.3).
 *
 * Persists the active {@link AgentSession} to `userData/sessions/current.json`
 * after each update and loads it back on launch (Req 18.1, 18.2). Kept separate
 * from the Session Manager so disk I/O never collides with the manager's
 * concurrent in-memory edits:
 *  - The manager fires `onSessionChanged` after each mutation; this store is
 *    wired to that hook and persists the session, serializing writes so
 *    overlapping mutations cannot interleave on disk (Req 18.1).
 *  - On launch the owning wiring calls {@link SessionStore.load} and, if a session
 *    is found, `sessionManager.restore(loaded)` (Req 18.2). Acting stays gated
 *    behind an explicit user action (Req 18.3, 18.5, Property 22).
 *  - When the user starts a new session the manager fires `onArchive(prior)`;
 *    wiring calls {@link SessionStore.archive} to preserve it (Req 18.4).
 *
 * Writes are **atomic**: the JSON is written to a temp file and renamed over the
 * target, so a crash mid-write can never leave a half-written file (Property 21
 * round-trip integrity). Reads tolerate a missing or corrupt file by returning
 * `null`, so a fresh install or a damaged file simply starts fresh; the wiring
 * then requires a new session and surfaces `restore-failed` (Req 18.6).
 *
 * Electron-free: base directory, filesystem, and codec are all injectable so the
 * persist->load round-trip and the corrupt/missing paths can be unit-tested
 * against a temp directory without any Electron APIs.
 */

// Distinct from Click Copilot's own `sessions/` directory — the merged operator
// engine shares the same `userData` dir, so its (differently-shaped) sessions
// live under their own directory to avoid clobbering the host app's chats.
const SESSIONS_DIRNAME = 'operator-sessions'
const CURRENT_FILENAME = 'current.json'
/** Temp file written before the atomic rename onto {@link CURRENT_FILENAME}. */
const TEMP_FILENAME = 'current.json.tmp'

/** The subset of `fs.promises` the store needs. Injectable for tests. */
export interface SessionFs {
    readFile(path: string, encoding: 'utf-8'): Promise<string>
    writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
    readdir(path: string): Promise<string[]>
    rm(path: string, options: { force: true }): Promise<void>
}

export interface SessionStoreOptions {
    /**
     * Directory to store files in. Defaults to `~/.click-operator` so the module
     * stays Electron-free; the app wiring injects `app.getPath('userData')`.
     */
    userDataDir?: string
    /** Filesystem seam. Defaults to `node:fs` promises. */
    fs?: SessionFs
    /** Serialization seam. Defaults to {@link jsonAgentSessionCodec}. */
    codec?: AgentSessionCodec
}

export class SessionStore {
    private readonly dir: string
    private readonly fs: SessionFs
    private readonly codec: AgentSessionCodec
    /**
     * Serializes writes so overlapping `onSessionChanged` calls cannot interleave
     * the temp-write/rename of two saves. Each save encodes a snapshot of the
     * session *synchronously* and only the file I/O is queued, so later in-memory
     * mutations never corrupt an in-flight write.
     */
    private writeChain: Promise<void> = Promise.resolve()

    constructor(options: SessionStoreOptions = {}) {
        this.dir = options.userDataDir ?? join(homedir(), '.click-operator')
        this.fs = options.fs ?? (nodeFs as unknown as SessionFs)
        this.codec = options.codec ?? jsonAgentSessionCodec
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
     * Load the persisted active session, or `null` if none is stored or the file
     * is missing/corrupt (Req 18.2, 18.6). Never throws for the missing/corrupt
     * cases so launch can require a new session instead of crashing.
     */
    async load(): Promise<AgentSession | null> {
        let raw: string
        try {
            raw = await this.fs.readFile(this.currentPath, 'utf-8')
        } catch {
            return null
        }
        try {
            return this.codec.decode(raw)
        } catch {
            return null
        }
    }

    /**
     * Persist the session to `current.json` after an update (Req 18.1). The
     * session is encoded synchronously (a snapshot of its current state) and the
     * atomic file write is appended to the serialized write chain. The returned
     * promise resolves when *this* write has flushed; fire-and-forget callers (the
     * `onSessionChanged` hook) may ignore it.
     */
    save(session: AgentSession): Promise<void> {
        const body = this.codec.encode(session)
        const run = this.writeChain.then(() => this.writeAtomic(body))
        // Keep the chain alive even if a write fails so one failure doesn't wedge
        // later saves; the failure still surfaces to the caller of *this* save.
        this.writeChain = run.catch(() => undefined)
        return run
    }

    /** Await all queued writes. For tests and graceful shutdown. */
    async flush(): Promise<void> {
        await this.writeChain
    }

    /**
     * Archive a session to `sessions/<id>.json` so the prior conversation is
     * preserved when the user starts a new session (Req 18.4). Encoded to a
     * snapshot synchronously; the atomic write is appended to the serialized write
     * chain so it cannot interleave with an in-flight `current.json` write.
     */
    archive(session: AgentSession): Promise<void> {
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
        await this.fs.mkdir(this.sessionsDir, { recursive: true })
        await this.fs.writeFile(temp, body, 'utf-8')
        await this.fs.rename(temp, target)
    }

    /** Derive a short, human-readable title for a session from its Goal. */
    private titleFor(session: AgentSession): string {
        const raw = session.goal.text.trim()
        if (raw.length === 0) return 'Untitled task'
        return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
    }

    /**
     * List archived sessions, newest first, for the session-history panel
     * (`session:list`). Reads every `sessions/<id>.json` file (excluding
     * `current.json` and temp files), tolerating corrupt entries by skipping them.
     */
    async listSessions(): Promise<SessionListItem[]> {
        let files: string[]
        try {
            files = await this.fs.readdir(this.sessionsDir)
        } catch {
            return []
        }
        const items: SessionListItem[] = []
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            if (file === CURRENT_FILENAME || file.endsWith('.tmp')) continue
            try {
                const raw = await this.fs.readFile(join(this.sessionsDir, file), 'utf-8')
                const session = this.codec.decode(raw)
                items.push({
                    id: session.id,
                    goalText: this.titleFor(session),
                    status: session.status,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt
                })
            } catch {
                // Skip corrupt/foreign files.
            }
        }
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return items
    }

    /**
     * Read a single archived session by id for `session:open` (Req 18.5), or
     * `null` if missing/corrupt. The caller (manager) still requires an explicit
     * user action before any further Action (Property 22).
     */
    async readSessionById(id: string): Promise<AgentSession | null> {
        try {
            const raw = await this.fs.readFile(this.archivePath(id), 'utf-8')
            return this.codec.decode(raw)
        } catch {
            return null
        }
    }

    /** Delete one or more archived sessions by id (best-effort per id). */
    async deleteSessions(ids: string[]): Promise<void> {
        await Promise.all(
            ids.map((id) => this.fs.rm(this.archivePath(id), { force: true }).catch(() => undefined))
        )
    }
}
