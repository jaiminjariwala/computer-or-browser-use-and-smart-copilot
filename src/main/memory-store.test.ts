import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { MemoryStore, decodeMemories, extractMemoryFact } from './memory-store'

describe('extractMemoryFact', () => {
    it('extracts "remember that X"', () => {
        expect(extractMemoryFact('remember that I prefer short answers')).toBe(
            'I prefer short answers'
        )
    })

    it('extracts "remember: X", "remember, X" and bare "remember X"', () => {
        expect(extractMemoryFact('Remember: my GWU id is G123')).toBe('my GWU id is G123')
        expect(extractMemoryFact('remember, I use pnpm not npm')).toBe('I use pnpm not npm')
        expect(extractMemoryFact('remember I live in Seattle')).toBe('I live in Seattle')
    })

    it('accepts a leading "please"', () => {
        expect(extractMemoryFact('please remember I am vegetarian')).toBe('I am vegetarian')
    })

    it('is not fooled by mid-sentence mentions or questions', () => {
        expect(extractMemoryFact('do you remember what I said?')).toBeNull()
        expect(extractMemoryFact('can you remember things?')).toBeNull()
        expect(extractMemoryFact('what do you remember')).toBeNull()
    })

    it('rejects empty or trivially short facts', () => {
        expect(extractMemoryFact('remember')).toBeNull()
        expect(extractMemoryFact('remember  ')).toBeNull()
        expect(extractMemoryFact('remember ok')).toBeNull()
    })

    it('clips very long facts', () => {
        const fact = extractMemoryFact(`remember that ${'x'.repeat(900)}`)
        expect(fact).not.toBeNull()
        expect((fact ?? '').length).toBeLessThanOrEqual(500)
    })
})

describe('MemoryStore', () => {
    let dir: string
    let store: MemoryStore
    let tick: number

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'memory-'))
        tick = 0
        store = new MemoryStore({
            userDataDir: dir,
            now: () => new Date(1752000000000 + ++tick * 1000)
        })
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('starts empty and adds entries newest-first', async () => {
        expect(await store.list()).toEqual([])
        await store.add('first fact')
        const list = await store.add('second fact')
        expect(list.map((e) => e.text)).toEqual(['second fact', 'first fact'])
    })

    it('exposes texts oldest-first for stable prompt ordering', async () => {
        await store.add('first fact')
        await store.add('second fact')
        expect(await store.texts()).toEqual(['first fact', 'second fact'])
    })

    it('dedupes case-insensitively', async () => {
        await store.add('I prefer dark mode')
        const list = await store.add('i PREFER dark mode')
        expect(list).toHaveLength(1)
    })

    it('deletes by id and clears everything', async () => {
        const [entry] = await store.add('disposable')
        await store.add('keeper')
        const afterDelete = await store.delete(entry?.id ?? '')
        expect(afterDelete.map((e) => e.text)).toEqual(['keeper'])
        expect(await store.clear()).toEqual([])
        expect(await store.list()).toEqual([])
    })

    it('lists immediately after an un-awaited add (no write race)', async () => {
        void store.add('raced fact')
        const list = await store.list()
        expect(list.map((e) => e.text)).toContain('raced fact')
    })

    it('degrades a corrupt file to empty', async () => {
        await fs.writeFile(join(dir, 'copilot-memory.json'), 'not json at all', 'utf8')
        expect(await store.list()).toEqual([])
    })

    it('caps stored entries at 100 (oldest dropped)', async () => {
        for (let i = 0; i < 105; i++) {
            await store.add(`fact number ${i}`)
        }
        const list = await store.list()
        expect(list).toHaveLength(100)
        expect(list[0]?.text).toBe('fact number 104')
        expect(list.some((e) => e.text === 'fact number 0')).toBe(false)
    })
})

describe('decodeMemories', () => {
    it('skips malformed entries', () => {
        const body = JSON.stringify({
            memories: [
                { id: 'ok', text: 'valid', createdAt: '2026-01-01T00:00:00.000Z' },
                { id: '', text: 'no id' },
                { id: 'x', text: '   ' },
                42
            ]
        })
        const decoded = decodeMemories(body)
        expect(decoded).toHaveLength(1)
        expect(decoded[0]?.text).toBe('valid')
    })
})
