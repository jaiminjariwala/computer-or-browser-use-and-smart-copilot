import { screen } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * Pure BrowserWindow option factories + window constants (Task 3.1).
 *
 * The security-critical configuration for both Click Operator windows lives
 * here as PURE functions so it can be asserted headlessly in unit tests without
 * launching Electron (mirrors Click Copilot's `windows.ts`). The stateful
 * lifecycle lives in `manager.ts`.
 *
 * Both renderers are locked down per the design — `contextIsolation: true`,
 * `nodeIntegration: false`, `sandbox: true` — and reach main only through the
 * typed preload bridge. No privileged capability is exposed to a renderer.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Console_Window dimensions, in logical pixels. */
export const CONSOLE_WIDTH = 720
export const CONSOLE_HEIGHT = 640

/**
 * The always-on-top level used for the Console_Window. "floating" keeps the
 * console above normal application windows without competing with the much
 * higher screen-saver level reserved for the Control_Indicator overlay.
 */
export const CONSOLE_ALWAYS_ON_TOP_LEVEL = 'floating' as const

/**
 * The always-on-top level used for the Control_Indicator overlay.
 * "screen-saver" is the highest standard level, keeping the transparent
 * "agent in control" indicator above every other window — including the
 * Console_Window's "floating" level and full-screen apps — so the user can
 * always see (and reach the on-screen Emergency_Stop on) it while the agent
 * drives the computer (Req 7.2, 12.1).
 */
export const INDICATOR_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const

/** A display rectangle (logical pixels), as reported by Electron's `screen`. */
export interface DisplayBounds {
    x: number
    y: number
    width: number
    height: number
}

// ---------------------------------------------------------------------------
// Pure window-option factories (unit-testable, no Electron runtime needed)
// ---------------------------------------------------------------------------

/**
 * Build the BrowserWindow options for the Console_Window.
 *
 * Extracted as a pure function so the security-critical configuration
 * (frameless, floating always-on-top, contextIsolation on, nodeIntegration
 * off, sandbox on) can be unit-tested without launching Electron.
 */
export function createConsoleWindowOptions(
    preloadPath: string
): BrowserWindowConstructorOptions {
    return {
        width: CONSOLE_WIDTH,
        height: CONSOLE_HEIGHT,
        minWidth: 360,
        minHeight: 420,
        show: false,
        // Frameless floating panel (Req 12.1). On macOS we keep the native
        // traffic-light controls but inset them into our custom draggable
        // title bar (the renderer marks that region `-webkit-app-region: drag`).
        frame: false,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 14, y: 18 },
        resizable: true,
        // Keep the console above normal windows while shown.
        alwaysOnTop: true,
        fullscreenable: false,
        skipTaskbar: false,
        webPreferences: {
            preload: preloadPath,
            // Sandboxed renderer reaching main only via the preload bridge.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    }
}

/**
 * Build the BrowserWindow options for the Control_Indicator overlay.
 *
 * Extracted as a pure function (like {@link createConsoleWindowOptions}) so the
 * transparency / frameless / non-focusable / full-display configuration can be
 * unit-tested without launching Electron. The window is positioned and sized to
 * exactly cover the given display so the indicator is visible across the whole
 * screen. The screen-saver always-on-top level and all-Spaces visibility are
 * applied separately after construction (see `WindowManager.createIndicator`).
 *
 * Critically, the overlay is **non-focusable** (`focusable: false`) so it never
 * steals focus from the app the agent is operating (Req 12.1).
 */
export function createIndicatorWindowOptions(
    preloadPath: string,
    bounds: DisplayBounds
): BrowserWindowConstructorOptions {
    return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        show: false,
        // Transparent, frameless overlay surface (Req 12.1).
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        // The overlay tracks a fixed display; it must not be resized or moved.
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Sit above all other windows while the agent is in control (Req 7.2, 12.1).
        alwaysOnTop: true,
        // Never take focus from the app the agent is operating (Req 12.1).
        focusable: false,
        // Allow the overlay to exactly match displays larger than the primary.
        enableLargerThanScreen: true,
        webPreferences: {
            preload: preloadPath,
            // Sandboxed renderer reaching main only via the preload bridge.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    }
}

/**
 * Resolve the bounds of the display the user is currently working on.
 *
 * Uses the display nearest the cursor so the indicator appears on the screen
 * the user is looking at in a multi-monitor setup, falling back to the primary
 * display.
 */
export function getActiveDisplayBounds(): DisplayBounds {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay()
    return display.bounds
}
