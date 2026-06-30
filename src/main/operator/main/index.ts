import { app, BrowserWindow } from 'electron'
import { emitCredentialsRequiredIfMissing } from './config-ipc'
import { createEmergencyStopManager, type HotkeyManager } from './hotkey'
import type { SessionStore } from './session-store'
import { createOperatorServices } from './bootstrap/services'
import { createStartGoalHandler } from './bootstrap/start-gate-runner'
import { wireOperatorIpc } from './bootstrap/ipc-wiring'

/**
 * Entry point for the Click Operator main process — FINAL INTEGRATION (Task 16.1).
 *
 * This module stays the electron-vite `main` entry: it runs on `app.whenReady`,
 * constructs every privileged service, wires the IPC channel map, and installs
 * the Emergency_Stop hotkey. The heavy lifting is delegated to `bootstrap/`:
 *
 *  - `bootstrap/services.ts`        — constructs + wires Perception, Reasoning,
 *    Safety, Executor, Session/Store, Windows, and the Agent Loop.
 *  - `bootstrap/start-gate-runner.ts` — the fail-closed `goal:start` gate that
 *    only calls `loop.start()` once the full precondition set holds.
 *  - `bootstrap/ipc-wiring.ts`      — registers both halves of the IPC map.
 *
 * The safety-critical guarantees are unchanged: the Safety Controller is the
 * single execution chokepoint, the Control_Indicator tracks in-control state in
 * lockstep, a failed Emergency_Stop registration blocks session start (Req 7.7),
 * and renderers reach main only through the typed preload bridge — there is
 * deliberately NO channel for capture, reasoning, or input synthesis.
 */

// Long-lived singletons kept for cleanup on quit.
let hotkeyManager: HotkeyManager | null = null
let sessionStore: SessionStore | null = null
let disposeOperatorIpc: (() => void) | null = null
let disposeConfigIpc: (() => void) | null = null

app.whenReady().then(async () => {
    // Construct + wire every privileged service (Windows, stores, Perception,
    // Reasoning, Safety, Executor, Agent Loop).
    const services = createOperatorServices()
    const { windows, configStore, sessions, sessionManager, safety, consoleWindow } = services
    sessionStore = sessions
    windows.createConsole()

    // The fail-closed start gate + the IPC channel map.
    const handleStartGoal = createStartGoalHandler(services)
    const disposers = wireOperatorIpc(services, handleStartGoal)
    disposeOperatorIpc = disposers.disposeOperatorIpc
    disposeConfigIpc = disposers.disposeConfigIpc

    // Restore the most recent session (Req 18.2). Acting stays gated behind an
    // explicit user start (Req 18.3, Property 22).
    const restored = await sessions.load()
    if (restored) {
        sessionManager.restore(restored)
    }

    // Emergency_Stop hotkey (Req 7.1, 7.5, 7.7). Registering through the Safety
    // Controller records the result so session start is blocked on failure while
    // the on-screen fallback stays available (Req 7.8).
    hotkeyManager = createEmergencyStopManager(safety)
    safety.registerHotkey(hotkeyManager)

    // Prompt for credentials on launch when a required key is missing (Req 15.4,
    // 15.7), once the console has loaded so the event is not dropped.
    const win = consoleWindow()
    win?.webContents.once('did-finish-load', () => {
        void emitCredentialsRequiredIfMissing(configStore, consoleWindow())
    })

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            windows.createConsole()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// Release OS-level bindings and flush pending session writes on quit.
app.on('will-quit', () => {
    hotkeyManager?.unregister()
    disposeOperatorIpc?.()
    disposeConfigIpc?.()
    void sessionStore?.flush()
})
