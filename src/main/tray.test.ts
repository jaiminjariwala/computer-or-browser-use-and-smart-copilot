import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Unit tests for the Tray (menu-bar) Manager (task 6.2, Req 1.5).
 *
 * Electron's `Tray`, `Menu`, and `nativeImage` are mocked so the fallback is
 * exercised without a real menu-bar icon. We capture the click handler and the
 * menu template handed to Electron to assert that both routes open the Sidebar.
 *
 * Validates: Requirements 1.5
 */

// A single tray instance the mocked constructor returns, so tests can inspect
// the calls made against it.
const trayInstance = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn()
}
const TrayCtor = vi.fn((..._args: unknown[]) => trayInstance)
const buildFromTemplate = vi.fn((..._args: unknown[]) => ({ template: _args[0] }))
const createEmpty = vi.fn((..._args: unknown[]) => ({ __emptyImage: true }))

vi.mock('electron', () => ({
    Tray: function (...args: unknown[]) {
        return TrayCtor(...args)
    },
    Menu: {
        buildFromTemplate: (...args: unknown[]) => buildFromTemplate(...args)
    },
    nativeImage: {
        createEmpty: (...args: unknown[]) => createEmpty(...args)
    }
}))

import { TrayManager, TRAY_TOOLTIP, type SidebarOpener } from './tray'

/** A recording opener so we can count how often the Sidebar is opened. */
function makeOpener(): SidebarOpener & { openCount: number } {
    return {
        openCount: 0,
        showSidebar() {
            this.openCount++
        }
    }
}

/** The menu template handed to `Menu.buildFromTemplate`. */
type MenuItem = { label?: string; type?: string; role?: string; click?: () => void }
function capturedMenuTemplate(): MenuItem[] {
    const lastCall = buildFromTemplate.mock.calls.at(-1)
    if (!lastCall) throw new Error('buildFromTemplate was never called')
    return lastCall[0] as MenuItem[]
}

/** The handler registered for the tray's `click` event. */
function capturedClickHandler(): () => void {
    const clickCall = trayInstance.on.mock.calls.find((c) => c[0] === 'click')
    if (!clickCall) throw new Error('no click handler was registered')
    return clickCall[1] as () => void
}

beforeEach(() => {
    TrayCtor.mockClear()
    buildFromTemplate.mockClear()
    createEmpty.mockClear()
    trayInstance.setToolTip.mockReset()
    trayInstance.setContextMenu.mockReset()
    trayInstance.on.mockReset()
    trayInstance.destroy.mockReset()
})

describe('TrayManager.show', () => {
    it('creates a menu-bar icon with a tooltip (Req 1.5)', () => {
        const manager = new TrayManager(makeOpener())

        manager.show()

        expect(createEmpty).toHaveBeenCalledTimes(1)
        expect(TrayCtor).toHaveBeenCalledTimes(1)
        expect(trayInstance.setToolTip).toHaveBeenCalledWith(TRAY_TOOLTIP)
        expect(trayInstance.setContextMenu).toHaveBeenCalledTimes(1)
        expect(manager.isActive()).toBe(true)
    })

    it('opens the sidebar from the "Open Glass" menu item (Req 1.5)', () => {
        const opener = makeOpener()
        const manager = new TrayManager(opener)

        manager.show()
        const openItem = capturedMenuTemplate().find((i) => i.label === 'Open Glass')
        expect(openItem).toBeDefined()
        openItem?.click?.()

        expect(opener.openCount).toBe(1)
    })

    it('opens the sidebar from a direct click on the icon (Req 1.5)', () => {
        const opener = makeOpener()
        const manager = new TrayManager(opener)

        manager.show()
        capturedClickHandler()()

        expect(opener.openCount).toBe(1)
    })

    it('is idempotent: a second show reuses the existing icon', () => {
        const manager = new TrayManager(makeOpener())

        const first = manager.show()
        const second = manager.show()

        expect(TrayCtor).toHaveBeenCalledTimes(1)
        expect(first).toBe(second)
    })

    it('provides a quit item so the app can be closed from the menu bar', () => {
        const manager = new TrayManager(makeOpener())

        manager.show()

        const quitItem = capturedMenuTemplate().find((i) => i.role === 'quit')
        expect(quitItem).toBeDefined()
    })
})

describe('TrayManager.destroy', () => {
    it('removes the icon and clears active state', () => {
        const manager = new TrayManager(makeOpener())
        manager.show()

        manager.destroy()

        expect(trayInstance.destroy).toHaveBeenCalledTimes(1)
        expect(manager.isActive()).toBe(false)
    })

    it('is safe to call when no icon is active', () => {
        const manager = new TrayManager(makeOpener())

        expect(() => manager.destroy()).not.toThrow()
        expect(trayInstance.destroy).not.toHaveBeenCalled()
    })
})
