import type {
    AgentSession,
    PriorSessionMemory,
    SessionListItem
} from '@op-shared/types'
import { summarizeTrajectorySteps } from './summarizer'

/** Maximum number of relevant archived session bodies loaded for one recall query. */
export const MAX_MEMORY_CANDIDATES = 24
/** Maximum number of related memories injected into one reasoning request. */
export const MAX_RECALLED_MEMORIES = 3
/** Maximum successful sub-steps retained per recalled session. */
export const MAX_RECALLED_SUB_STEPS = 6

/** Persistence seam used by {@link SessionMemory}; implemented by SessionStore. */
export interface SessionMemorySource {
    listSessions(limit?: number): Promise<SessionListItem[]>
    readSessionById(id: string): Promise<AgentSession | null>
}

export interface SessionMemoryOptions {
    maxCandidates?: number
    maxMemories?: number
}

interface MemoryRecord extends PriorSessionMemory {
    id: string
    /** One-way local relevance fingerprints; raw prior goals are not retained. */
    matchTokenHashes: number[]
}

const STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'at',
    'browser',
    'computer',
    'do',
    'for',
    'from',
    'go',
    'in',
    'it',
    'me',
    'my',
    'of',
    'on',
    'open',
    'please',
    'the',
    'this',
    'to',
    'use',
    'with'
])

/**
 * Local, bounded cross-session memory.
 *
 * Only completed sessions are eligible. Each record is projected to sanitized
 * goal/progress text and a small set of successful sub-steps; raw observations,
 * screenshots, typed Action payloads, and complete trajectories never leave the
 * store. Results are cached per goal for the duration of the active session.
 */
export class SessionMemory {
    private readonly source: SessionMemorySource
    private readonly maxCandidates: number
    private readonly maxMemories: number
    private readonly recentlyArchived = new Map<string, MemoryRecord>()
    /** Process-lifetime tombstones prevent deleted archives from being reloaded while disk removal waits/retries. */
    private readonly forgottenIds = new Set<string>()
    private readonly cache = new Map<string, Promise<PriorSessionMemory[]>>()
    /** Invalidates recalls that were already loading when memory changed. */
    private revision = 0

    constructor(source: SessionMemorySource, options: SessionMemoryOptions = {}) {
        this.source = source
        this.maxCandidates = Math.max(1, options.maxCandidates ?? MAX_MEMORY_CANDIDATES)
        this.maxMemories = Math.max(1, options.maxMemories ?? MAX_RECALLED_MEMORIES)
    }

    /** Make a just-archived completed session immediately recallable before disk I/O finishes. */
    remember(session: AgentSession): void {
        if (this.forgottenIds.has(session.id)) return
        const record = projectSessionMemory(session)
        if (record) this.recentlyArchived.set(record.id, record)
        this.revision += 1
        this.cache.clear()
    }

    /** Evict deleted archives and every cached or in-flight query that could reference them. */
    forget(ids: readonly string[]): void {
        for (const id of ids) {
            this.forgottenIds.add(id)
            this.recentlyArchived.delete(id)
        }
        this.revision += 1
        this.cache.clear()
    }

    /** Recall the most relevant successful local sessions for `goal`. */
    async recall(goal: string, excludeSessionId?: string): Promise<PriorSessionMemory[]> {
        const normalizedGoal = normalizeForMatch(goal)
        if (tokenize(normalizedGoal).size === 0) return []

        const key = `${excludeSessionId ?? ''}\u0000${normalizedGoal}`
        let pending = this.cache.get(key)
        if (!pending) {
            const requestedAtRevision = this.revision
            pending = this.loadRelated(goal, excludeSessionId).then((memories) =>
                this.revision === requestedAtRevision ? memories : []
            )
            this.cache.set(key, pending)
        }

        try {
            return (await pending).map(cloneMemory)
        } catch {
            this.cache.delete(key)
            return []
        }
    }

    private async loadRelated(
        goal: string,
        excludeSessionId?: string
    ): Promise<PriorSessionMemory[]> {
        let items: SessionListItem[] = []
        try {
            items = await this.source.listSessions(this.maxCandidates)
        } catch {
            // A missing/corrupt archive should never block the active task.
        }

        const candidates = items
            .filter(
                (item) =>
                    item.status === 'completed' &&
                    item.id !== excludeSessionId &&
                    !this.forgottenIds.has(item.id)
            )
            .map((item) => ({ item, score: memoryRelevanceScore(goal, item.goalText) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
            .slice(0, this.maxCandidates)

        // Load one archive at a time and stop once enough valid projections are
        // available. This keeps the transient footprint bounded even when old
        // local-computer sessions contain large screenshots.
        const persisted: MemoryRecord[] = []
        for (const { item } of candidates) {
            try {
                const session = await this.source.readSessionById(item.id)
                const record = session ? projectSessionMemory(session) : null
                if (record) persisted.push(record)
                if (persisted.length >= this.maxMemories) break
            } catch {
                // Skip missing/corrupt candidates without blocking recall.
            }
        }

        const records = new Map<string, MemoryRecord>()
        for (const record of persisted) records.set(record.id, record)
        // Prefer the in-memory snapshot when an archive write is still queued.
        for (const record of this.recentlyArchived.values()) {
            if (record.id !== excludeSessionId) records.set(record.id, record)
        }

        return [...records.values()]
            .map((record) => ({
                record,
                score: memoryRelevanceScoreFromHashes(goal, record.matchTokenHashes)
            }))
            .filter(({ score }) => score > 0)
            .sort(
                (a, b) =>
                    b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt)
            )
            .slice(0, this.maxMemories)
            .map(({ record }) => cloneMemory(record))
    }
}

/** Project a completed session to safe, structured summary-only memory. */
export function projectSessionMemory(session: AgentSession): MemoryRecord | null {
    if (session.status !== 'completed') return null

    // Start from an empty summary so legacy free-form rationales already stored
    // on disk cannot cross the session boundary.
    const summary = summarizeTrajectorySteps(session.trajectory, {
        goalText: '',
        inferredProgress: '',
        completedSubSteps: [],
        updatedThroughIndex: null
    })
    const completedSubSteps = summary.completedSubSteps.slice(-MAX_RECALLED_SUB_STEPS)

    return {
        id: session.id,
        matchTokenHashes: hashGoalTokens(session.goal.text),
        // Relevance is decided locally with one-way token fingerprints. The
        // provider receives only this generic label and allowlisted categories.
        goalText: 'Related completed task',
        inferredProgress: summary.inferredProgress || 'Task completed successfully.',
        completedSubSteps,
        updatedAt: session.updatedAt
    }
}

/** Similarity score based on meaningful goal-token overlap. Zero means unrelated. */
export function memoryRelevanceScore(queryGoal: string, candidateGoal: string): number {
    const query = tokenize(normalizeForMatch(queryGoal))
    const candidate = tokenize(normalizeForMatch(candidateGoal))
    if (query.size === 0 || candidate.size === 0) return 0

    let overlap = 0
    for (const token of query) {
        if (candidate.has(token)) overlap += 1
    }

    const requiredOverlap = Math.min(2, query.size)
    if (overlap < requiredOverlap) return 0

    const coverage = overlap / query.size
    const specificity = overlap / candidate.size
    const normalizedQuery = [...query].join(' ')
    const normalizedCandidate = [...candidate].join(' ')
    const phraseBonus =
        normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery)
            ? 0.2
            : 0
    return coverage * 0.7 + specificity * 0.3 + phraseBonus
}

function memoryRelevanceScoreFromHashes(queryGoal: string, hashes: readonly number[]): number {
    const query = new Set(hashGoalTokens(queryGoal))
    const candidate = new Set(hashes)
    if (query.size === 0 || candidate.size === 0) return 0

    let overlap = 0
    for (const token of query) {
        if (candidate.has(token)) overlap += 1
    }
    if (overlap < Math.min(2, query.size)) return 0
    return (overlap / query.size) * 0.7 + (overlap / candidate.size) * 0.3
}

function hashGoalTokens(goal: string): number[] {
    return [...tokenize(normalizeForMatch(goal))].map((token) => {
        // FNV-1a is sufficient for deterministic in-memory overlap checks. It
        // is not a security hash; its purpose here is to avoid retaining raw
        // prior-goal words in the recall cache.
        let hash = 0x811c9dc5
        for (let index = 0; index < token.length; index += 1) {
            hash ^= token.charCodeAt(index)
            hash = Math.imul(hash, 0x01000193)
        }
        return hash >>> 0
    })
}

function normalizeForMatch(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[^a-z0-9+#. -]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function tokenize(value: string): Set<string> {
    const tokens = value.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []
    return new Set(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)))
}

function cloneMemory(memory: PriorSessionMemory): PriorSessionMemory {
    return {
        goalText: memory.goalText,
        inferredProgress: memory.inferredProgress,
        completedSubSteps: [...memory.completedSubSteps],
        updatedAt: memory.updatedAt
    }
}
