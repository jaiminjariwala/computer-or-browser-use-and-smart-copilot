import { BrowserWindow, screen } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import { join } from 'path'

/**
 * Window Manager.
 *
 * Owns the application's BrowserWindows:
 *
 * - The persistent Sidebar_Panel: a frameless, always-on-top (floating level)
 *   window that hosts the React chat UI (task 2.1).
 * - The Overlay_Window: a transparent, frameless, full-screen, screen-saver
 *   level window shown on demand for rectangular region selection (task 8.1).
 *
 * Requirements:
 * - 2.1 The Sidebar_Panel SHALL remain visible above other application
 *   windows WHILE the Sidebar_Panel is shown (frameless + always-on-top
 *   at floating level).
 * - 2.6 Typed text input only (enforced by the renderer UI).
 * - 4.1 WHEN the user triggers region capture, THE Glass_App SHALL display the
 *   Overlay_Window covering the full screen.
 * - 4.2 WHILE the Overlay_Window is displayed, the user SHALL be able to select
 *   a rectangular region by dragging (enforced by the overlay renderer UI).
 */

/** Default desktop workspace dimensions, in logical pixels. */
export const SIDEBAR_WIDTH = 1040
export const SIDEBAR_HEIGHT = 760

/** Size of the floating pencil launcher window, in logical pixels. */
export const PENCIL_SIZE = 72

/**
 * The always-on-top level used for the Sidebar_Panel. "floating" keeps the
 * panel above normal application windows without competing with the much
 * higher screen-saver level reserved for the capture overlay.
 */
export const SIDEBAR_ALWAYS_ON_TOP_LEVEL = 'floating' as const

/**
 * Build the BrowserWindow options for the Sidebar_Panel.
 *
 * Extracted as a pure function so the security-critical configuration
 * (frameless, always-on-top, contextIsolation on, nodeIntegration off) can be
 * unit-tested without launching Electron.
 */
export function createSidebarWindowOptions(
    preloadPath: string
): BrowserWindowConstructorOptions {
    return {
        width: SIDEBAR_WIDTH,
        height: SIDEBAR_HEIGHT,
        minWidth: 680,
        minHeight: 520,
        show: false,
        // Frameless persistent panel (Req 2.1).
        frame: false,
        titleBarStyle: 'hidden',
        resizable: true,
        // Keep the panel above other windows while shown (Req 2.1).
        alwaysOnTop: true,
        fullscreenable: false,
        skipTaskbar: false,
        webPreferences: {
            preload: preloadPath,
            // Sandboxed renderer reaching main only via the preload bridge.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    }
}

/**
 * The always-on-top level used for the Overlay_Window. "screen-saver" is the
 * highest standard level, keeping the transparent capture overlay above every
 * other window — including the Sidebar_Panel's "floating" level and full-screen
 * apps — while the user selects a region (Req 4.1).
 */
export const OVERLAY_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const

/** A display rectangle (logical pixels), as reported by Electron's `screen`. */
export interface DisplayBounds {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Build the BrowserWindow options for the Overlay_Window.
 *
 * Extracted as a pure function (like {@link createSidebarWindowOptions}) so the
 * transparency / frameless / full-screen-bounds configuration can be
 * unit-tested without launching Electron. The window is positioned and sized to
 * exactly cover the given display so the selection overlay spans the full
 * screen (Req 4.1). The screen-saver always-on-top level is applied separately
 * via `setAlwaysOnTop` after construction.
 */
export function createOverlayWindowOptions(
    preloadPath: string,
    bounds: DisplayBounds
): BrowserWindowConstructorOptions {
    return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        show: false,
        // Transparent, frameless full-screen surface (Req 4.1).
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        // The overlay fills a fixed display; it must not be resized or moved.
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Sit above all other windows while capturing (Req 4.1).
        alwaysOnTop: true,
        // Allow the window to exactly match displays larger than the primary.
        enableLargerThanScreen: true,
        webPreferences: {
            preload: preloadPath,
            // Sandboxed renderer reaching main only via the preload bridge.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    }
}

/**
 * Resolve the bounds of the display the user is currently working on.
 *
 * Uses the display nearest the cursor so the overlay appears on the screen the
 * user is looking at in a multi-monitor setup, falling back to the primary
 * display. Sized to that display so the overlay covers the full screen (Req 4.1).
 */
export function getActiveDisplayBounds(): DisplayBounds {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
    return display.bounds
}

/** Resolve the preload script path relative to the built main output. */
function defaultPreloadPath(): string {
    return join(__dirname, '../preload/index.js')
}

/** Load the Overlay renderer, preferring the dev server when present. */
function loadOverlayRenderer(window: BrowserWindow): void {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void window.loadURL(`${devServerUrl}/overlay/index.html`)
    } else {
        void window.loadFile(join(__dirname, '../renderer/overlay/index.html'))
    }
}

/** Load the Sidebar renderer, preferring the dev server when present. */
function loadSidebarRenderer(window: BrowserWindow): void {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void window.loadURL(`${devServerUrl}/sidebar/index.html`)
    } else {
        void window.loadFile(join(__dirname, '../renderer/sidebar/index.html'))
    }
}

/** Load the Pencil launcher renderer, preferring the dev server when present. */
function loadPencilRenderer(window: BrowserWindow): void {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void window.loadURL(`${devServerUrl}/pencil/index.html`)
    } else {
        void window.loadFile(join(__dirname, '../renderer/pencil/index.html'))
    }
}

/**
 * Build the BrowserWindow options for the floating pencil launcher.
 *
 * A tiny, transparent, frameless, always-on-top window that floats over every
 * app and Space so the user can trigger a capture from anywhere without
 * returning to the chat window. It must not take focus from the user's current
 * app, so `focusable: false`.
 */
export function createPencilWindowOptions(
    preloadPath: string
): BrowserWindowConstructorOptions {
    return {
        width: PENCIL_SIZE,
        height: PENCIL_SIZE,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Stay above normal windows; the capture overlay (screen-saver level)
        // still sits above this while a capture is in progress.
        alwaysOnTop: true,
        // Do not steal focus from the app the user is working in.
        focusable: false,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    }
}

/**
 * Manages the lifecycle and visibility of Glass's windows.
 */
export class WindowManager {
    private sidebar: BrowserWindow | null = null
    private overlay: BrowserWindow | null = null
    private pencil: BrowserWindow | null = null
    private pencilFollowTimer: ReturnType<typeof setInterval> | null = null
    private pencilDisplayId: number | null = null

    /**
     * Create (or return the existing) Sidebar_Panel window.
     */
    createSidebar(): BrowserWindow {
        if (this.sidebar && !this.sidebar.isDestroyed()) {
            return this.sidebar
        }

        const window = new BrowserWindow(
            createSidebarWindowOptions(defaultPreloadPath())
        )

        // Apply the floating always-on-top level explicitly so the panel sits
        // above normal windows but below the capture overlay (Req 2.1).
        window.setAlwaysOnTop(true, SIDEBAR_ALWAYS_ON_TOP_LEVEL)

        // Keep the panel visible across Spaces / over full-screen apps.
        window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true
        })

        window.on('ready-to-show', () => {
            window.show()
        })

        window.on('closed', () => {
            this.sidebar = null
        })

        loadSidebarRenderer(window)

        this.sidebar = window
        return window
    }

    /** The current Sidebar window, or null if none exists. */
    getSidebar(): BrowserWindow | null {
        if (this.sidebar && this.sidebar.isDestroyed()) {
            this.sidebar = null
        }
        return this.sidebar
    }

    /**
     * Show and focus the Sidebar_Panel, creating it if necessary.
     */
    showSidebar(): void {
        const window = this.createSidebar()
        window.show()
        window.focus()
    }

    /** Hide the Sidebar_Panel if it exists. */
    hideSidebar(): void {
        this.sidebar?.hide()
    }

    /**
     * Toggle Sidebar visibility: show+focus when hidden, hide when visible.
     * Used by the global hotkey in a later task.
     */
    toggleSidebar(): void {
        const window = this.getSidebar()
        if (window && window.isVisible() && window.isFocused()) {
            window.hide()
        } else {
            this.showSidebar()
        }
    }

    /**
     * Create (or return the existing) Overlay_Window sized to the given display
     * bounds. Transparent, frameless, and pinned at the screen-saver level so
     * it covers the full screen above all other windows during capture (Req 4.1).
     */
    createOverlay(bounds: DisplayBounds): BrowserWindow {
        if (this.overlay && !this.overlay.isDestroyed()) {
            return this.overlay
        }

        const window = new BrowserWindow(
            createOverlayWindowOptions(defaultPreloadPath(), bounds)
        )

        // Pin above every other window (incl. the sidebar + full-screen apps)
        // while the user selects a region (Req 4.1).
        window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL)
        window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true
        })

        window.on('closed', () => {
            this.overlay = null
        })

        loadOverlayRenderer(window)

        this.overlay = window
        return window
    }

    /** The current Overlay window, or null if none exists. */
    getOverlay(): BrowserWindow | null {
        if (this.overlay && this.overlay.isDestroyed()) {
            this.overlay = null
        }
        return this.overlay
    }

    /**
     * Show the Overlay_Window for region selection, creating it if necessary.
     * Sizes it to the active display (or the supplied bounds) so it covers the
     * full screen, then shows and focuses it (Req 4.1).
     */
    showOverlay(bounds: DisplayBounds = getActiveDisplayBounds()): BrowserWindow {
        const window = this.createOverlay(bounds)
        window.setBounds(bounds)
        window.show()
        window.focus()
        return window
    }

    /**
     * Close the Overlay_Window if it exists. Used on a completed selection
     * (Req 4.3) and on cancel (Req 4.4) so no capture surface lingers on screen.
     */
    closeOverlay(): void {
        if (this.overlay && !this.overlay.isDestroyed()) {
            this.overlay.close()
        }
        this.overlay = null
    }

    /**
     * Create (or return the existing) floating pencil launcher window. It is
     * pinned at the floating level, visible across all Spaces and full-screen
     * apps, and positioned near the top-right of the active display.
     */
    createPencil(): BrowserWindow {
        if (this.pencil && !this.pencil.isDestroyed()) {
            return this.pencil
        }

        const window = new BrowserWindow(createPencilWindowOptions(defaultPreloadPath()))

        window.setAlwaysOnTop(true, SIDEBAR_ALWAYS_ON_TOP_LEVEL)
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

        // Park it near the top-right of the active display by default.
        const bounds = getActiveDisplayBounds()
        const margin = 24
        window.setPosition(
            Math.round(bounds.x + bounds.width - PENCIL_SIZE - margin),
            Math.round(bounds.y + margin)
        )

        window.on('ready-to-show', () => {
            window.showInactive()
        })

        window.on('closed', () => {
            this.pencil = null
        })

        loadPencilRenderer(window)

        this.pencil = window
        return window
    }

    /** The current pencil window, or null if none exists. */
    getPencil(): BrowserWindow | null {
        if (this.pencil && this.pencil.isDestroyed()) {
            this.pencil = null
        }
        return this.pencil
    }

    /** Show the floating pencil launcher without taking focus. */
    showPencil(): void {
        const window = this.createPencil()
        window.showInactive()
    }

    /** Move the pencil to the top-right of the given display. */
    private positionPencilOnDisplay(bounds: DisplayBounds): void {
        const window = this.getPencil()
        if (!window) return
        const margin = 24
        window.setPosition(
            Math.round(bounds.x + bounds.width - PENCIL_SIZE - margin),
            Math.round(bounds.y + margin)
        )
    }

    /**
     * Keep the floating pencil on whichever display the cursor is currently on,
     * so it is reachable on every screen of a multi-monitor setup. Polls the
     * cursor's display and repositions only when it changes, which is cheap and
     * avoids fighting a manual drag while the user stays on one screen.
     */
    startPencilFollow(): void {
        if (this.pencilFollowTimer) return
        this.pencilFollowTimer = setInterval(() => {
            const window = this.getPencil()
            if (!window) return
            const cursor = screen.getCursorScreenPoint()
            const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
            if (display.id !== this.pencilDisplayId) {
                this.pencilDisplayId = display.id
                this.positionPencilOnDisplay(display.bounds)
            }
        }, 500)
    }

    /** Stop the multi-display follow timer (on quit). */
    stopPencilFollow(): void {
        if (this.pencilFollowTimer) {
            clearInterval(this.pencilFollowTimer)
            this.pencilFollowTimer = null
        }
    }
}
