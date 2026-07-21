import type { Playbook } from '@op-shared/types'
import type { PlaybookStore } from './playbooks'

/**
 * Playbook scheduler: "run this playbook daily at HH:MM (while the app runs)".
 *
 * A lightweight main-process ticker (default 30s). On each tick it scans the
 * playbooks for enabled schedules that are DUE and starts them through the
 * exact same start-gate path a user click takes, so every safety property
 * (fail-closed gate, budgets, confirmation flow) applies to unattended runs
 * unchanged. Notifications (task 1) then cover completion/failure/help
 * banners automatically.
 *
 * Due semantics (catch-up): a schedule fires the FIRST tick at or after its
 * `timeOfDay` on a given local day, once per day (`lastRunDate` guard). The
 * app being closed at the scheduled minute just means the run starts when the
 * app next ticks that day — like an assistant catching up on its morning list.
 *
 * One run at a time: if the agent loop is busy the due run is left pending;
 * `lastRunDate` is only stamped when a run actually STARTS, so a later tick
 * retries the same day.
 */

/** Local date key `YYYY-MM-DD` (schedules are wall-clock local). */
export function localDateKey(now: Date): string {
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/** Minutes since local midnight for a `HH:MM` string, or null when invalid. */
function minutesOf(timeOfDay: string): number | null {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay)
    if (!match) return null
    return Number(match[1]) * 60 + Number(match[2])
}

/** True when an enabled schedule should fire at `now` (pure, unit-tested). */
export function isScheduleDue(playbook: Playbook, now: Date): boolean {
    const schedule = playbook.schedule
    if (!schedule?.enabled) return false
    const due = minutesOf(schedule.timeOfDay)
    if (due === null) return false
    if (schedule.lastRunDate === localDateKey(now)) return false
    const current = now.getHours() * 60 + now.getMinutes()
    return current >= due
}

export interface PlaybookSchedulerDeps {
    store: PlaybookStore
    /** True while the agent loop is mid-run (a due run waits, not stacks). */
    isBusy: () => boolean
    /**
     * Start the playbook through the normal start-gate path. Resolves true
     * when the run actually started (stamps `lastRunDate`).
     */
    runPlaybook: (playbook: Playbook) => Promise<boolean>
    /** Optional banner when a scheduled run starts. */
    onStarted?: (playbook: Playbook) => void
    now?: () => Date
    intervalMs?: number
}

export interface PlaybookScheduler {
    start(): void
    stop(): void
    /** One scan pass (exposed for tests; `start` calls it on an interval). */
    tick(): Promise<void>
}

export function createPlaybookScheduler(deps: PlaybookSchedulerDeps): PlaybookScheduler {
    const now = deps.now ?? (() => new Date())
    const intervalMs = deps.intervalMs ?? 30_000
    let timer: ReturnType<typeof setInterval> | null = null
    let scanning = false

    const tick = async (): Promise<void> => {
        // A slow scan (starting a run awaits the start gate) must not overlap
        // the next interval tick, or one due schedule could start twice.
        if (scanning) return
        scanning = true
        try {
            const current = now()
            const playbooks = await deps.store.list()
            const due = playbooks.filter((pb) => isScheduleDue(pb, current))
            if (due.length === 0) return
            // One at a time; the rest stay due and start on later ticks.
            if (deps.isBusy()) return
            const pick = due[0]
            if (!pick) return
            const started = await deps.runPlaybook(pick).catch(() => false)
            if (started) {
                await deps.store.markScheduleRun(pick.id, localDateKey(current))
                deps.onStarted?.(pick)
            }
        } catch {
            // Scheduling is best-effort; a failed scan retries next tick.
        } finally {
            scanning = false
        }
    }

    return {
        start: () => {
            if (timer) return
            timer = setInterval(() => {
                void tick()
            }, intervalMs)
            // First scan shortly after launch (catch up without waiting 30s).
            void tick()
        },
        stop: () => {
            if (timer) clearInterval(timer)
            timer = null
        },
        tick
    }
}
