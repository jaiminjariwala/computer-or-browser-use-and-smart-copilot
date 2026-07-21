import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Playbook, PlaybookInput } from '@op-shared/types'

/**
 * PlaybookStore: local persistence for reusable operator task templates.
 *
 * Same durability rules as the session stores: writes are serialized on a
 * single chain and land atomically (temp file + rename), so a crash can never
 * leave a torn file, and reads issued right after a write always see it.
 * Corrupt or foreign JSON degrades to an empty list (never a crash).
 *
 * Electron-free by design so it unit-tests in plain Node; the IPC surface
 * lives in `playbooks-ipc.ts`.
 */

const PLAYBOOKS_FILE = 'operator-playbooks.json'

const AUTONOMY_LEVELS = new Set(['manual', 'supervised', 'autonomous'])
const ENVIRONMENTS = new Set(['local', 'container-desktop', 'browser'])

/** Valid 24h wall-clock `HH:MM`. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/

/** Decode a schedule block, or undefined when absent/malformed. */
function decodeSchedule(raw: unknown): Playbook['schedule'] {
    if (typeof raw !== 'object' || raw === null) return undefined
    const s = raw as Record<string, unknown>
    if (typeof s.timeOfDay !== 'string' || !TIME_OF_DAY.test(s.timeOfDay)) return undefined
    return {
        timeOfDay: s.timeOfDay,
        enabled: s.enabled === true,
        ...(typeof s.lastRunDate === 'string' ? { lastRunDate: s.lastRunDate } : {})
    }
}

/** Decode one raw entry, or null when it is not a valid Playbook. */
function decodePlaybook(raw: unknown): Playbook | null {
    if (typeof raw !== 'object' || raw === null) return null
    const p = raw as Record<string, unknown>
    if (typeof p.id !== 'string' || p.id.length === 0) return null
    if (typeof p.name !== 'string' || p.name.trim().length === 0) return null
    if (typeof p.goal !== 'string' || p.goal.trim().length === 0) return null
    if (typeof p.autonomy !== 'string' || !AUTONOMY_LEVELS.has(p.autonomy)) return null
    if (typeof p.environment !== 'string' || !ENVIRONMENTS.has(p.environment)) return null
    const stepBudget =
        typeof p.stepBudget === 'number' && Number.isFinite(p.stepBudget)
            ? Math.max(1, Math.round(p.stepBudget))
            : null
    if (stepBudget === null) return null
    const createdAt = typeof p.createdAt === 'string' ? p.createdAt : new Date(0).toISOString()
    const updatedAt = typeof p.updatedAt === 'string' ? p.updatedAt : createdAt
    const schedule = decodeSchedule(p.schedule)
    return {
        id: p.id,
        name: p.name.trim(),
        goal: p.goal.trim(),
        autonomy: p.autonomy as Playbook['autonomy'],
        stepBudget,
        environment: p.environment as Playbook['environment'],
        createdAt,
        updatedAt,
        ...(schedule ? { schedule } : {})
    }
}

/** Decode the whole file body; anything malformed degrades to []. */
export function decodePlaybooks(raw: string): Playbook[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        const list = Array.isArray(parsed)
            ? parsed
            : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { playbooks?: unknown }).playbooks)
                ? (parsed as { playbooks: unknown[] }).playbooks
                : []
        const out: Playbook[] = []
        for (const item of list) {
            const decoded = decodePlaybook(item)
            if (decoded) out.push(decoded)
        }
        return out
    } catch {
        return []
    }
}

export interface PlaybookStoreOptions {
    /** Directory the store persists under (Electron passes `userData`). */
    userDataDir: string
    /** Clock seam for deterministic tests. */
    now?: () => Date
}

export class PlaybookStore {
    private readonly file: string
    private readonly now: () => Date
    private chain: Promise<unknown> = Promise.resolve()

    constructor(options: PlaybookStoreOptions) {
        this.file = join(options.userDataDir, PLAYBOOKS_FILE)
        this.now = options.now ?? (() => new Date())
    }

    /**
     * Run `op` as one serialized unit on the store's chain. Mutations queue
     * SYNCHRONOUSLY (read-modify-write is a single unit), so a `list()` issued
     * right after an un-awaited `save()` always observes it.
     */
    private queue<T>(op: () => Promise<T>): Promise<T> {
        const result = this.chain.then(op, op)
        this.chain = result.catch(() => undefined)
        return result
    }

    /** All playbooks, most recently updated first. */
    list(): Promise<Playbook[]> {
        return this.queue(() => this.readAll())
    }

    /** Upsert (by id) and return the updated list. */
    save(input: PlaybookInput): Promise<Playbook[]> {
        return this.queue(async () => {
            const stamp = this.now().toISOString()
            const current = await this.readAll()
            const existing = input.id ? current.find((p) => p.id === input.id) : undefined
            // Schedule semantics: `undefined` and `null` both CLEAR any
            // existing schedule (explicit contract — the editor always sends
            // the full input); a provided schedule keeps the existing
            // lastRunDate so re-saving cannot re-trigger today's run.
            const schedule =
                input.schedule && TIME_OF_DAY.test(input.schedule.timeOfDay)
                    ? {
                        timeOfDay: input.schedule.timeOfDay,
                        enabled: input.schedule.enabled === true,
                        ...(existing?.schedule?.lastRunDate
                            ? { lastRunDate: existing.schedule.lastRunDate }
                            : {})
                    }
                    : undefined
            const candidate: Playbook = {
                id: existing?.id ?? input.id ?? randomUUID(),
                name: input.name.trim(),
                goal: input.goal.trim(),
                autonomy: input.autonomy,
                stepBudget: Math.max(1, Math.round(input.stepBudget)),
                environment: input.environment,
                createdAt: existing?.createdAt ?? stamp,
                updatedAt: stamp,
                ...(schedule ? { schedule } : {})
            }
            const decoded = decodePlaybook(candidate)
            if (!decoded) return current
            const next = [decoded, ...current.filter((p) => p.id !== decoded.id)]
            await this.persist(next)
            return next
        })
    }

    /** Delete by ids and return the updated list. */
    delete(ids: readonly string[]): Promise<Playbook[]> {
        return this.queue(async () => {
            const drop = new Set(ids)
            const current = await this.readAll()
            const next = current.filter((p) => !drop.has(p.id))
            if (next.length !== current.length) await this.persist(next)
            return next
        })
    }

    /**
     * Record that the scheduler started this playbook on `dateKey`
     * (`YYYY-MM-DD` local). Does NOT bump `updatedAt` — a scheduled run is not
     * a user edit and must not reorder the list.
     */
    markScheduleRun(id: string, dateKey: string): Promise<Playbook[]> {
        return this.queue(async () => {
            const current = await this.readAll()
            const target = current.find((p) => p.id === id)
            if (!target?.schedule) return current
            const next = current.map((p) =>
                p.id === id && p.schedule
                    ? { ...p, schedule: { ...p.schedule, lastRunDate: dateKey } }
                    : p
            )
            await this.persist(next)
            return next
        })
    }

    /** Raw read + decode + sort (no queueing; callers queue). */
    private async readAll(): Promise<Playbook[]> {
        let raw: string
        try {
            raw = await fs.readFile(this.file, 'utf8')
        } catch {
            return []
        }
        return decodePlaybooks(raw).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    /** Atomic write: temp file + rename (callers queue). */
    private async persist(playbooks: Playbook[]): Promise<void> {
        const body = JSON.stringify({ playbooks }, null, 2)
        const tmp = `${this.file}.tmp`
        await fs.mkdir(join(this.file, '..'), { recursive: true })
        await fs.writeFile(tmp, body, 'utf8')
        await fs.rename(tmp, this.file)
    }
}
