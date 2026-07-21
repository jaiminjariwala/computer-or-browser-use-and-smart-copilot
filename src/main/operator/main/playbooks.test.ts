import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { PlaybookStore, decodePlaybooks } from './playbooks'
import type { PlaybookInput } from '@op-shared/types'

function input(overrides: Partial<PlaybookInput> = {}): PlaybookInput {
    return {
        name: 'Check grades',
        goal: 'Go to the portal, log in, read my grades table.',
        autonomy: 'autonomous',
        stepBudget: 25,
        environment: 'browser',
        ...overrides
    }
}

describe('PlaybookStore', () => {
    let dir: string
    let store: PlaybookStore
    let tick: number

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'playbooks-'))
        tick = 0
        store = new PlaybookStore({
            userDataDir: dir,
            now: () => new Date(1752000000000 + ++tick * 1000)
        })
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('starts empty when no file exists', async () => {
        expect(await store.list()).toEqual([])
    })

    it('saves a playbook and lists it back', async () => {
        const list = await store.save(input({}))
        expect(list).toHaveLength(1)
        expect(list[0]).toMatchObject({
            name: 'Check grades',
            autonomy: 'autonomous',
            stepBudget: 25,
            environment: 'browser'
        })
        expect((await store.list())[0]?.id).toBe(list[0]?.id)
    })

    it('upserts by id and floats the updated playbook to the top', async () => {
        const [first] = await store.save(input({ name: 'A' }))
        await store.save(input({ name: 'B' }))
        const updated = await store.save(input({ id: first?.id, name: 'A renamed' }))
        expect(updated).toHaveLength(2)
        expect(updated[0]?.name).toBe('A renamed')
        expect(updated[0]?.id).toBe(first?.id)
        expect(updated[0]?.createdAt).toBe(first?.createdAt)
    })

    it('deletes by id', async () => {
        const [a] = await store.save(input({ name: 'A' }))
        await store.save(input({ name: 'B' }))
        const after = await store.delete([a?.id ?? ''])
        expect(after).toHaveLength(1)
        expect(after[0]?.name).toBe('B')
    })

    it('lists immediately after an un-awaited save (no write race)', async () => {
        void store.save(input({ name: 'raced' }))
        const list = await store.list()
        expect(list.map((p) => p.name)).toContain('raced')
    })

    it('degrades a corrupt file to an empty list', async () => {
        await fs.writeFile(join(dir, 'operator-playbooks.json'), '{not json', 'utf8')
        expect(await store.list()).toEqual([])
    })

    it('leaves no temp file behind', async () => {
        await store.save(input({}))
        await expect(fs.stat(join(dir, 'operator-playbooks.json.tmp'))).rejects.toMatchObject({
            code: 'ENOENT'
        })
    })

    it('clamps a fractional/low step budget to a sane integer', async () => {
        const [pb] = await store.save(input({ stepBudget: 0.4 }))
        expect(pb?.stepBudget).toBe(1)
    })

    it('persists a schedule, preserves lastRunDate across edits, and clears on null', async () => {
        const [saved] = await store.save(
            input({ schedule: { timeOfDay: '09:30', enabled: true } })
        )
        expect(saved?.schedule).toEqual({ timeOfDay: '09:30', enabled: true })

        await store.markScheduleRun(saved?.id ?? '', '2026-07-20')
        const [afterRun] = await store.list()
        expect(afterRun?.schedule?.lastRunDate).toBe('2026-07-20')

        // Re-saving with a schedule keeps the run stamp (no double-fire today).
        const [edited] = await store.save(
            input({ id: saved?.id, name: 'renamed', schedule: { timeOfDay: '09:30', enabled: false } })
        )
        expect(edited?.schedule).toEqual({
            timeOfDay: '09:30',
            enabled: false,
            lastRunDate: '2026-07-20'
        })

        // Null clears the schedule entirely.
        const [cleared] = await store.save(input({ id: saved?.id, schedule: null }))
        expect(cleared?.schedule).toBeUndefined()
    })

    it('rejects a malformed schedule time on save', async () => {
        const [pb] = await store.save(input({ schedule: { timeOfDay: '25:99', enabled: true } }))
        expect(pb?.schedule).toBeUndefined()
    })
})

describe('decodePlaybooks', () => {
    it('skips malformed entries and keeps valid ones', () => {
        const body = JSON.stringify({
            playbooks: [
                {
                    id: 'ok',
                    name: 'Valid',
                    goal: 'do a thing',
                    autonomy: 'supervised',
                    stepBudget: 10,
                    environment: 'local',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z'
                },
                { id: 'bad', name: '', goal: 'x', autonomy: 'autonomous', stepBudget: 5, environment: 'browser' },
                { id: 'worse', name: 'n', goal: 'g', autonomy: 'yolo', stepBudget: 5, environment: 'browser' },
                'not-an-object'
            ]
        })
        const decoded = decodePlaybooks(body)
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.id).toBe('ok')
    })

    it('accepts a bare array body', () => {
        const decoded = decodePlaybooks(
            JSON.stringify([
                {
                    id: 'a',
                    name: 'n',
                    goal: 'g',
                    autonomy: 'manual',
                    stepBudget: 3,
                    environment: 'container-desktop'
                }
            ])
        )
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.environment).toBe('container-desktop')
    })
})
