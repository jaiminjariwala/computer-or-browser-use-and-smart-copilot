import { containsSensitiveText } from './privacy'

export type OperatorEnvironment = 'browser' | 'container-desktop' | 'local'

export interface OperatorTaskTemplate {
    id: string
    label: string
    description: string
    goal: string
    environment: OperatorEnvironment
    source: 'built-in' | 'recent'
}

const STORAGE_KEY = 'computer-use.recent-task-templates.v2'
const LEGACY_PERSISTENT_STORAGE_KEY = 'computer-use.recent-task-templates.v1'
const MAX_RECENT_TEMPLATES = 5
const MAX_GOAL_LENGTH = 600

/** Editable starter prompts; selecting one fills the composer but never starts it. */
export const BUILT_IN_TASK_TEMPLATES: readonly OperatorTaskTemplate[] = [
    {
        id: 'research-tabs',
        label: 'Research across tabs',
        description: 'Compare several sources without losing your place.',
        goal:
            'Research [topic] using at least three trustworthy sources in separate browser tabs. Compare the key findings, note meaningful disagreements, and finish with a concise summary.',
        environment: 'browser',
        source: 'built-in'
    },
    {
        id: 'compare-options',
        label: 'Compare options',
        description: 'Open each option separately and compare the same criteria.',
        goal:
            'Compare [option A] and [option B] in separate browser tabs using [criteria]. Verify the important details from primary sources and summarize the trade-offs without purchasing or submitting anything.',
        environment: 'browser',
        source: 'built-in'
    },
    {
        id: 'safe-form',
        label: 'Fill a form safely',
        description: 'Complete fields, validate them, and stop before submission.',
        goal:
            'Open [form URL], fill the form using the information I provide, validate all required fields, and stop before the final submission so I can review and approve it.',
        environment: 'browser',
        source: 'built-in'
    }
]

interface StoredRecentTemplate {
    id: string
    goal: string
    environment: OperatorEnvironment
    updatedAt: string
}

/** Load recent submitted operator goals. Corrupt or unavailable storage fails empty. */
export function loadRecentTaskTemplates(storage: Storage | null = browserStorage()): OperatorTaskTemplate[] {
    if (!storage) return []
    try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter(isStoredTemplate)
            .slice(0, MAX_RECENT_TEMPLATES)
            .map((item) => ({
                id: item.id,
                label: conciseLabel(item.goal),
                description: 'Run this recent goal again or edit it first.',
                goal: item.goal,
                environment: item.environment,
                source: 'recent' as const
            }))
    } catch {
        return []
    }
}

/** Store a submitted goal as a reusable recent template and return the new list. */
export function rememberRecentTaskTemplate(
    goal: string,
    environment: OperatorEnvironment,
    storage: Storage | null = browserStorage()
): OperatorTaskTemplate[] {
    const normalizedGoal = goal.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_LENGTH)
    if (
        !storage ||
        normalizedGoal.length === 0 ||
        containsSensitiveText(normalizedGoal)
    ) {
        return loadRecentTaskTemplates(storage)
    }

    const existing = loadStored(storage).filter(
        (item) => item.goal.toLocaleLowerCase() !== normalizedGoal.toLocaleLowerCase()
    )
    const recent: StoredRecentTemplate = {
        id: `recent-${Date.now().toString(36)}`,
        goal: normalizedGoal,
        environment,
        updatedAt: new Date().toISOString()
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify([recent, ...existing].slice(0, MAX_RECENT_TEMPLATES)))
    } catch {
        // Storage is optional; the task itself must still start.
    }
    return loadRecentTaskTemplates(storage)
}

/** Clear every recent goal when operator history is explicitly deleted. */
export function clearRecentTaskTemplates(
    storage: Storage | null = browserStorage()
): OperatorTaskTemplate[] {
    try {
        storage?.removeItem(STORAGE_KEY)
    } catch {
        // Optional UI state must never block history deletion.
    }
    return []
}

function loadStored(storage: Storage): StoredRecentTemplate[] {
    try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown
        return Array.isArray(parsed) ? parsed.filter(isStoredTemplate) : []
    } catch {
        return []
    }
}

function isStoredTemplate(value: unknown): value is StoredRecentTemplate {
    if (!value || typeof value !== 'object') return false
    const item = value as Partial<StoredRecentTemplate>
    return (
        typeof item.id === 'string' &&
        typeof item.goal === 'string' &&
        item.goal.trim().length > 0 &&
        item.goal.length <= MAX_GOAL_LENGTH &&
        !containsSensitiveText(item.goal) &&
        typeof item.updatedAt === 'string' &&
        (item.environment === 'browser' ||
            item.environment === 'container-desktop' ||
            item.environment === 'local')
    )
}

function conciseLabel(goal: string): string {
    const compact = goal.replace(/\s+/g, ' ').trim()
    return compact.length <= 44 ? compact : `${compact.slice(0, 43).trimEnd()}…`
}

function browserStorage(): Storage | null {
    try {
        if (typeof window === 'undefined') return null
        // Recent goals are session-scoped rather than durable across app restarts.
        // Remove the older persistent key once so prior versions do not leave a
        // stale derived copy behind in localStorage.
        window.localStorage.removeItem(LEGACY_PERSISTENT_STORAGE_KEY)
        return window.sessionStorage
    } catch {
        return null
    }
}
