import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Unit tests for the Hotkey Manager (task 6.1).
 *
 * `globalShortcut` is mocked so the tests run on any platform without touching
 * real OS shortcut registration. We capture the callback handed to
 * `register()` to assert that pressing the hotkey toggles the sidebar.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.6
 */

const register = vi.fn()
const unregister = vi.fn()
const unregisterAll = vi.fn()
const isRegistered = vi.fn()

vi.mock('electron', () => ({
    globalShortcut: {
        register: (...args: unknown[]) => register(...args),
        unregister: (...args: unknown[]) => unregister(...args),
        unregisterAll: (...args: unknown[]) => unregisterAll(...args),
        isRegistered: (...args: unknown[]) => isRegistered(...args)
    }
}))

import {
    HotkeyManager,
    DEFAULT_GLOBAL_HOTKEY,
    buildHotkeyError,
    applyRegistrationResult,
    type SidebarToggler,
    type HotkeyRegistrationResult
} from './hotkey'

/** A recording sidebar toggler so we can count toggle invocations. */
function makeToggler(): SidebarToggler & { toggleCount: number } {
    const toggler = {
        toggleCount: 0,
        toggleSidebar() {
            this.toggleCount++
        }
    }
    return toggler
}

/** Pull the callback that the manager handed to `globalShortcut.register`. */
function capturedCallback(): () => void {
    const lastCall = register.mock.calls.at(-1)
    if (!lastCall) throw new Error('register was never called')
    return lastCall[1] as () => void
}

beforeEach(() => {
    register.mockReset()
    unregister.mockReset()
    unregisterAll.mockReset()
    isRegistered.mockReset()
})

describe('DEFAULT_GLOBAL_HOTKEY', () => {
    it('is the documented CommandOrControl+Shift+Space accelerator', () => {
        expect(DEFAULT_GLOBAL_HOTKEY).toBe('CommandOrControl+Shift+Space')
    })
})

describe('HotkeyManager.register', () => {
    it('registers the default accelerator with the OS (Req 1.1)', () => {
        register.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler())

        const result = manager.register()

        expect(register).toHaveBeenCalledWith(
            DEFAULT_GLOBAL_HOTKEY,
            expect.any(Function)
        )
        expect(result.success).toBe(true)
        expect(result.accelerator).toBe(DEFAULT_GLOBAL_HOTKEY)
        expect(result.error).toBeUndefined()
        expect(manager.isRegistered()).toBe(true)
    })

    it('registers a custom accelerator when provided', () => {
        register.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler(), 'CommandOrControl+G')

        const result = manager.register()

        expect(register).toHaveBeenCalledWith('CommandOrControl+G', expect.any(Function))
        expect(result.accelerator).toBe('CommandOrControl+G')
        expect(manager.getAccelerator()).toBe('CommandOrControl+G')
    })

    it('toggles the sidebar when the hotkey fires (Req 1.2, 1.3)', () => {
        register.mockReturnValue(true)
        const toggler = makeToggler()
        const manager = new HotkeyManager(toggler)

        manager.register()
        // Simulate the OS firing the global shortcut.
        capturedCallback()()

        expect(toggler.toggleCount).toBe(1)
    })

    it('keeps responding to repeated presses regardless of focus (Req 1.6)', () => {
        register.mockReturnValue(true)
        const toggler = makeToggler()
        const manager = new HotkeyManager(toggler)

        manager.register()
        const fire = capturedCallback()
        fire()
        fire()
        fire()

        // globalShortcut delivers the callback even when another app is
        // focused; each press routes straight to the toggle.
        expect(toggler.toggleCount).toBe(3)
    })

    it('reports a conflict when the accelerator is already held (Req 1.4 hook for 6.2)', () => {
        register.mockReturnValue(false)
        isRegistered.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler())

        const result = manager.register()

        expect(result.success).toBe(false)
        expect(result.reason).toBe('conflict')
        expect(result.error?.kind).toBe('hotkey-conflict')
        expect(result.error?.action).toBe('choose-hotkey')
        expect(manager.isRegistered()).toBe(false)
    })

    it('reports a generic failure when registration fails without a conflict (Req 1.5 hook for 6.2)', () => {
        register.mockReturnValue(false)
        isRegistered.mockReturnValue(false)
        const manager = new HotkeyManager(makeToggler())

        const result = manager.register()

        expect(result.success).toBe(false)
        expect(result.reason).toBe('failed')
        expect(result.error?.kind).toBe('hotkey-failed')
        expect(manager.isRegistered()).toBe(false)
    })

    it('does not invoke the toggler if registration failed', () => {
        register.mockReturnValue(false)
        isRegistered.mockReturnValue(false)
        const toggler = makeToggler()
        const manager = new HotkeyManager(toggler)

        manager.register()

        // No callback should have been retained/fired on failure.
        expect(toggler.toggleCount).toBe(0)
    })
})

describe('HotkeyManager.unregister', () => {
    it('releases the OS binding and clears registered state', () => {
        register.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler())
        manager.register()

        manager.unregister()

        expect(unregisterAll).toHaveBeenCalledTimes(1)
        expect(manager.isRegistered()).toBe(false)
    })
})

describe('HotkeyManager.reRegister', () => {
    it('releases the old accelerator and registers the new one (Req 1.4)', () => {
        register.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler())
        manager.register()

        register.mockClear()
        const result = manager.reRegister('CommandOrControl+Alt+G')

        // The previously-held accelerator is released before switching.
        expect(unregister).toHaveBeenCalledWith(DEFAULT_GLOBAL_HOTKEY)
        expect(register).toHaveBeenCalledWith(
            'CommandOrControl+Alt+G',
            expect.any(Function)
        )
        expect(result.success).toBe(true)
        expect(result.accelerator).toBe('CommandOrControl+Alt+G')
        expect(manager.getAccelerator()).toBe('CommandOrControl+Alt+G')
        expect(manager.isRegistered()).toBe(true)
    })

    it('does not release anything when nothing was registered yet', () => {
        register.mockReturnValue(true)
        const manager = new HotkeyManager(makeToggler())

        manager.reRegister('CommandOrControl+Alt+G')

        expect(unregister).not.toHaveBeenCalled()
    })

    it('reports a conflict when the new accelerator is also taken (Req 1.4)', () => {
        register.mockReturnValueOnce(true) // initial register succeeds
        const manager = new HotkeyManager(makeToggler())
        manager.register()

        register.mockReturnValue(false)
        isRegistered.mockReturnValue(true)
        const result = manager.reRegister('CommandOrControl+Alt+G')

        expect(result.success).toBe(false)
        expect(result.reason).toBe('conflict')
        expect(result.error?.action).toBe('choose-hotkey')
        expect(manager.isRegistered()).toBe(false)
    })
})

describe('applyRegistrationResult', () => {
    function makeDeps(): {
        emitError: ReturnType<typeof vi.fn>
        showTray: ReturnType<typeof vi.fn>
    } {
        return { emitError: vi.fn(), showTray: vi.fn() }
    }

    it('does nothing on success', () => {
        const deps = makeDeps()
        const result: HotkeyRegistrationResult = {
            success: true,
            accelerator: DEFAULT_GLOBAL_HOTKEY
        }

        applyRegistrationResult(result, deps)

        expect(deps.emitError).not.toHaveBeenCalled()
        expect(deps.showTray).not.toHaveBeenCalled()
    })

    it('surfaces the conflict error and does NOT open the tray (Req 1.4)', () => {
        const deps = makeDeps()
        const error = buildHotkeyError('conflict', DEFAULT_GLOBAL_HOTKEY)
        const result: HotkeyRegistrationResult = {
            success: false,
            accelerator: DEFAULT_GLOBAL_HOTKEY,
            reason: 'conflict',
            error
        }

        applyRegistrationResult(result, deps)

        expect(deps.emitError).toHaveBeenCalledWith(error)
        // A conflict is recovered by choosing a different hotkey, not the tray.
        expect(deps.showTray).not.toHaveBeenCalled()
    })

    it('surfaces the failure error AND opens the tray fallback (Req 1.5)', () => {
        const deps = makeDeps()
        const error = buildHotkeyError('failed', DEFAULT_GLOBAL_HOTKEY)
        const result: HotkeyRegistrationResult = {
            success: false,
            accelerator: DEFAULT_GLOBAL_HOTKEY,
            reason: 'failed',
            error
        }

        applyRegistrationResult(result, deps)

        expect(deps.emitError).toHaveBeenCalledWith(error)
        expect(deps.showTray).toHaveBeenCalledTimes(1)
    })
})

describe('buildHotkeyError', () => {
    it('builds a recoverable conflict error that offers a hotkey change (Req 1.4)', () => {
        const error = buildHotkeyError('conflict', 'CommandOrControl+Shift+Space')
        expect(error.kind).toBe('hotkey-conflict')
        expect(error.recoverable).toBe(true)
        expect(error.action).toBe('choose-hotkey')
        expect(error.message).toContain('CommandOrControl+Shift+Space')
    })

    it('builds a recoverable generic failure error (Req 1.5)', () => {
        const error = buildHotkeyError('failed', 'CommandOrControl+Shift+Space')
        expect(error.kind).toBe('hotkey-failed')
        expect(error.recoverable).toBe(true)
    })
})
