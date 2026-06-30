import { describe, it, expect } from 'vitest'
import {
    createOverlayWindowOptions,
    createSidebarWindowOptions,
    OVERLAY_ALWAYS_ON_TOP_LEVEL,
    SIDEBAR_ALWAYS_ON_TOP_LEVEL,
    SIDEBAR_HEIGHT,
    SIDEBAR_WIDTH,
    type DisplayBounds
} from './windows'

/**
 * Unit tests for the Sidebar_Panel window configuration (task 2.1).
 *
 * Exercises the pure options factory so the security-critical and
 * always-on-top settings are verified without launching Electron.
 */
describe('createSidebarWindowOptions', () => {
    const opts = createSidebarWindowOptions('/path/to/preload.js')

    it('is frameless (Req 2.1)', () => {
        expect(opts.frame).toBe(false)
    })

    it('is always-on-top (Req 2.1)', () => {
        expect(opts.alwaysOnTop).toBe(true)
    })

    it('uses the floating always-on-top level', () => {
        expect(SIDEBAR_ALWAYS_ON_TOP_LEVEL).toBe('floating')
    })

    it('enables context isolation and disables node integration', () => {
        expect(opts.webPreferences?.contextIsolation).toBe(true)
        expect(opts.webPreferences?.nodeIntegration).toBe(false)
    })

    it('wires the provided preload script', () => {
        expect(opts.webPreferences?.preload).toBe('/path/to/preload.js')
    })

    it('starts hidden until ready-to-show', () => {
        expect(opts.show).toBe(false)
    })

    it('uses the configured default dimensions', () => {
        expect(opts.width).toBe(SIDEBAR_WIDTH)
        expect(opts.height).toBe(SIDEBAR_HEIGHT)
    })
})

/**
 * Unit tests for the Overlay_Window configuration (task 8.1).
 *
 * Exercises the pure options factory so the transparency / frameless /
 * full-screen-bounds settings and the screen-saver level constant are verified
 * without launching Electron (Req 4.1).
 */
describe('createOverlayWindowOptions', () => {
    const bounds: DisplayBounds = { x: 100, y: 50, width: 1920, height: 1080 }
    const opts = createOverlayWindowOptions('/path/to/preload.js', bounds)

    it('is transparent and frameless (Req 4.1)', () => {
        expect(opts.transparent).toBe(true)
        expect(opts.frame).toBe(false)
    })

    it('is sized and positioned to cover the active display (Req 4.1)', () => {
        expect(opts.x).toBe(bounds.x)
        expect(opts.y).toBe(bounds.y)
        expect(opts.width).toBe(bounds.width)
        expect(opts.height).toBe(bounds.height)
    })

    it('is always-on-top at the screen-saver level (Req 4.1)', () => {
        expect(opts.alwaysOnTop).toBe(true)
        expect(OVERLAY_ALWAYS_ON_TOP_LEVEL).toBe('screen-saver')
    })

    it('is fixed: not resizable, movable, or fullscreenable', () => {
        expect(opts.resizable).toBe(false)
        expect(opts.movable).toBe(false)
        expect(opts.fullscreenable).toBe(false)
    })

    it('enables context isolation and disables node integration', () => {
        expect(opts.webPreferences?.contextIsolation).toBe(true)
        expect(opts.webPreferences?.nodeIntegration).toBe(false)
    })

    it('wires the provided preload script', () => {
        expect(opts.webPreferences?.preload).toBe('/path/to/preload.js')
    })

    it('starts hidden until explicitly shown', () => {
        expect(opts.show).toBe(false)
    })
})
