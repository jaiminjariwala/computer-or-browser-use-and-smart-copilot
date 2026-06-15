import { describe, it, expect, beforeEach, vi } from 'vitest'

// Electron is unavailable in the Vitest (node) environment. Mock the surface
// ipc.ts touches: ipcMain.handle/removeHandler. Window targets are faked.
vi.mock('electron', () => ({
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

import { ipcMain } from 'electron'
import {
    registerGlassIpc,
    emitTurnAppended,
    emitPending,
    emitError,
    EMPTY_SESSION_VIEW,
    type GlassIpcDeps
} from './ipc'
import type { GlassError, Rect, SessionView, TurnView } from '@shared/types'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

/** Pull a registered ipcMain.handle handler out of the mocked electron module. */
function getHandler(channel: string): IpcHandler {
    const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const entry = calls.find((c) => c[0] === channel)
    if (!entry) throw new Error(`no handler registered for ${channel}`)
    return entry[1] as IpcHandler
}

/** A fake window that records the (channel, payload) pairs sent to it. */
function makeFakeWindow(): {
    window: { webContents: { send: (channel: string, payload?: unknown) => void } }
    sent: Array<{ channel: string; payload: unknown }>
} {
    const sent: Array<{ channel: string; payload: unknown }> = []
    return {
        sent,
        window: {
            webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
        }
    }
}

describe('registerGlassIpc', () => {
    beforeEach(() => {
        ; (ipcMain.handle as unknown as { mockClear: () => void }).mockClear()
            ; (ipcMain.removeHandler as unknown as { mockClear: () => void }).mockClear()
    })

    it('registers all sidebar/overlay -> main channels (and not the config ones)', () => {
        registerGlassIpc({ getSidebarWindow: () => null })
        for (const channel of [
            'chat:send',
            'capture:trigger',
            'capture:region',
            'capture:cancel',
            'session:new',
            'session:get'
        ]) {
            expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function))
        }
        // config channels are owned by config.ts, not ipc.ts
        expect(ipcMain.handle).not.toHaveBeenCalledWith('config:get-status', expect.any(Function))
        expect(ipcMain.handle).not.toHaveBeenCalledWith('config:save', expect.any(Function))
    })

    it('chat:send forwards the message text to the backing callback', async () => {
        const onSendMessage = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onSendMessage })
        await getHandler('chat:send')({}, { text: 'hello' })
        expect(onSendMessage).toHaveBeenCalledWith('hello')
    })

    it('chat:send defaults to empty string when no payload is provided', async () => {
        const onSendMessage = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onSendMessage })
        await getHandler('chat:send')({}, undefined)
        expect(onSendMessage).toHaveBeenCalledWith('')
    })

    it('capture:trigger and capture:cancel invoke their callbacks', async () => {
        const onTriggerCapture = vi.fn()
        const onCancelRegion = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onTriggerCapture, onCancelRegion })
        await getHandler('capture:trigger')({})
        await getHandler('capture:cancel')({})
        expect(onTriggerCapture).toHaveBeenCalledOnce()
        expect(onCancelRegion).toHaveBeenCalledOnce()
    })

    it('capture:region forwards the selected rect', async () => {
        const onSubmitRegion = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onSubmitRegion })
        const rect: Rect = { x: 1, y: 2, width: 3, height: 4 }
        await getHandler('capture:region')({}, { rect })
        expect(onSubmitRegion).toHaveBeenCalledWith(rect, undefined)
    })

    it('capture:region ignores a missing rect', async () => {
        const onSubmitRegion = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onSubmitRegion })
        await getHandler('capture:region')({}, undefined)
        expect(onSubmitRegion).not.toHaveBeenCalled()
    })

    it('session:new invokes its callback', async () => {
        const onNewSession = vi.fn()
        registerGlassIpc({ getSidebarWindow: () => null, onNewSession })
        await getHandler('session:new')({})
        expect(onNewSession).toHaveBeenCalledOnce()
    })

    it('session:get returns the backing session when present', async () => {
        const session: SessionView = {
            id: 's1',
            turns: [],
            summary: { inferredIntent: 'goal', completedSteps: ['a'], updatedThroughTurnId: null }
        }
        registerGlassIpc({ getSidebarWindow: () => null, getSession: () => session })
        expect(await getHandler('session:get')({})).toEqual(session)
    })

    it('session:get returns an empty session view when no backing service exists', async () => {
        registerGlassIpc({ getSidebarWindow: () => null })
        expect(await getHandler('session:get')({})).toEqual(EMPTY_SESSION_VIEW)
    })

    it('handlers are safe no-ops when callbacks are omitted', async () => {
        const deps: GlassIpcDeps = { getSidebarWindow: () => null }
        registerGlassIpc(deps)
        await expect(getHandler('chat:send')({}, { text: 'x' })).resolves.toBeUndefined()
        await expect(getHandler('capture:trigger')({})).resolves.toBeUndefined()
        await expect(getHandler('capture:cancel')({})).resolves.toBeUndefined()
        await expect(getHandler('session:new')({})).resolves.toBeUndefined()
    })

    it('the returned disposer removes every registered handler', () => {
        const dispose = registerGlassIpc({ getSidebarWindow: () => null })
        dispose()
        for (const channel of [
            'chat:send',
            'capture:trigger',
            'capture:region',
            'capture:cancel',
            'session:new',
            'session:get'
        ]) {
            expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel)
        }
    })
})

describe('main -> sidebar emitters', () => {
    it('emitTurnAppended sends the turn on turn:appended', () => {
        const { window, sent } = makeFakeWindow()
        const turn: TurnView = {
            id: 't1',
            role: 'assistant',
            text: 'hi',
            createdAt: new Date().toISOString(),
            status: 'ok'
        }
        emitTurnAppended(window as never, turn)
        expect(sent).toEqual([{ channel: 'turn:appended', payload: turn }])
    })

    it('emitPending sends the boolean state on request:pending', () => {
        const { window, sent } = makeFakeWindow()
        emitPending(window as never, true)
        expect(sent).toEqual([{ channel: 'request:pending', payload: true }])
    })

    it('emitError sends the error on error:show', () => {
        const { window, sent } = makeFakeWindow()
        const err: GlassError = {
            kind: 'gateway-failed',
            message: 'boom',
            recoverable: true,
            action: 'retry'
        }
        emitError(window as never, err)
        expect(sent).toEqual([{ channel: 'error:show', payload: err }])
    })

    it('emitters are no-ops when the window is null/undefined', () => {
        expect(() => emitPending(null, true)).not.toThrow()
        expect(() => emitPending(undefined, false)).not.toThrow()
    })
})
