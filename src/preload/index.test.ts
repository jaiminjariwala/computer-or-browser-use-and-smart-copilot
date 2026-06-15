import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GlassBridge, Rect } from '@shared/types'

// Capture what the preload exposes on `window.glass` and stub ipcRenderer.
// `vi.mock` is hoisted above normal `const`s, so the shared capture state is
// created with `vi.hoisted` to be available inside the mock factory.
const { exposed, listeners } = vi.hoisted(() => ({
    exposed: {} as Record<string, unknown>,
    listeners: [] as Array<{ channel: string; listener: (...a: unknown[]) => void }>
}))

vi.mock('electron', () => ({
    contextBridge: {
        exposeInMainWorld: (key: string, api: unknown) => {
            exposed[key] = api
        }
    },
    ipcRenderer: {
        invoke: vi.fn(async () => undefined),
        on: vi.fn((channel: string, listener: (...a: unknown[]) => void) => {
            listeners.push({ channel, listener })
        }),
        removeListener: vi.fn((channel: string, listener: (...a: unknown[]) => void) => {
            const idx = listeners.findIndex((l) => l.channel === channel && l.listener === listener)
            if (idx >= 0) listeners.splice(idx, 1)
        })
    }
}))

import { ipcRenderer } from 'electron'
// Importing the module runs exposeInMainWorld('glass', bridge).
import './index'

function bridge(): GlassBridge {
    return exposed.glass as GlassBridge
}

describe('preload window.glass bridge', () => {
    beforeEach(() => {
        ; (ipcRenderer.invoke as unknown as { mockClear: () => void }).mockClear()
        listeners.length = 0
    })

    it('exposes the full GlassBridge surface', () => {
        const g = bridge()
        expect(g).toBeDefined()
        expect(g.ready).toBe(true)
        for (const method of [
            'sendMessage',
            'triggerCapture',
            'newSession',
            'getSession',
            'getConfigStatus',
            'saveConfig',
            'onTurnAppended',
            'onPending',
            'onError',
            'onCredentialsRequired',
            'submitRegion',
            'cancelRegion'
        ] as const) {
            expect(typeof (g as unknown as Record<string, unknown>)[method]).toBe('function')
        }
    })

    it('preserves the existing config surface (getConfigStatus, saveConfig)', async () => {
        const g = bridge()
        await g.getConfigStatus()
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:get-status')

        const cfg = { baseURL: 'https://gw', model: 'm', apiKey: 'k' }
        await g.saveConfig(cfg)
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:save', cfg)
    })

    it('maps sendMessage to chat:send with a { text } payload', async () => {
        await bridge().sendMessage('hello')
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('chat:send', { text: 'hello' })
    })

    it('maps triggerCapture, newSession, getSession to their channels', async () => {
        const g = bridge()
        await g.triggerCapture()
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('capture:trigger')
        await g.newSession()
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:new')
        await g.getSession()
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:get')
    })

    it('maps submitRegion/cancelRegion to the capture channels', async () => {
        const g = bridge()
        const rect: Rect = { x: 0, y: 0, width: 10, height: 20 }
        await g.submitRegion(rect)
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('capture:region', { rect })
        await g.cancelRegion()
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('capture:cancel')
    })

    it('onTurnAppended subscribes to turn:appended and forwards the turn', () => {
        const received: unknown[] = []
        const unsubscribe = bridge().onTurnAppended((t) => received.push(t))
        const sub = listeners.find((l) => l.channel === 'turn:appended')
        expect(sub).toBeDefined()
        // Simulate a main-process event: (event, turn).
        const turn = { id: 't1', role: 'assistant', createdAt: 'now', status: 'ok' }
        sub!.listener({}, turn)
        expect(received).toEqual([turn])

        // Unsubscribe removes the listener.
        unsubscribe()
        expect(listeners.find((l) => l.channel === 'turn:appended')).toBeUndefined()
    })

    it('onPending forwards the boolean state', () => {
        const received: boolean[] = []
        bridge().onPending((p) => received.push(p))
        const sub = listeners.find((l) => l.channel === 'request:pending')
        sub!.listener({}, true)
        sub!.listener({}, false)
        expect(received).toEqual([true, false])
    })

    it('onError forwards the GlassError payload', () => {
        const received: unknown[] = []
        bridge().onError((e) => received.push(e))
        const sub = listeners.find((l) => l.channel === 'error:show')
        const err = { kind: 'gateway-failed', message: 'x', recoverable: true }
        sub!.listener({}, err)
        expect(received).toEqual([err])
    })

    it('onCredentialsRequired subscribes to credentials:required', () => {
        let calls = 0
        const unsubscribe = bridge().onCredentialsRequired(() => {
            calls += 1
        })
        const sub = listeners.find((l) => l.channel === 'credentials:required')
        expect(sub).toBeDefined()
        sub!.listener({})
        expect(calls).toBe(1)
        unsubscribe()
        expect(listeners.find((l) => l.channel === 'credentials:required')).toBeUndefined()
    })
})
