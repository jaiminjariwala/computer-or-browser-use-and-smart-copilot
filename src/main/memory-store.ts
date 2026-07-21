import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryEntry } from '@shared/types'

/**
 * MemoryStore: the copilot's persistent, user-auditable memory.
 *
 * Small facts and preferences the user explicitly asked the assistant to keep
 * ("remember I prefer short answers") persist across chats and relaunches and
 * are folded into every completion as a system message. Design rules:
 *
 *  - EXPLICIT writes only. A memory is stored when the user says
 *    "remember ..." (deterministic prefix, no LLM guessing) or adds one in
 *    Settings. The model cannot silently write memories about the user.
 *  - Fully inspectable: plain local JSON under userData; every entry is
 *    listed in Settings and individually deletable. Nothing leaves the Mac
 *    except as context inside the user's own AI requests.
 *
 * Same durability rules as the other stores: one serialized queue, atomic
 * temp-file + rename writes, corrupt files degrade to empty (never crash).
 */

const MEMORY_FILE = 'copilot-memory.json'

/** Cap stored entries; oldest fall off so the context block stays small. */
const MAX_ENTRIES = 100

/** Cap a single memory's length (system-message hygiene). */
const MAX_TEXT_LENGTH = 500

/**
 * Deterministically extract a memory fact from a chat message.
 *
 * Recognized shapes (case-insensitive): "remember that X", "remember: X",
 * "remember, X", "remember X", "please remember X". Returns the fact text, or
 * null when the message is not a remember-command. The command must LEAD the
 * message — a passing "can you remember..." mid-sentence is a question, not a
 * write.
 */
export function extractMemoryFact(text: string): string | null {
    const match = /^\s*(?:please\s+)?remember\b[\s,:-]*(?:that\s+)?(.+)$/is.exec(text ?? '')
    if (!match) return null
    const fact = (match[1] ?? '').trim()
    if (fact.length < 3) return null
    return fact.length > MAX_TEXT_LENGTH ? `${fact.slice(0, MAX_TEXT_LENGTH - 1)}…` : fact
}

/** Decode one raw entry, or null when malformed. */
function decodeEntry(raw: unknown): MemoryEntry | null {
    if (typeof raw !== 'object' || raw === null) return null
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id.length === 0) return null
    if (typeof e.text !== 'string' || e.text.trim().length === 0) return null
    const createdAt = typeof e.createdAt === 'string' ? e.createdAt : new Date(0).toISOString()
    return { id: e.id, text: e.text.trim(), createdAt }
}

/** Decode the whole file body; anything malformed degrades to []. */
export function decodeMemories(raw: string): MemoryEntry[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        const list = Array.isArray(parsed)
            ? parsed
            : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { memories?: unknown }).memories)
                ? (parsed as { memories: unknown[] }).memories
                : []
        const out: MemoryEntry[] = []
        for (const item of list) {
            const decoded = decodeEntry(item)
            if (decoded) out.push(decoded)
        }
        return out
    } catch {
        return []
    }
}

export interface MemoryStoreOptions {
    /** Directory the store persists under (Electron passes `userData`). */
    userDataDir: string
    /** Clock seam for deterministic tests. */
    now?: () => Date
}

export class MemoryStore {
    private readonly file: string
    private readonly now: () => Date
    private chain: Promise<unknown> = Promise.resolve()

    constructor(options: MemoryStoreOptions) {
        this.file = join(options.userDataDir, MEMORY_FILE)
        this.now = options.now ?? (() => new Date())
    }

    /** Serialize whole operations so reads always observe queued writes. */
    private queue<T>(op: () => Promise<T>): Promise<T> {
        const result = this.chain.then(op, op)
        this.chain = result.catch(() => undefined)
        return result
    }

    /** All entries, newest first. */
    list(): Promise<MemoryEntry[]> {
        return this.queue(() => this.readAll())
    }

    /** Just the memory texts, oldest first (stable context ordering). */
    async texts(): Promise<string[]> {
        const entries = await this.list()
        return entries
            .slice()
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((e) => e.text)
    }

    /**
     * Add a memory (deduped case-insensitively against existing text).
     * Returns the updated list.
     */
    add(text: string): Promise<MemoryEntry[]> {
        return this.queue(async () => {
            const trimmed = text.trim()
            const current = await this.readAll()
            if (trimmed.length === 0) return current
            const clipped =
                trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH - 1)}…` : trimmed
            const duplicate = current.some((e) => e.text.toLowerCase() === clipped.toLowerCase())
            if (duplicate) return current
            const entry: MemoryEntry = {
                id: randomUUID(),
                text: clipped,
                createdAt: this.now().toISOString()
            }
            const next = [entry, ...current].slice(0, MAX_ENTRIES)
            await this.persist(next)
            return next
        })
    }

    /** Delete one entry by id. Returns the updated list. */
    delete(id: string): Promise<MemoryEntry[]> {
        return this.queue(async () => {
            const current = await this.readAll()
            const next = current.filter((e) => e.id !== id)
            if (next.length !== current.length) await this.persist(next)
            return next
        })
    }

    /** Remove every entry. */
    clear(): Promise<MemoryEntry[]> {
        return this.queue(async () => {
            await this.persist([])
            return []
        })
    }

    private async readAll(): Promise<MemoryEntry[]> {
        let raw: string
        try {
            raw = await fs.readFile(this.file, 'utf8')
        } catch {
            return []
        }
        return decodeMemories(raw).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    private async persist(memories: MemoryEntry[]): Promise<void> {
        const body = JSON.stringify({ memories }, null, 2)
        const tmp = `${this.file}.tmp`
        await fs.mkdir(join(this.file, '..'), { recursive: true })
        await fs.writeFile(tmp, body, 'utf8')
        await fs.rename(tmp, this.file)
    }
}
