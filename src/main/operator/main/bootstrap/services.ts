import { app, type BrowserWindow } from 'electron'
import type {
    EnvironmentId,
    ModelProvider,
    ModelProviderConfig,
    PermissionSnapshot,
    ReasoningContext,
    RoutedOutcome
} from '@op-shared/types'
import { WindowManager } from '../windows'
import { SessionManager } from '../session'
import { SessionStore } from '../session-store'
import { ConfigStore } from '../config'
import {
    emitStateChanged,
    emitTrajectoryAppended,
    emitConfirmationRequired,
    emitIndicatorShow,
    emitIndicatorHide,
    emitError,
    emitHelpRequired
} from '../ipc'
import { PerceptionService } from '../perception'
import { ProviderChainRouter } from '../reasoning'
import { createSafetyController, type SafetyController } from '../safety'
import { createActionExecutor } from '../executor'
import { createAgentLoop, type AgentLoop, type LoopEmitters, type LoopReasoning } from '../loop'
import {
    LocalEnvironment,
    ContainerDesktopEnvironment,
    PlaywrightBrowserEnvironment,
    EnvironmentRouter
} from '../environment'
import { Summarizer, summarizeTrajectorySteps } from '../summarizer'
import { SessionMemory } from '../memory'
import { createElectronPermissionProbe, getPermissionSnapshot } from '../permissions'
import { createModelProvider } from '../providers/model-provider'

/**
 * Service construction for the Click Operator main process (extracted from the
 * `app.whenReady` body so the entry stays a thin orchestrator).
 *
 * ## Wiring topology
 *
 * The Agent Loop is the orchestrator; every collaborator is dependency-injected:
 *
 *  Perception ─┐
 *  Reasoning ──┤   (ProviderChain router, rebuilt per step from the Config store)
 *  Safety ─────┼──▶ AgentLoop ──▶ emitters ──▶ main→renderer IPC channels
 *  Executor ───┤        │
 *  Session ────┘        └──▶ SessionStore (persist / restore / archive)
 *
 *  - The **Safety Controller** is the single execution chokepoint: the loop
 *    routes every proposed Action through it, its Emergency_Stop halts the loop
 *    (`loop.handleHalt`), and it owns the Control_Indicator visibility state.
 *  - The **Window Manager** shows/hides the Control_Indicator overlay in lockstep
 *    with in-control state (driven by the loop's indicator emitters), and its
 *    availability feeds back into the Safety gate (Req 12.4).
 *
 * The loop and the Safety Controller are mutually referential (the loop routes
 * Actions through the controller; the controller halts the loop), which is why
 * both are constructed here with the loop referenced through a mutable binding.
 */
export interface OperatorServices {
    /** Owns the Console_Window + Control_Indicator overlay. */
    windows: WindowManager
    /** Provider chain / credential configuration store. */
    configStore: ConfigStore
    /** Persisted session store (restore / archive / flush). */
    sessions: SessionStore
    /** Evict deleted archives from in-memory recall caches. */
    forgetSessionMemories: (ids: readonly string[]) => void
    /** Session / Trajectory Manager (records Goal, autonomy, budget, steps). */
    sessionManager: SessionManager
    /** The perceive→reason→act orchestrator. */
    loop: AgentLoop
    /** The single execution chokepoint + Emergency_Stop owner. */
    safety: SafetyController
    /** Read the live macOS permission snapshot (re-read each call for revocation). */
    readPermissions: () => PermissionSnapshot
    /** The current Console_Window (most main→renderer events target it). */
    consoleWindow: () => BrowserWindow | null
    /** Select the active Execution_Environment for the next run (Req 22.2). */
    selectEnvironment: (id: EnvironmentId) => Promise<void>
    /** Open the standalone live desktop window for the container backend. */
    openDesktopView: () => void
    /** Close the standalone live desktop window. */
    closeDesktopView: () => void
}

/**
 * Construct every privileged service and wire the Agent Loop, Safety Controller,
 * Window Manager, and persistence together. Behaviour is identical to the
 * original inline `app.whenReady` construction — this is a pure reorganization.
 */
export interface OperatorServiceOptions {
    /**
     * Accessor for the HOST window that receives every main -> renderer operator
     * event. In the merged Click Copilot build this is the existing Sidebar
     * window, so the operator activity renders inside the copilot chat rather
     * than a separate Console_Window. When omitted, falls back to the operator's
     * own Console_Window (the standalone Click Operator behavior).
     */
    getHostWindow?: () => BrowserWindow | null
}

export function createOperatorServices(options: OperatorServiceOptions = {}): OperatorServices {
    // -----------------------------------------------------------------------
    // Windows + stores
    // -----------------------------------------------------------------------
    const windows = new WindowManager()

    const configStore = new ConfigStore()
    const sessions = new SessionStore({ userDataDir: app.getPath('userData') })
    const memory = new SessionMemory(sessions)

    const permissionProbe = createElectronPermissionProbe()
    const readPermissions = (): PermissionSnapshot => getPermissionSnapshot(permissionProbe)

    // Operator events target the host (Sidebar) window when merged into Click
    // Copilot; otherwise the standalone Console_Window.
    const consoleWindow = (): BrowserWindow | null =>
        options.getHostWindow?.() ?? windows.getConsole()

    // -----------------------------------------------------------------------
    // Session / Trajectory Manager + persistence + summarization seams
    // -----------------------------------------------------------------------
    // Constructed before the Summarizer so the manager's `onStepAppended` hook
    // can reference it lazily (the Summarizer's sink is the manager itself).
    let summarizer: Summarizer | null = null
    const sessionManager = new SessionManager({
        hooks: {
            // Persist the active session after every mutation (Req 18.1). The
            // store serializes writes, so fire-and-forget is safe.
            onSessionChanged: (session) => {
                void sessions.save(session)
            },
            // Drive summarization off appended steps (Req 4.2).
            onStepAppended: (step, session) => summarizer?.onStepAppended(step, session),
            // Preserve the prior session when a new one replaces it (Req 18.4).
            // Remember it synchronously so the next run can recall it even while
            // the serialized archive write is still queued.
            onArchive: (session) => {
                memory.remember(session)
                void sessions.archive(session)
            }
        }
    })

    // Fold older successful steps locally: this keeps long-run context useful
    // without spending a second model call or persisting raw screenshots/typed text.
    summarizer = new Summarizer({
        summarize: async (steps, prev) => summarizeTrajectorySteps(steps, prev),
        store: sessionManager
    })

    // -----------------------------------------------------------------------
    // Perception, Reasoning (ProviderChain), Executor
    // -----------------------------------------------------------------------
    const perception = new PerceptionService({
        // Capture only while an active, user-started session is running (Req 2.5).
        isSessionActive: () => sessionManager.isActingAllowed()
    })

    /**
     * Build the ordered {@link ModelProvider} chain from the Config store: the
     * Provider_Chain order first, then any providers not referenced by the
     * chain. Each provider resolves its (encrypted) key lazily from the store.
     */
    const buildProviderChain = async (): Promise<ModelProvider[]> => {
        const config = await configStore.readConfig()
        const byId = new Map(config.providers.map((p) => [p.id, p]))
        const ordered: ModelProviderConfig[] = []
        const used = new Set<string>()
        for (const id of config.chain.providerIds) {
            const p = byId.get(id)
            if (p && !used.has(id)) {
                ordered.push(p)
                used.add(id)
            }
        }
        for (const p of config.providers) {
            if (!used.has(p.id)) {
                ordered.push(p)
                used.add(p.id)
            }
        }
        return ordered.map((cfg) =>
            createModelProvider(cfg, { getApiKey: () => configStore.getProviderKey(cfg.id) })
        )
    }

    // The loop's reasoning entry point rebuilds the ProviderChain per step so
    // provider/config edits take effect on the next Reasoning_Step (Req 21.3, 21.4).
    // Related completed-session summaries are loaded from local storage once per
    // goal and injected as bounded, untrusted hints; the current goal/screen
    // always remain authoritative.
    const reasoning: LoopReasoning = {
        reason: async (ctx: ReasoningContext): Promise<RoutedOutcome> => {
            const priorMemories = await memory.recall(
                ctx.goal,
                sessionManager.getSession()?.id
            )
            const enrichedContext: ReasoningContext =
                priorMemories.length > 0 ? { ...ctx, priorMemories } : ctx
            const providers = await buildProviderChain()
            return new ProviderChainRouter(providers).reason(enrichedContext)
        }
    }

    const executor = createActionExecutor({
        // Native CGEvent backend when compiled, else cliclick fallback, else null
        // (selected internally by createActionExecutor).
        emitError: (error) => emitError(consoleWindow(), error)
    })

    // The Execution_Environment seam (Req 22): the loop drives Perception +
    // Action Execution through ONE interface. The macOS desktop is the default
    // (Local) backend, wrapping the perception + executor above and folding the
    // Screen Recording + Accessibility permissions into its health check. The
    // sandboxed-browser backend implements the same interface and can be
    // selected per session without any change to the loop or safety controls.
    const localEnvironment = new LocalEnvironment({
        perception,
        executor,
        getPermissions: readPermissions
    })
    // The full virtual desktop: a sandboxed Linux desktop in a Docker container
    // with a live noVNC view. Constructing it is cheap — the container is only
    // started when the user selects it.
    const containerEnvironment = new ContainerDesktopEnvironment({})
    // A real scriptable web browser (Playwright): DOM-aware perception + click
    // snapping make browser tasks far more reliable than pixel-only control.
    // Constructing it is cheap — Chromium only launches when selected + started.
    const browserEnvironment = new PlaywrightBrowserEnvironment({})
    const environment = new EnvironmentRouter(
        {
            local: localEnvironment,
            'container-desktop': containerEnvironment,
            browser: browserEnvironment
        },
        'local'
    )

    // The loop's permission view is environment-aware: the sandboxed backends
    // need no macOS Screen Recording / Accessibility, so those clauses are
    // satisfied when either is active (Req 22.5). The Settings UI still shows
    // the real macOS permissions via `readPermissions`.
    const loopPermissions = (): PermissionSnapshot =>
        environment.id === 'local'
            ? readPermissions()
            : { screenRecording: 'granted', accessibility: 'granted' }

    // -----------------------------------------------------------------------
    // Safety Controller (single execution chokepoint) + the loop it halts
    // -----------------------------------------------------------------------
    let agentLoop: AgentLoop | null = null
    const safety: SafetyController = createSafetyController({
        emitError: (error) => emitError(consoleWindow(), error),
        // Emergency_Stop / indicator-unavailable both halt the loop (Req 7.3, 12.4).
        haltLoop: () => agentLoop?.handleHalt(),
        // Record the stop event in the Trajectory (Req 7.6, 14.5).
        recordSafetyEvent: (event) => {
            sessionManager.recordSafetyEvent(event)
        },
        // The on-screen Emergency_Stop fallback lives in the console (Req 7.8).
        showOnScreenFallback: () => windows.showConsole()
    })

    // Loop side-effect emitters → the design's main→renderer channels. The
    // indicator emitters drive the Control_Indicator overlay in lockstep with
    // in-control state and feed its availability back into the Safety gate.
    const emitters: LoopEmitters = {
        emitState: (view) => emitStateChanged(consoleWindow(), view),
        emitTrajectoryAppended: (step) => emitTrajectoryAppended(consoleWindow(), step),
        emitConfirmationRequired: (req) => emitConfirmationRequired(consoleWindow(), req),
        emitIndicatorShow: () => {
            // Show the overlay; if it cannot be displayed, tell the Safety
            // Controller so the gate blocks (and the loop halts) per Req 12.4.
            let available = true
            try {
                windows.setInControl(true)
            } catch {
                available = false
            }
            safety.setIndicatorAvailable(available)
            if (available) emitIndicatorShow(consoleWindow())
        },
        emitIndicatorHide: () => {
            try {
                windows.setInControl(false)
            } catch {
                // best-effort hide
            }
            emitIndicatorHide(consoleWindow())
        },
        emitError: (error) => emitError(consoleWindow(), error),
        // The agent's question is surfaced to the chat so the user can answer it
        // (the answer becomes session guidance and the loop resumes).
        presentHelp: (question) => emitHelpRequired(consoleWindow(), question)
        // presentCompletion is intentionally omitted: the completion step is
        // already recorded in the Trajectory (emitted via `trajectory:appended`)
        // and the terminal state is broadcast on `state:changed`.
    }

    agentLoop = createAgentLoop({
        // Perception + Action Execution both flow through the active Environment
        // (Req 22.6); the loop no longer knows which backend it is driving.
        perception: environment,
        reasoning,
        safety,
        executor: environment,
        session: sessionManager,
        // The gate re-reads permissions each evaluation so a mid-session
        // revocation fails closed on the next Action (Req 16.3, 17.3). Uses the
        // environment-aware view so the sandbox is not gated on macOS perms.
        getPermissions: loopPermissions,
        emitters
    })

    return {
        windows,
        configStore,
        sessions,
        forgetSessionMemories: (ids: readonly string[]) => memory.forget(ids),
        sessionManager,
        loop: agentLoop,
        safety,
        readPermissions,
        consoleWindow,
        // Switch the active Execution_Environment before a run (Req 22.2). The
        // start gate calls this after creating the session and before starting.
        selectEnvironment: (id: EnvironmentId) => environment.selectEnvironment(id),
        // The live sandboxed-desktop view opens in its OWN window (kept separate
        // from the Console) pointing at the container's noVNC endpoint.
        openDesktopView: () => windows.showDesktopWindow(containerEnvironment.novncUrl()),
        closeDesktopView: () => windows.closeDesktopWindow()
    }
}
