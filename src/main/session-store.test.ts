import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@shared/types'

// Electron is unavailable in the Vitest (node) environment. The store reads
// `app.getPath('userData')` only as a default; tests inject a temp dir, so this
// mock just satisfies the import-time dependency.
vi.mock('electron', () => ({
    app: { getPath: () => tmpdir() }
}))

import { SessionStore, jsonSessionCodec, type SessionCodec } from './session-store'

/** Build a representative session for round-trip assertions. */
function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sess-1',
        turns: [
            {
                id: 't1',
                role: 'user',
                text: 'how do I attach a policy?',
                createdAt: '2024-01-01T00:00:00.000Z',
                status: 'ok'
            },
            {
                id: 't2',
                role: 'assistant',
                text: 'Open the IAM console and choose Roles.',
                createdAt: '2024-01-01T00:00:01.000Z',
                status: 'ok'
            }
        ],
        summary: {
            inferredIntent: 'grant DynamoDB + Lambda permissions',
            completedSteps: ['opened IAM console'],
            updatedThroughTurnId: 't1'
        },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:01.000Z',
        ...overrides
    }
}

const SESSIONS_DIR = 'sessions'
const CURRENT = 'current.json'

describe('SessionStore', () => {
    let dir: string
    let store: SessionStore

    beforeEach(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'glass-session-'))
        store = new SessionStore({ userDataDir: dir })
    })

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true })
    })

    describe('persist -> load round-trip', () => {
        it('returns null when nothing has been persisted', async () => {
            expect(await store.load()).toBeNull()
        })

        it('saves the session and loads back an equal value', async () => {
            const session = makeSession()
            await store.save(session)
            const loaded = await store.load()
            expect(loaded).toEqual(session)
        })

        it('writes to sessions/current.json under the injected dir', async () => {
            await store.save(makeSession())
            const raw = await fs.readFile(join(dir, SESSIONS_DIR, CURRENT), 'utf-8')
            expect(JSON.parse(raw)).toEqual(makeSession())
        })

        it('creates the sessions directory if it does not exist', async () => {
            // Directory does not exist yet; save must create it.
            await store.save(makeSession())
            const stat = await fs.stat(join(dir, SESSIONS_DIR))
            expect(stat.isDirectory()).toBe(true)
        })

        it('overwrites a previous session on subsequent saves', async () => {
            await store.save(makeSession({ id: 'first' }))
            await store.save(makeSession({ id: 'second' }))
            const loaded = await store.load()
            expect(loaded?.id).toBe('second')
        })

        it('round-trips an empty session (no turns)', async () => {
            const empty = makeSession({
                turns: [],
                summary: { inferredIntent: '', completedSteps: [], updatedThroughTurnId: null }
            })
            await store.save(empty)
            expect(await store.load()).toEqual(empty)
        })

        it('round-trips a turn carrying a capture', async () => {
            const session = makeSession({
                turns: [
                    {
                        id: 'tc',
                        role: 'user',
                        createdAt: '2024-01-01T00:00:02.000Z',
                        status: 'ok',
                        capture: {
                            dataUrl: 'data:image/png;base64,AAAA',
                            thumbnailUrl: 'data:image/png;base64,BBBB',
                            rect: { x: 1, y: 2, width: 3, height: 4 }
                        }
                    }
                ]
            })
            await store.save(session)
            expect(await store.load()).toEqual(session)
        })
    })

    describe('corrupt / missing file handling', () => {
        it('returns null for a missing file', async () => {
            expect(await store.load()).toBeNull()
        })

        it('returns null for invalid JSON', async () => {
            await fs.mkdir(join(dir, SESSIONS_DIR), { recursive: true })
            await fs.writeFile(join(dir, SESSIONS_DIR, CURRENT), '{ not valid json', 'utf-8')
            expect(await store.load()).toBeNull()
        })

        it('returns null for well-formed JSON that is not a Session', async () => {
            await fs.mkdir(join(dir, SESSIONS_DIR), { recursive: true })
            await fs.writeFile(
                join(dir, SESSIONS_DIR, CURRENT),
                JSON.stringify({ foo: 'bar' }),
                'utf-8'
            )
            expect(await store.load()).toBeNull()
        })

        it('returns null when turns are malformed', async () => {
            await fs.mkdir(join(dir, SESSIONS_DIR), { recursive: true })
            const bad = { ...makeSession(), turns: [{ id: 5, role: 'user' }] }
            await fs.writeFile(join(dir, SESSIONS_DIR, CURRENT), JSON.stringify(bad), 'utf-8')
            expect(await store.load()).toBeNull()
        })

        it('recovers a valid session after a previously corrupt file', async () => {
            await fs.mkdir(join(dir, SESSIONS_DIR), { recursive: true })
            await fs.writeFile(join(dir, SESSIONS_DIR, CURRENT), 'garbage', 'utf-8')
            expect(await store.load()).toBeNull()
            // A subsequent valid save repairs the file.
            await store.save(makeSession())
            expect(await store.load()).toEqual(makeSession())
        })
    })

    describe('atomic + serialized writes', () => {
        it('leaves no temp file behind after a save', async () => {
            await store.save(makeSession())
            await expect(
                fs.stat(join(dir, SESSIONS_DIR, 'current.json.tmp'))
            ).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('serializes concurrent saves so the last write wins', async () => {
            // Fire several saves without awaiting individually; the serialized
            // write chain must apply them in order and end on the last value.
            const saves = [
                store.save(makeSession({ id: 'a' })),
                store.save(makeSession({ id: 'b' })),
                store.save(makeSession({ id: 'c' }))
            ]
            await Promise.all(saves)
            await store.flush()
            const loaded = await store.load()
            expect(loaded?.id).toBe('c')
        })

        it('snapshots the session at save time, ignoring later mutation', async () => {
            const session = makeSession({ id: 'snapshot' })
            const pending = store.save(session)
            // Mutate the live object after queuing the save.
            session.id = 'mutated-after'
            session.turns.push({
                id: 'late',
                role: 'user',
                text: 'late',
                createdAt: '2024-01-01T00:00:09.000Z',
                status: 'ok'
            })
            await pending
            const loaded = await store.load()
            expect(loaded?.id).toBe('snapshot')
            expect(loaded?.turns).toHaveLength(2)
        })

        it('keeps the write chain usable after a failing write', async () => {
            const failing: SessionCodec = {
                encode: () => {
                    throw new Error('encode boom')
                },
                decode: jsonSessionCodec.decode
            }
            const flaky = new SessionStore({ userDataDir: dir, codec: failing })
            // encode throws synchronously inside save; guard the call.
            expect(() => flaky.save(makeSession())).toThrow('encode boom')

            // A healthy store still works against the same dir.
            await store.save(makeSession({ id: 'after-failure' }))
            expect((await store.load())?.id).toBe('after-failure')
        })
    })

    describe('archive', () => {
        it('writes the session to sessions/<id>.json under the injected dir', async () => {
            const session = makeSession({ id: 'archived-1' })
            await store.archive(session)
            const raw = await fs.readFile(
                join(dir, SESSIONS_DIR, 'archived-1.json'),
                'utf-8'
            )
            expect(JSON.parse(raw)).toEqual(session)
        })

        it('round-trips an archived session through the codec', async () => {
            const session = makeSession({ id: 'archived-2' })
            await store.archive(session)
            const raw = await fs.readFile(
                join(dir, SESSIONS_DIR, 'archived-2.json'),
                'utf-8'
            )
            expect(jsonSessionCodec.decode(raw)).toEqual(session)
        })

        it('creates the sessions directory if it does not exist', async () => {
            await store.archive(makeSession({ id: 'archived-3' }))
            const stat = await fs.stat(join(dir, SESSIONS_DIR))
            expect(stat.isDirectory()).toBe(true)
        })

        it('keys archives by id so distinct sessions coexist', async () => {
            await store.archive(makeSession({ id: 'one' }))
            await store.archive(makeSession({ id: 'two' }))
            const one = JSON.parse(await fs.readFile(join(dir, SESSIONS_DIR, 'one.json'), 'utf-8'))
            const two = JSON.parse(await fs.readFile(join(dir, SESSIONS_DIR, 'two.json'), 'utf-8'))
            expect(one.id).toBe('one')
            expect(two.id).toBe('two')
        })

        it('harmlessly archives an empty/new session', async () => {
            const empty = makeSession({
                id: 'empty-archive',
                turns: [],
                summary: { inferredIntent: '', completedSteps: [], updatedThroughTurnId: null }
            })
            await store.archive(empty)
            const raw = await fs.readFile(
                join(dir, SESSIONS_DIR, 'empty-archive.json'),
                'utf-8'
            )
            expect(JSON.parse(raw)).toEqual(empty)
        })

        it('leaves no temp file behind after an archive', async () => {
            await store.archive(makeSession({ id: 'no-temp' }))
            await expect(
                fs.stat(join(dir, SESSIONS_DIR, 'no-temp.json.tmp'))
            ).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('snapshots the session at archive time, ignoring later mutation', async () => {
            const session = makeSession({ id: 'snap-archive' })
            const pending = store.archive(session)
            session.id = 'mutated-after'
            session.turns.push({
                id: 'late',
                role: 'user',
                text: 'late',
                createdAt: '2024-01-01T00:00:09.000Z',
                status: 'ok'
            })
            await pending
            const raw = await fs.readFile(
                join(dir, SESSIONS_DIR, 'snap-archive.json'),
                'utf-8'
            )
            const archived = JSON.parse(raw)
            expect(archived.id).toBe('snap-archive')
            expect(archived.turns).toHaveLength(2)
        })

        it('does not disturb current.json', async () => {
            await store.save(makeSession({ id: 'current-session' }))
            await store.archive(makeSession({ id: 'archived-session' }))
            const loaded = await store.load()
            expect(loaded?.id).toBe('current-session')
        })
    })

    describe('jsonSessionCodec', () => {
        it('encodes then decodes to an equal session', () => {
            const session = makeSession()
            expect(jsonSessionCodec.decode(jsonSessionCodec.encode(session))).toEqual(session)
        })

        it('throws when decoding a non-session object', () => {
            expect(() => jsonSessionCodec.decode(JSON.stringify({ nope: true }))).toThrow()
        })
    })
})
