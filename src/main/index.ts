import { app, BrowserWindow, ipcMain, globalShortcut, session, nativeImage } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { readFile, unlink } from 'fs/promises'
import type { TurnCapture } from '@shared/types'
import {
    registerConfigIpc,
    emitCredentialsRequiredIfMissing,
    HOSTED_FALLBACKS,
    type HostedFallbackId
} from './config'
import { registerGitHubAuthIpc } from './github-auth'
import {
    registerGlassIpc,
    emitError,
    emitPending,
    emitTurnAppended,
    emitSessionState,
    emitSummary,
    emitCaptureStaged,
    emitGatewayFallback
} from './ipc'
import { HotkeyManager, applyRegistrationResult } from './hotkey'
import { TrayManager } from './tray'
import { SessionManager } from './session'
import { SessionStore } from './session-store'
import { GatewayAIClient } from './ai'
import { ChatFlow } from './chat-flow'
import { Summarizer } from './summarizer'
import { WindowManager } from './windows'
import { checkScreenPermission } from './permissions'
import { CaptureService } from './capture'
import { CaptureOrchestrator } from './capture-orchestrator'
// Merged Click Operator engine (autonomous computer-use agent). Vendored under
// `./operator` as a self-contained subtree with `op:`-prefixed IPC channels so
// it never collides with Click Copilot's own services.
import { createOperatorServices } from './operator/main/bootstrap/services'
import { createStartGoalHandler } from './operator/main/bootstrap/start-gate-runner'
import { wireOperatorIpc } from './operator/main/bootstrap/ipc-wiring'
import { createEmergencyStopManager, type HotkeyManager as OperatorHotkeyManager } from './operator/main/hotkey'

/**
 * Entry point for the Glass main process.
 *
 * Launches the sidebar BrowserWindow and wires the Config / Credential Store
 * IPC (task 3). The Sidebar/Overlay window managers and remaining services are
 * filled in by their respective tasks.
 */

// Display name shown in the macOS menu bar / Dock (in dev this is otherwise
// "Electron"). The packaged app name comes from electron-builder's productName.
app.setName('Computer or Browser Use and Smart Copilot')

let mainWindow: BrowserWindow | null = null
let hotkeyManager: HotkeyManager | null = null
let trayManager: TrayManager | null = null
let windowManager: WindowManager | null = null
// Operator engine long-lived singletons (cleanup on quit).
let operatorHotkey: OperatorHotkeyManager | null = null

/**
 * Enforce a single running instance. Click Copilot is a global-hotkey app, so a
 * stray second instance (e.g. left over from a dev restart) would grab the
 * Cmd+Shift+D shortcut and pop up its OWN window when you capture. The lock
 * makes any second launch quit immediately and just focus the window we already
 * have, so a capture always lands in the one live window.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
    app.quit()
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
        }
    })
}
let disposeOperatorIpc: (() => void) | null = null
let disposeOperatorConfigIpc: (() => void) | null = null
let disposeGitHubAuthIpc: (() => void) | null = null
let flushOperatorSessions: (() => Promise<void>) | null = null

/**
 * Show and focus the Sidebar_Panel, creating it if necessary. Used by the
 * menu-bar (Tray) fallback when the hotkey could not be registered (Req 1.5).
 */
function showSidebar(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
    }
    mainWindow?.show()
    mainWindow?.focus()
}

/**
 * Toggle the Sidebar_Panel: show+focus when hidden, hide when visible
 * (Req 1.2, 1.3). Creates the window on first use so the hotkey works even
 * before the sidebar has been shown.
 */
function toggleSidebar(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
        mainWindow?.show()
        mainWindow?.focus()
        return
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide()
    } else {
        mainWindow.show()
        mainWindow.focus()
    }
}

function createWindow(): void {
    // Never create a second sidebar: if one already exists, just reveal it.
    // Without this guard an accidental call would orphan the old window,
    // leaving a stray "extra" Click Copilot window on screen.
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        return
    }

    mainWindow = new BrowserWindow({
        // Desktop-first workspace: the ~300px chat rail stays visible beside a
        // useful conversation canvas at launch. Narrow resizing still switches
        // the rail to its responsive overlay behavior.
        width: 1040,
        height: 760,
        minWidth: 680,
        minHeight: 520,
        show: false,
        // Frameless floating panel: removes the native title bar (and its
        // centered title) while keeping the macOS traffic-light buttons.
        frame: false,
        titleBarStyle: 'hidden',
        // Default to a NORMAL window (not pinned on top) so it behaves like any
        // other app window and can sit behind others. The user can pin it on top
        // from the header when they want the floating-panel behavior.
        alwaysOnTop: false,
        fullscreenable: false,
        // Show the app in the macOS Dock like a normal app (skipTaskbar would
        // hide the Dock tile on macOS).
        skipTaskbar: false,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    })

    mainWindow.on('closed', () => {
        mainWindow = null
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow?.show()
    })

    // electron-vite injects ELECTRON_RENDERER_URL during `dev`.
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        mainWindow.loadURL(`${devServerUrl}/sidebar/index.html`)
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/sidebar/index.html'))
    }
}

app.whenReady().then(async () => {
    // A second instance never sets anything up; it already asked the primary to
    // focus (see 'second-instance' above) and is quitting.
    if (!gotSingleInstanceLock) return

    // Dock icon: a packaged build gets its icon from the app bundle (set by
    // electron-builder), but `electron-vite dev` runs the stock Electron binary,
    // which shows the default Electron icon in the Dock. Set our custom icon at
    // runtime so the dev build's Dock icon matches the packaged app.
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
        const devIconPath = join(process.cwd(), 'build', 'icon-1024.png')
        try {
            app.dock.setIcon(devIconPath)
        } catch {
            // Non-fatal: a missing/unloadable dev icon just leaves the default.
        }
    }

    // Allow camera/microphone only for the trusted sidebar renderer. Dictation
    // requests audio; the local video recorder requests video and, when
    // available, audio. Every other permission and renderer is denied.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const trustedSidebar = mainWindow !== null && webContents === mainWindow.webContents
        callback(permission === 'media' && trustedSidebar)
    })

    // Config / Credential Store IPC + prompt when credentials are missing.
    // `onSaved` re-seeds the operator provider chain from the just-saved keys so
    // adding a key in Settings makes the operator usable at once (no restart).
    // Assigned a no-op until the operator services exist; replaced below.
    let seedOperatorProviders: () => Promise<void> = async () => { }
    const configStore = registerConfigIpc({
        getSidebarWindow: () => mainWindow,
        onSaved: () => seedOperatorProviders()
    })

    // GitHub uses OAuth Device Flow in the privileged main process. The public
    // client id is build/runtime configuration; no client secret is bundled,
    // and the encrypted access token never crosses the preload boundary.
    const githubAuth = registerGitHubAuthIpc({ getSidebarWindow: () => mainWindow })
    disposeGitHubAuthIpc = githubAuth.dispose

    // Persistent session store: writes the active session to
    // `userData/sessions/current.json` after each change and loads it on launch
    // (Req 9.2, 9.3). Kept separate from the manager so disk I/O never collides
    // with concurrent in-memory edits; writes are coalesced/serialized inside.
    const sessionStore = new SessionStore()

    // Session Manager: in-memory source of truth for the active conversation.
    // The `onTurnAppended` hook drives the Summarizer (wired below); it is
    // referenced lazily so the manager can be constructed before the client.
    // The `onSessionChanged` hook persists the active session after every
    // mutation (append/new/restore) so it survives a restart (Req 9.2). The
    // fire-and-forget save is safe because the store serializes writes.
    let summarizer: Summarizer | null = null
    const sessionManager = new SessionManager({
        hooks: {
            onTurnAppended: (turn, session) => summarizer?.onTurnAppended(turn, session),
            onSessionChanged: (session) => {
                void sessionStore.save(session)
                // Push the running goal/step summary to the tracker UI.
                emitSummary(mainWindow, session.summary)
            }
        }
    })

    // Restore the most recent session before the sidebar requests it via
    // `session:get`, so the prior conversation is rendered on launch (Req 9.3).
    // A missing/corrupt file yields null and the fresh empty session is kept.
    const restored = await sessionStore.load()
    if (restored) {
        sessionManager.restore(restored)
    }

    // AI Gateway client, backed by the Config / Credential Store so settings
    // changes take effect on the next request (Req 7.2).
    const aiClient = new GatewayAIClient({
        getConfig: () => configStore.readConfig(),
        getApiKey: () => configStore.getApiKey(),
        getFallbackConfig: async () => {
            const cfg = await configStore.readConfig()
            const baseURL = cfg.fallbackBaseURL ?? ''
            const model = cfg.fallbackModel ?? ''
            return baseURL && model ? { baseURL, model } : null
        },
        getFallbackApiKey: () => configStore.getFallbackApiKey(),
        // Built-in free hosted chain (OpenRouter -> GLM -> Gemini), tried after
        // the primary + Ollama fallback and before the on-device model.
        getFallbackProviders: () => configStore.getHostedFallbacks()
    })

    // Summarizer: folds older turns into the running summary once the unfolded
    // backlog crosses the threshold, keeping each request bounded (Req 6). The
    // threshold is lowered to 5 so the goal/step tracker populates earlier in a
    // session rather than only after a long backlog accumulates.
    summarizer = new Summarizer({ client: aiClient, store: sessionManager, threshold: 5 })

    // Route an assistant answer to the chat it was ASKED in (its origin), even
    // if the user has since switched or created a new chat. When the origin is
    // still the active session the turn appends + emits live; otherwise the
    // answer is written to the origin's archived copy on disk so it is there
    // when the user reopens that chat. Pending is cleared for the active session
    // only (a background chat has no live spinner to clear).
    const deliverAssistant = async (sessionId: string, text: string): Promise<void> => {
        const active = sessionManager.getSession()
        if (!sessionId || active.id === sessionId) {
            const turn = sessionManager.appendAssistantText(text)
            emitTurnAppended(mainWindow, turn)
            emitPending(mainWindow, false)
            return
        }
        await appendToArchived(sessionId, text, 'ok')
    }

    // Deliver a failure to the origin chat. Active origin -> surface the error
    // banner + clear pending; a background origin gets a persisted error turn so
    // the user sees "could not answer" when they return to that chat.
    const deliverErrorTurn = async (sessionId: string, message: string): Promise<void> => {
        const active = sessionManager.getSession()
        if (!sessionId || active.id === sessionId) {
            emitError(mainWindow, { kind: 'render-failed', message, recoverable: true })
            emitPending(mainWindow, false)
            return
        }
        await appendToArchived(sessionId, message, 'error')
    }

    // Append an assistant turn to an archived (on-disk) session that is no
    // longer the active conversation. Best-effort: a missing/corrupt archive is
    // skipped rather than throwing, since the request already left that chat.
    const appendToArchived = async (
        sessionId: string,
        text: string,
        status: 'ok' | 'error'
    ): Promise<void> => {
        const stored = await sessionStore.readSessionById(sessionId)
        if (!stored) return
        const createdAt = new Date().toISOString()
        stored.turns.push({
            id: randomUUID(),
            role: 'assistant',
            text,
            createdAt,
            status
        })
        stored.updatedAt = createdAt
        await sessionStore.archive(stored)
    }

    // Flow A orchestrator: append+emit user turn, call the gateway, append+emit
    // the assistant turn, and toggle pending around the request (design "Flow A").
    const chatFlow = new ChatFlow({
        // Wrap the manager with the origin-routing seams so a slow answer lands
        // in the chat it was asked in, not whatever chat is active on arrival.
        session: {
            appendUserText: (t) => sessionManager.appendUserText(t),
            appendUserCapture: (c, t) => sessionManager.appendUserCapture(c, t),
            appendUserCaptures: (c, t) => sessionManager.appendUserCaptures(c, t),
            appendAssistantText: (t, s) => sessionManager.appendAssistantText(t, s),
            buildContext: (c) => sessionManager.buildContext(c),
            activeSessionId: () => sessionManager.getSession().id,
            deliverAssistant
        },
        ai: aiClient,
        emitters: {
            turnAppended: (turn) => emitTurnAppended(mainWindow, turn),
            pending: (pending) => emitPending(mainWindow, pending),
            error: (error) => emitError(mainWindow, error),
            credentialsRequired: () =>
                mainWindow?.webContents.send('credentials:required'),
            // When the gateway fails, hand off to the renderer's zero-config
            // local fallback model instead of just erroring. `originId` rides
            // along so the fallback answer returns to the origin chat.
            fallbackNeeded: (ctx, originId) =>
                emitGatewayFallback(mainWindow, ctx, originId)
        }
    })

    // Window Manager owns the on-demand transparent Overlay_Window used for
    // region capture (task 8.1). The sidebar window remains managed directly
    // above; the manager is used here for the overlay lifecycle.
    windowManager = new WindowManager()

    // Capture Service: captures the active display and crops it to the selected
    // rectangle, producing a base64 PNG + thumbnail (task 8.2). The send-to-
    // gateway half of Flow B lands in task 8.3.
    const captureService = new CaptureService()

    // Capture orchestrator: stitches the permission gate, overlay, Capture
    // Service, and ChatFlow into the three capture IPC handlers (Flow B). Kept
    // in its own Electron-free module so the pipeline is testable end-to-end
    // (task 8.4) through the real production logic.
    const captureOrchestrator = new CaptureOrchestrator({
        checkPermission: (options) => checkScreenPermission(options),
        captureService,
        overlay: windowManager,
        // No follow-up typed during capture -> park the shot in the carousel
        // above the input so the user can add more or type later.
        stageCapture: (capture) => emitCaptureStaged(mainWindow, capture),
        // Follow-up typed during capture -> send screenshot + text to the chat
        // and run the AI immediately (the fast capture-and-ask path).
        chatFlow,
        emitError: (error) => emitError(mainWindow, error)
    })

    // Capture via macOS's NATIVE `screencapture` tool, then stage the shot in the
    // carousel above the input. Bound to the app's own shortcuts (below), so a
    // screenshot only lands in this app when the user presses OUR shortcut —
    // their normal macOS screenshots go wherever they intend. Writing to a temp
    // file (not the clipboard) makes a user cancel unambiguous (no file) and
    // never disturbs the clipboard.
    //   - 'region' -> `-i` interactive crosshair selection (Space toggles window)
    //   - 'window' -> `-iW` interactive window pick (the toolbar-style option)
    //   - 'full'   -> whole main display
    const captureViaMacScreenshot = async (
        mode: 'region' | 'window' | 'full' = 'region'
    ): Promise<void> => {
        const tmpPath = join(tmpdir(), `capture-${randomUUID()}.png`)
        const args =
            mode === 'full'
                ? ['-m', tmpPath]
                : mode === 'window'
                    ? ['-iW', tmpPath]
                    : ['-i', tmpPath]
        await new Promise<void>((resolve) => {
            execFile('screencapture', args, () => resolve())
        })
        let buf: Buffer
        try {
            buf = await readFile(tmpPath)
        } catch {
            return // Cancelled: no file was written.
        }
        await unlink(tmpPath).catch(() => undefined)
        if (buf.length === 0) return
        const image = nativeImage.createFromBuffer(buf)
        if (image.isEmpty()) return
        const size = image.getSize()
        const thumb = image.resize({ width: Math.min(size.width, 320) })
        const capture: TurnCapture = {
            dataUrl: image.toDataURL(),
            thumbnailUrl: thumb.toDataURL(),
            rect: { x: 0, y: 0, width: size.width, height: size.height }
        }
        emitCaptureStaged(mainWindow, capture)
        showSidebar()
    }

    // Chat / capture / session IPC. The type-a-message flow is now wired to the
    // Session Manager + AI client via ChatFlow (Flow A); `session:get` returns
    // the active in-memory session so the sidebar can render it (Req 9.3).
    //
    // `capture:trigger` checks Screen_Recording_Permission FIRST: when granted
    // it shows the full-screen overlay (Req 4.1); otherwise it skips the overlay
    // and surfaces System Settings instructions via `error:show` (Req 8.1). The
    // overlay closes on a completed selection or cancel (Req 4.3, 4.4); the
    // crop + Flow B wiring lands in tasks 8.2 / 8.3.
    registerGlassIpc({
        getSidebarWindow: () => mainWindow,
        onSendMessage: (text) => chatFlow.handleSendMessage(text),
        onSendCaptures: (captures, text) => chatFlow.handleCaptures(captures, text),
        getSession: () => sessionManager.getSessionView(),
        onTriggerCapture: () => {
            void captureViaMacScreenshot('region')
        },
        onSubmitRegion: async (rect, text) => {
            // The user captured a region (incl. an optional follow-up question),
            // so surface the chat to show the incoming guidance.
            showSidebar()
            await captureOrchestrator.handleSubmitRegion(rect, text)
        },
        onCancelRegion: () => {
            captureOrchestrator.handleCancel()
        },
        // New Session (Req 9.1): archive the current conversation to
        // `sessions/<id>.json` so it is preserved, then start a fresh empty
        // session. `newSession()` fires `onSessionChanged`, which persists the
        // new empty `current.json`. Finally push the fresh session view to the
        // sidebar so the conversation view + summary clear.
        onNewSession: () => {
            // Only archive the current session if it actually has content, so
            // empty/never-used chats don't show up as "Untitled chat" later.
            const current = sessionManager.getSession()
            if (current.turns.length > 0) {
                void sessionStore.archive(current)
            }
            sessionManager.newSession()
            emitSessionState(mainWindow, sessionManager.getSessionView())
        },
        // Chat history: list past sessions and reopen one. Opening archives the
        // current conversation first (only if it has content, to avoid empty
        // archives), then restores the chosen session as the active one and
        // pushes it to the sidebar so the view updates.
        onListSessions: () => sessionStore.listSessions(),
        onOpenSession: async (id) => {
            const current = sessionManager.getSession()
            // The renderer synthesizes the current in-memory session alongside
            // archives. Its disk copy can be older, so selecting the live id is
            // a no-op rather than a restore from stale persisted history.
            if (current.id === id) return
            const chosen = await sessionStore.readSessionById(id)
            if (!chosen) return
            if (current.turns.length > 0) {
                await sessionStore.archive(current)
            }
            sessionManager.restore(chosen)
            emitSessionState(mainWindow, sessionManager.getSessionView())
        },
        onDeleteSessions: async (ids) => {
            await sessionStore.deleteSessions(ids)
            // If the chat currently open in the view was deleted, reset to a
            // fresh empty session and push it so the chat area clears at once
            // (otherwise the deleted conversation lingers until New is clicked).
            // `newSession()` does NOT archive, so the just-deleted chat is not
            // recreated.
            const active = sessionManager.getSession()
            if (active && ids.includes(active.id)) {
                sessionManager.newSession()
                emitSessionState(mainWindow, sessionManager.getSessionView())
            }
        },
        onListModels: () => aiClient.listModels().catch(() => []),
        onTranscribe: (audioBase64, format) =>
            aiClient.transcribe(audioBase64, format).catch(() => ''),
        // The renderer's local fallback model answered (or reported failure).
        // Route the result to the ORIGIN chat (via `originId`): a live answer if
        // that chat is still active, otherwise a persisted turn so it shows on
        // reopen. Handles pending/error itself through the deliver helpers.
        onFallbackResult: async (text, originId) => {
            const trimmed = (text ?? '').trim()
            if (trimmed.length > 0) {
                await deliverAssistant(originId, trimmed)
            } else {
                await deliverErrorTurn(
                    originId,
                    'The gateway was unavailable and the local fallback model could not answer. Check your gateway key in Settings.'
                )
            }
        }
    })

    createWindow()

    // App-owned capture shortcuts: a screenshot lands in this app ONLY when the
    // user presses one of OUR shortcuts, so their ordinary macOS screenshots
    // (for other apps) are never hijacked. Each runs the native `screencapture`
    // tool and stages the result above the input.
    //   ⌘⇧D — region (crosshair)   ⌘⇧F — window (toolbar-style pick)   ⌘⇧S — full
    globalShortcut.register('CommandOrControl+Shift+D', () => {
        void captureViaMacScreenshot('region')
    })
    globalShortcut.register('CommandOrControl+Shift+F', () => {
        void captureViaMacScreenshot('window')
    })
    globalShortcut.register('CommandOrControl+Shift+S', () => {
        void captureViaMacScreenshot('full')
    })

    // Register the Global_Hotkey so the user can summon Glass from any app
    // (Req 1.1, 1.6). Inspect the result and drive the conflict/failure
    // fallback (task 6.2): a conflict surfaces a "choose a different shortcut"
    // error (Req 1.4); any other failure surfaces a message and brings up the
    // menu-bar (Tray) icon that can open the sidebar (Req 1.5).
    trayManager = new TrayManager({ showSidebar })
    hotkeyManager = new HotkeyManager({ toggleSidebar })
    applyRegistrationResult(hotkeyManager.register(), {
        emitError: (error) => emitError(mainWindow, error),
        showTray: () => trayManager?.show()
    })

    // Let the user pick a different accelerator after a conflict (Req 1.4).
    // The renderer invokes this with the chosen accelerator; the result is run
    // back through the same fallback so a still-conflicting choice re-prompts.
    // Pin / unpin the window on top (the floating-panel behavior is now opt-in).
    ipcMain.handle('window:set-pinned', (_event, pinned: boolean): void => {
        const flag = Boolean(pinned)
        mainWindow?.setAlwaysOnTop(flag, 'floating')
        mainWindow?.setVisibleOnAllWorkspaces(flag, { visibleOnFullScreen: true })
    })

    ipcMain.handle('hotkey:reregister', (_event, accelerator: string): boolean => {
        if (!hotkeyManager || typeof accelerator !== 'string' || accelerator.length === 0) {
            return false
        }
        const result = hotkeyManager.reRegister(accelerator)
        applyRegistrationResult(result, {
            emitError: (error) => emitError(mainWindow, error),
            showTray: () => trayManager?.show()
        })
        return result.success
    })

    mainWindow?.webContents.once('did-finish-load', () => {
        void emitCredentialsRequiredIfMissing(configStore, mainWindow)
    })

    // -----------------------------------------------------------------------
    // Merged Click Operator engine
    // -----------------------------------------------------------------------
    // Construct + wire the autonomous operator engine. Every main -> renderer
    // operator event targets the existing Sidebar window (getHostWindow), so
    // the operator's live activity renders inside the Click Copilot chat rather
    // than a separate Console_Window. The engine owns its own (isolated)
    // provider config + session store and drives the Control_Indicator overlay
    // and the sandboxed-desktop noVNC view through its own Window Manager.
    const operatorServices = createOperatorServices({ getHostWindow: () => mainWindow })
    const handleStartGoal = createStartGoalHandler(operatorServices)
    const operatorIpc = wireOperatorIpc(operatorServices, handleStartGoal)
    disposeOperatorIpc = operatorIpc.disposeOperatorIpc
    disposeOperatorConfigIpc = operatorIpc.disposeConfigIpc
    flushOperatorSessions = () => operatorServices.sessions.flush()

    // Seed the operator's (isolated) provider chain from Click Copilot's stored
    // credentials, so the operator runs on whatever the user already configured
    // with no separate operator setup. Re-seeded every launch. The chain is the
    // user's primary OpenAI-compatible provider, then the same free hosted
    // providers the copilot uses (Gemini / GLM / OpenRouter), tried in order.
    // Defined as a function so it runs both now (launch) and after every
    // `config:save` (via the `onSaved` hook above), keeping the operator in sync
    // with keys the user adds while the app is running.
    seedOperatorProviders = async (): Promise<void> => {
        try {
            const glassCfg = await configStore.readConfig()
            const providers: Array<{
                id: string
                kind: 'openai-compatible' | 'local'
                baseURL: string
                model: string
                requiresKey: boolean
                apiKey?: string
            }> = []

            const primaryKey = await configStore.getApiKey()
            if (
                primaryKey &&
                primaryKey.trim().length > 0 &&
                glassCfg.baseURL.trim().length > 0 &&
                glassCfg.model.trim().length > 0
            ) {
                providers.push({
                    id: 'primary',
                    kind: 'openai-compatible',
                    baseURL: glassCfg.baseURL.trim(),
                    model: glassCfg.model.trim(),
                    requiresKey: true,
                    apiKey: primaryKey
                })
            }

            // Order matters: the operator tries these in sequence, so lead with
            // Gemini (the strongest free vision + tool-calling model), then GLM,
            // then the OpenRouter free router. The user's primary provider
            // (added above when configured) stays first.
            const hosted: Array<[HostedFallbackId, string]> = [
                ['gemini', glassCfg.geminiModel ?? ''],
                ['glm', glassCfg.glmModel ?? ''],
                ['openrouter', glassCfg.openrouterModel ?? '']
            ]
            for (const [id, modelOverride] of hosted) {
                const key = await configStore.getHostedKey(id)
                if (!key || key.trim().length === 0) continue
                const meta = HOSTED_FALLBACKS[id]
                providers.push({
                    id,
                    kind: 'openai-compatible',
                    baseURL: meta.baseURL,
                    model:
                        modelOverride.trim().length > 0 ? modelOverride.trim() : meta.defaultModel,
                    requiresKey: true,
                    apiKey: key
                })
            }

            if (providers.length > 0) {
                await operatorServices.configStore.saveProviders({
                    chain: { providerIds: providers.map((p) => p.id) },
                    providers
                })
            }
        } catch {
            // Best-effort: a seeding failure just leaves the operator
            // unconfigured, which surfaces as a normal "configure a provider"
            // error on start.
        }
    }
    await seedOperatorProviders()

    // Restore the most recent operator task for review (acting stays gated
    // behind an explicit start, Req 18.3).
    const restoredOperator = await operatorServices.sessions.load()
    if (restoredOperator) {
        operatorServices.sessionManager.restore(restoredOperator)
    }

    // Emergency_Stop hotkey (⌘⇧Esc). Registering through the Safety Controller
    // records the result; a failed registration blocks starting an operator
    // task while the on-screen fallback stays available (Req 7.7, 7.8).
    operatorHotkey = createEmergencyStopManager(operatorServices.safety)
    operatorServices.safety.registerHotkey(operatorHotkey)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// Release the Global_Hotkey on quit so the OS-level binding is cleared.
app.on('will-quit', () => {
    hotkeyManager?.unregister()
    trayManager?.destroy()
    windowManager?.stopPencilFollow()
    // Operator engine teardown.
    operatorHotkey?.unregister()
    disposeOperatorIpc?.()
    disposeOperatorConfigIpc?.()
    disposeGitHubAuthIpc?.()
    void flushOperatorSessions?.()
})
