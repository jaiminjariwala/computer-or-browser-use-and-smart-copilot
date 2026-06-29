import { BrowserWindow } from 'electron'
import { join } from 'path'
import {
    CONSOLE_ALWAYS_ON_TOP_LEVEL,
    INDICATOR_ALWAYS_ON_TOP_LEVEL,
    createConsoleWindowOptions,
    createIndicatorWindowOptions,
    getActiveDisplayBounds,
    type DisplayBounds
} from './options'

/**
 * Window Manager (Task 3.1).
 *
 * Owns the two Click Operator windows from the design's "Window Topology":
 *
 * - The **Console_Window**: a frameless, floating, always-on-top panel hosting
 *   the React console UI (goal intake, autonomy/budget, live activity log,
 *   pause/resume/stop, confirmation + permission/credential prompts).
 * - The **Control_Indicator** overlay: a transparent, frameless,
 *   non-focusable, screen-saver-level window visible on all Spaces and
 *   displays. It is shown ONLY while the agent is in control and hidden
 *   otherwise, in strict lockstep with an "in control" flag (Req 7.2, 12.1,
 *   12.2).
 *
 * The pure, security-critical window options live in `options.ts`; this module
 * holds the stateful lifecycle and the in-control lockstep that the Safety gate
 * relies on.
 */

/** Resolve the preload script path relative to the built main output. */
function defaultPreloadPath(): string {
    return join(__dirname, '../preload/index.js')
}

/** Load the Console renderer, preferring the dev server when present. */
function loadConsoleRenderer(window: BrowserWindow): void {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void window.loadURL(`${devServerUrl}/console/index.html`)
    } else {
        void window.loadFile(join(__dirname, '../renderer/console/index.html'))
    }
}

/** Load the Control_Indicator renderer, preferring the dev server when present. */
function loadIndicatorRenderer(window: BrowserWindow): void {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void window.loadURL(`${devServerUrl}/indicator/index.html`)
    } else {
        void window.loadFile(join(__dirname, '../renderer/indicator/index.html'))
    }
}

/**
 * Manages the lifecycle and visibility of Click Operator's windows and drives
 * the Control_Indicator strictly in lockstep with the "agent in control" flag
 * (Req 12.1, 12.2).
 */
export class WindowManager {
    private console: BrowserWindow | null = null
    private indicator: BrowserWindow | null = null
    private desktop: BrowserWindow | null = null
    private inControl = false

    /** Create (or return the existing) Console_Window. */
    createConsole(): BrowserWindow {
        if (this.console && !this.console.isDestroyed()) {
            return this.console
        }

        const window = new BrowserWindow(createConsoleWindowOptions(defaultPreloadPath()))

        // Apply the floating always-on-top level explicitly so the console sits
        // above normal windows but below the Control_Indicator overlay.
        window.setAlwaysOnTop(true, CONSOLE_ALWAYS_ON_TOP_LEVEL)

        window.on('ready-to-show', () => {
            window.show()
        })

        window.on('closed', () => {
            this.console = null
        })

        loadConsoleRenderer(window)

        this.console = window
        return window
    }

    /** The current Console_Window, or null if none exists. */
    getConsole(): BrowserWindow | null {
        if (this.console && this.console.isDestroyed()) {
            this.console = null
        }
        return this.console
    }

    /** Show and focus the Console_Window, creating it if necessary. */
    showConsole(): void {
        const window = this.createConsole()
        window.show()
        window.focus()
    }

    /**
     * Create (or return the existing) Control_Indicator overlay sized to the
     * given display bounds. Transparent, frameless, non-focusable, and pinned at
     * the screen-saver level, and made visible on all Spaces / full-screen apps
     * so it stays visible wherever the agent is working (Req 7.2, 12.1).
     *
     * The overlay is created HIDDEN; visibility is driven solely through
     * {@link setInControl} so it is only ever shown while the agent is in
     * control (Req 12.2).
     */
    createIndicator(bounds: DisplayBounds = getActiveDisplayBounds()): BrowserWindow {
        if (this.indicator && !this.indicator.isDestroyed()) {
            return this.indicator
        }

        const window = new BrowserWindow(createIndicatorWindowOptions(defaultPreloadPath(), bounds))

        // Pin above every other window (incl. the console + full-screen apps)
        // and keep it visible across all Spaces / displays (Req 7.2, 12.1).
        window.setAlwaysOnTop(true, INDICATOR_ALWAYS_ON_TOP_LEVEL)
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        // Belt-and-suspenders: keep the overlay click-through and never
        // focusable even if the platform ignored the constructor option.
        //
        // CRITICAL: the overlay covers the whole display at the highest
        // always-on-top level. Without `setIgnoreMouseEvents(true)` it would
        // swallow EVERY mouse event on that screen — the user could not drag,
        // click, or interact with anything (and neither could the app the agent
        // is driving). Making it click-through lets pointer events pass straight
        // through to the windows beneath, which is the whole point of a passive
        // "agent in control" indicator (Req 12.1).
        window.setIgnoreMouseEvents(true)
        window.setFocusable(false)

        window.on('closed', () => {
            this.indicator = null
        })

        loadIndicatorRenderer(window)

        this.indicator = window
        return window
    }

    /**
     * Show the sandboxed-desktop live view in a SEPARATE, standalone window
     * (the noVNC view). Kept out of the Console so the
     * Console stays its own always-visible window and the desktop can be
     * watched, moved, or resized independently. Reuses the window if already
     * open, just re-pointing it at `url`.
     */
    showDesktopWindow(url: string): BrowserWindow {
        if (this.desktop && !this.desktop.isDestroyed()) {
            void this.desktop.loadURL(url)
            this.desktop.show()
            return this.desktop
        }
        const window = new BrowserWindow({
            width: 1320,
            height: 900,
            title: 'Sandboxed Desktop — Computer or Browser Use',
            backgroundColor: '#20203a',
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false
            }
        })
        window.on('closed', () => {
            this.desktop = null
        })
        void window.loadURL(url)
        this.desktop = window
        return window
    }

    /** Close the standalone desktop view window, if open. */
    closeDesktopWindow(): void {
        if (this.desktop && !this.desktop.isDestroyed()) {
            this.desktop.close()
        }
        this.desktop = null
    }

    /** The current Control_Indicator overlay, or null if none exists. */
    getIndicator(): BrowserWindow | null {
        if (this.indicator && this.indicator.isDestroyed()) {
            this.indicator = null
        }
        return this.indicator
    }

    /** Whether the agent is currently flagged as in control. */
    isInControl(): boolean {
        return this.inControl
    }

    /**
     * Drive the Control_Indicator's visibility in strict lockstep with the
     * "agent in control" flag (Req 12.1, 12.2).
     *
     * - `setInControl(true)` shows the overlay (creating it if necessary),
     *   without taking focus (`showInactive`), so the persistent "agent in
     *   control" indicator is visible while the agent acts.
     * - `setInControl(false)` hides the overlay, removing the indicator the
     *   moment the agent is no longer in control (loop ended, paused, or
     *   stopped).
     *
     * This is the single place indicator visibility changes, which is what makes
     * "indicator shown iff in control" a maintainable invariant the Safety gate
     * (task 11.4) can rely on.
     *
     * @returns the resulting visibility (mirrors the in-control flag).
     */
    setInControl(inControl: boolean): boolean {
        this.inControl = inControl
        if (inControl) {
            const window = this.createIndicator()
            // showInactive keeps the overlay non-focusing (Req 12.1).
            window.showInactive()
        } else {
            const window = this.getIndicator()
            window?.hide()
        }
        return this.inControl
    }
}
