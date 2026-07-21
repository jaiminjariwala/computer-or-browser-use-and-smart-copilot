import { describe, it, expect, vi } from 'vitest'
import { createPlaybookScheduler, isScheduleDue, localDateKey } from './scheduler'
import type { Playbook } from '@op-shared/types'
import type { PlaybookStore } from './playbooks'

function playbook(overrides: Partial<Playbook> = {}): Playbook {
    return {
        id: 'pb-1',
        name: 'Morning check',
        goal: 'check my grades',
        autonomy: 'autonomous',
        stepBudget: 25,
        environment: 'browser',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        schedule: { timeOfDay: '09:00', enabled: true },
        ...overrides
    }
}

/** Local-time date builder (schedules are wall-clock local). */
function at(hours: number, minutes: number): Date {
    return new Date(2026, 6, 20, hours, minutes, 0)
}

describe('isScheduleDue', () => {
    it('fires at and after the scheduled minute, not before', () => {
        expect(isScheduleDue(playbook({}), at(8, 59))).toBe(false)
        expect(isScheduleDue(playbook({}), at(9, 0))).toBe(true)
        expect(isScheduleDue(playbook({}), at(14, 30))).toBe(true)
    })

    it('never fires when disabled or unscheduled', () => {
        expect(
            isScheduleDue(playbook({ schedule: { timeOfDay: '09:00', enabled: false } }), at(10, 0))
        ).toBe(false)
        const manual = playbook({})
        delete manual.schedule
        expect(isScheduleDue(manual, at(10, 0))).toBe(false)
    })

    it('fires at most once per local day (lastRunDate guard)', () => {
        const ranToday = playbook({
            schedule: { timeOfDay: '09:00', enabled: true, lastRunDate: localDateKey(at(9, 5)) }
        })
        expect(isScheduleDue(ranToday, at(15, 0))).toBe(false)
        const ranYesterday = playbook({
            schedule: { timeOfDay: '09:00', enabled: true, lastRunDate: '2026-07-19' }
        })
        expect(isScheduleDue(ranYesterday, at(9, 30))).toBe(true)
    })
})

describe('createPlaybookScheduler', () => {
    function makeStore(playbooks: Playbook[]): {
        store: PlaybookStore
        marked: Array<{ id: string; date: string }>
    } {
        const marked: Array<{ id: string; date: string }> = []
        const store = {
            list: async () => playbooks,
            markScheduleRun: async (id: string, date: string) => {
                marked.push({ id, date })
                return playbooks
            }
        } as unknown as PlaybookStore
        return { store, marked }
    }

    it('starts a due playbook and stamps lastRunDate', async () => {
        const { store, marked } = makeStore([playbook({})])
        const runPlaybook = vi.fn(async () => true)
        const onStarted = vi.fn()
        const scheduler = createPlaybookScheduler({
            store,
            isBusy: () => false,
            runPlaybook,
            onStarted,
            now: () => at(9, 1)
        })
        await scheduler.tick()
        expect(runPlaybook).toHaveBeenCalledTimes(1)
        expect(marked).toEqual([{ id: 'pb-1', date: '2026-07-20' }])
        expect(onStarted).toHaveBeenCalledTimes(1)
    })

    it('waits (no stamp) while the agent is busy, so the run retries later', async () => {
        const { store, marked } = makeStore([playbook({})])
        const runPlaybook = vi.fn(async () => true)
        const scheduler = createPlaybookScheduler({
            store,
            isBusy: () => true,
            runPlaybook,
            now: () => at(9, 1)
        })
        await scheduler.tick()
        expect(runPlaybook).not.toHaveBeenCalled()
        expect(marked).toEqual([])
    })

    it('does not stamp when the start gate rejects the run', async () => {
        const { store, marked } = makeStore([playbook({})])
        const scheduler = createPlaybookScheduler({
            store,
            isBusy: () => false,
            runPlaybook: async () => false,
            now: () => at(9, 1)
        })
        await scheduler.tick()
        expect(marked).toEqual([])
    })

    it('ignores playbooks that are not due', async () => {
        const { store } = makeStore([
            playbook({ schedule: { timeOfDay: '23:00', enabled: true } })
        ])
        const runPlaybook = vi.fn(async () => true)
        const scheduler = createPlaybookScheduler({
            store,
            isBusy: () => false,
            runPlaybook,
            now: () => at(9, 1)
        })
        await scheduler.tick()
        expect(runPlaybook).not.toHaveBeenCalled()
    })

    it('starts at most one run per tick', async () => {
        const { store, marked } = makeStore([
            playbook({ id: 'a' }),
            playbook({ id: 'b' })
        ])
        const runPlaybook = vi.fn(async () => true)
        const scheduler = createPlaybookScheduler({
            store,
            isBusy: () => false,
            runPlaybook,
            now: () => at(9, 1)
        })
        await scheduler.tick()
        expect(runPlaybook).toHaveBeenCalledTimes(1)
        expect(marked).toHaveLength(1)
    })
})
