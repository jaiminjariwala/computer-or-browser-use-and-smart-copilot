import type { AutonomyLevel, EnvironmentId } from './session'

/**
 * A Playbook: a saved, reusable operator task template.
 *
 * Repeat tasks ("check my grades", "create a GitHub OAuth app named X") are
 * written once — goal text plus the run settings that suit it — and run with
 * one click from the operator's New-task workspace. Playbooks are plain local
 * JSON (no secrets; credentials stay in the page/session the agent drives).
 */
export interface Playbook {
    id: string
    /** Short display name shown in the playbook list. */
    name: string
    /** The goal text submitted to the agent, verbatim. */
    goal: string
    autonomy: AutonomyLevel
    stepBudget: number
    environment: EnvironmentId
    createdAt: string
    updatedAt: string
    /** Daily run schedule (absent = manual only). */
    schedule?: PlaybookSchedule
}

/**
 * A daily schedule for a playbook. Runs happen while the app is running: the
 * scheduler starts the playbook the first time it ticks past `timeOfDay` on a
 * given day (so opening the app at 14:00 still runs a 09:00 playbook once —
 * catch-up semantics, like a personal assistant would).
 */
export interface PlaybookSchedule {
    /** Local wall-clock time, 24h `HH:MM`. */
    timeOfDay: string
    enabled: boolean
    /** Local date key (`YYYY-MM-DD`) of the last scheduler-started run. */
    lastRunDate?: string
}

/** Upsert input: omitted `id` creates a new playbook. */
export interface PlaybookInput {
    id?: string
    name: string
    goal: string
    autonomy: AutonomyLevel
    stepBudget: number
    environment: EnvironmentId
    /** Daily schedule; null/undefined clears any existing schedule. */
    schedule?: { timeOfDay: string; enabled: boolean } | null
}
