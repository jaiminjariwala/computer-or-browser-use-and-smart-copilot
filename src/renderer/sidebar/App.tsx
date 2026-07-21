import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GlassError, SessionListItem, SessionSummary, SessionView, TurnCapture, TurnView } from '@shared/types'
import type { ConfirmationRequest, LoopStateView, Playbook } from '@op-shared/types'
import type { SelectedEmail } from '@shared/types'
import { Settings } from './Settings'
import { ChatSidebar } from './ChatSidebar'
import { VideoRecorder } from './VideoRecorder'
import { extractVideoFrames, formatMediaDuration } from './video'
import { CodePanel } from './CodePanel'
import { CodePanelContext, type CodeArtifact } from './codePanelContext'
import { extractCodeBlocks } from './codeTheme'
import { getConfigBridge } from './config-bridge'
import { isSubmittable, makeTextTurn } from './chat'
import {
    describeConfirmationAction,
    describeStep,
    isBusyState,
    isTerminalState,
    sanitizeHelpText,
    type StepItem
} from './operator'
import { renderPdfToImages } from './pdf'
import { curateForMode, friendlyLabel, type CuratedModels } from './models'
import { routeIntent } from './intentRouter'
import { SetupCard } from './SetupCard'
import { VoiceBars } from '../voice-lib'
import { useSmoothDictation as useDictation } from '../voice-lib-v2'
import {
    addUserMessage,
    appendTurn,
    clearError,
    initialConversationState,
    setError,
    setPending,
    type ConversationState
} from './conversation'
import { getChatBridge, getOperatorBridge } from './bridges'
import {
    CaretIcon,
    CheckIcon,
    ChevronIcon,
    ImageFileIcon,
    MailIcon,
    PaperclipIcon,
    SendIcon,
    StopIcon,
    VideoCameraIcon
} from './icons'
import { GoalTracker, TurnBody } from './turns'
import {
    finderName,
    formatEmailContext,
    makeShotName,
    MAX_STAGED_VIDEOS,
    type StagedAttachment
} from './attachments'
import {
    compactSidebarText,
    friendlyProvider,
    NAV_OVERLAY_BREAKPOINT,
    OPERATOR_DRAFT_ID,
    operatorViewToSteps,
    operatorViewToTurns,
    titleFromTurns
} from './rail'
import { HeaderSelect } from './HeaderSelect'

/**
 * Sidebar shell + chat UI.
 *
 * Capture is triggered from the floating pencil window. Assistant guidance is
 * rendered as Markdown. The header exposes History, New, and Settings panels.
 */

export function App(): React.JSX.Element {
    const [state, setState] = useState<ConversationState>(() => initialConversationState())
    const [draft, setDraft] = useState('')
    const [showSettings, setShowSettings] = useState(false)
    // The code artifact shown in the right-hand panel (Claude-style), or null.
    const [codeArtifact, setCodeArtifact] = useState<CodeArtifact | null>(null)
    // User-draggable width of the right code panel (persists while open).
    const [codePanelWidth, setCodePanelWidth] = useState(480)
    // Set while the on-device model downloads on first use (one-time), so the
    // wait shows a friendly status instead of looking like a hang.
    // True when a question arrived but NO AI provider is configured; renders
    // the in-chat key setup card. Cleared on the next submit (main re-emits if
    // still unconfigured) and by the card itself once a key is saved.
    const [needsSetup, setNeedsSetup] = useState(false)
    const codePanelApi = useRef({ open: (a: CodeArtifact) => setCodeArtifact(a) }).current
    // Tracks the last copilot answer we auto-opened, so a fresh answer with code
    // opens the panel exactly once (clicking a pill re-opens it thereafter).
    const lastAutoOpenedTurnRef = useRef<string | null>(null)
    const [navOpen, setNavOpen] = useState(() =>
        typeof window !== 'undefined' ? window.innerWidth > NAV_OVERLAY_BREAKPOINT : true
    )
    const [history, setHistory] = useState<SessionListItem[]>([])
    const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
    const [summary, setSummary] = useState<SessionSummary | null>(null)
    const [currentModel, setCurrentModel] = useState('')
    const [curated, setCurated] = useState<CuratedModels>({ recommended: [], others: [] })
    const [showModels, setShowModels] = useState(false)
    const [showAllModels, setShowAllModels] = useState(false)
    // Operator controls (merged from Click Operator): where the agent acts, how
    // much it may do on its own, and its step cap. Wired to the operator engine
    // in a later stage; here they own the header UI next to New/Instructions/Settings.
    const [operatorMode, setOperatorMode] = useState(false)
    const [opEnvironment, setOpEnvironment] = useState<'browser' | 'container-desktop' | 'local'>('browser')
    const [opAutonomy, setOpAutonomy] = useState<'manual' | 'supervised' | 'autonomous'>('autonomous')

    // Live status pill (operator): the provider actually serving steps right now
    // (updates as the fallback chain shifts) and whether it is acting via the
    // DOM (api) or raw pixels (vision).
    const [opActiveProvider, setOpActiveProvider] = useState<string | null>(null)
    const [opActiveMode, setOpActiveMode] = useState<'api' | 'vision' | null>(null)
    // Track the active chat/task independently so switching modes preserves the
    // selected row in each history rail.
    const [chatSessionId, setChatSessionId] = useState<string | null>(null)
    const [opSessionId, setOpSessionId] = useState<string | null>(null)
    // True while the user has an unused "New task" draft. Operator sessions
    // only exist once a goal is submitted, so the draft is renderer state: it
    // keeps its rail row alive when the user browses older tasks, and is
    // consumed by the first goal or removed by right-click delete.
    const [opDraft, setOpDraft] = useState(false)
    // Saved reusable task templates, shown in the operator's New-task
    // workspace. Loaded from the main-process store on operator-mode entry.
    const [playbooks, setPlaybooks] = useState<Playbook[]>([])
    // The operator's live steps for the current run, rendered as a bordered
    // checklist (each with a tick; a spinner trails while the agent works).
    const [opSteps, setOpSteps] = useState<Array<{ id: string } & StepItem>>([])
    const [opStepBudget, setOpStepBudget] = useState('25')
    // The operator's pending confirmation request (Manual/Supervised autonomy),
    // rendered inline in the conversation with Approve/Decline.
    const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
    // Screenshots captured with Cmd+Shift+D land here first (a horizontal
    // carousel above the composer) instead of being sent immediately, so the
    // user can stack several and send them together.
    const [staged, setStaged] = useState<StagedAttachment[]>([])
    const [showVideoRecorder, setShowVideoRecorder] = useState(false)
    const [showAttachMenu, setShowAttachMenu] = useState(false)
    // Mail connector: the Apple Mail message staged for the next chat message.
    const [stagedEmail, setStagedEmail] = useState<SelectedEmail | null>(null)
    const [mailBusy, setMailBusy] = useState(false)
    // User-turn ids whose questions are still processing. Several can be in
    // flight at once — a new question never supersedes an earlier one — and
    // each row offers Cancel for exactly that question.
    const [thinkingIds, setThinkingIds] = useState<readonly string[]>([])
    const cancelThinking = useCallback((requestId: string) => {
        // Optimistically clear the row; main confirms via request:settled.
        setThinkingIds((prev) => prev.filter((id) => id !== requestId))
        void getChatBridge()?.cancelRequest?.(requestId)?.catch(() => undefined)
    }, [])
    // Operator mode keeps its OWN conversation + history, separate from copilot.
    // Toggling modes swaps the visible chat (copilot chat is hidden, not lost),
    // so each mode reads like its own workspace.
    const [opState, setOpState] = useState<ConversationState>(() => initialConversationState())
    const [opHistory, setOpHistory] = useState<SessionListItem[]>([])
    const baseURLRef = useRef('')
    const conversationRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const addFileRef = useRef<HTMLInputElement>(null)
    const stagedRef = useRef<StagedAttachment[]>([])
    const draftRef = useRef('')

    // Revoke playable video blob URLs as soon as their attachment leaves the
    // composer, and again on unmount. Extracted JPEG frames are plain data URLs.
    useEffect(() => {
        const currentUrls = new Set(
            staged.flatMap((attachment) => attachment.previewUrl ? [attachment.previewUrl] : [])
        )
        for (const attachment of stagedRef.current) {
            if (attachment.previewUrl && !currentUrls.has(attachment.previewUrl)) {
                URL.revokeObjectURL(attachment.previewUrl)
            }
        }
        stagedRef.current = staged
    }, [staged])

    useEffect(() => () => {
        for (const attachment of stagedRef.current) {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
        }
        stagedRef.current = []
    }, [])

    // Single dictation engine: Whisper base (WebGPU). The faster Moonshine
    // variant was dropped — it hallucinated too often to trust.
    const voiceOpts = {
        getText: () => draftRef.current,
        setText: setDraft,
        onError: (message: string) =>
            setState((s) => setError(s, { kind: 'render-failed', message: `Voice: ${message}`, recoverable: true }))
    }
    const dictation = useDictation(voiceOpts)

    // v1's Dictation has no cancel(); fall back to stop() + clear for it.
    const cancelActive = useCallback(() => {
        const d = dictation as { cancel?: () => void; stop: () => void }
        if (typeof d.cancel === 'function') d.cancel()
        else {
            d.stop()
            setDraft('')
        }
    }, [dictation])

    useEffect(() => {
        const bridge = getChatBridge()
        if (!bridge) {
            return
        }

        let active = true
        void bridge
            .getSession()
            .then((session) => {
                if (!active) return
                setChatSessionId(session.id || null)
                if (session.turns.length) {
                    setState(initialConversationState(session.turns))
                }
                setSummary(session.summary ?? null)
            })
            .catch(() => {
                /* No restorable session; start empty. */
            })

        // Populate the history sidebar on launch.
        if (typeof bridge.listSessions === 'function') {
            void bridge
                .listSessions()
                .then((items) => {
                    if (active) setHistory(items)
                })
                .catch(() => undefined)
        }

        const unsubscribers: Array<void | (() => void)> = [
            bridge.onTurnAppended((turn) => setState((s) => appendTurn(s, turn))),
            bridge.onPending((pending) => setState((s) => setPending(s, pending))),
            bridge.onError((err) => setState((s) => setError(s, err))),
            bridge.onSessionState?.((session) => {
                setChatSessionId(session.id || null)
                setState(initialConversationState(session.turns ?? []))
                setSummary(session.summary ?? null)
            }),
            bridge.onSummary?.((s) => setSummary(s)),
            bridge.onCaptureStaged?.((capture) =>
                setStaged((prev) => [
                    ...prev,
                    {
                        id: `shot-${Date.now()}-${prev.length}`,
                        kind: 'image',
                        status: 'ready',
                        captures: [capture],
                        name: makeShotName()
                    }
                ])
            ),
            // No provider configured at all: show the in-chat key setup card so
            // the user can paste a free key without hunting through Settings.
            bridge.onSetupNeeded?.(() => setNeedsSetup(true)),
            // Per-question thinking state: each in-flight question shows its own
            // indicator (+ Cancel) under the exact message that asked it.
            bridge.onRequestStarted?.((requestId) =>
                setThinkingIds((prev) => (prev.includes(requestId) ? prev : [...prev, requestId]))
            ),
            bridge.onRequestSettled?.((requestId) =>
                setThinkingIds((prev) => prev.filter((id) => id !== requestId))
            ),
            // Do NOT auto-open Settings on launch when credentials are missing;
            // the user opens Settings themselves. A missing-key error still
            // surfaces inline if they try to send without configuring.
            bridge.onCredentialsRequired?.(() => {
                /* intentionally no-op */
            })
        ]

        return () => {
            active = false
            for (const unsub of unsubscribers) {
                if (typeof unsub === 'function') unsub()
            }
        }
    }, [])

    // Bind the merged operator engine's activity stream into the chat. Each
    // trajectory step becomes an assistant turn; loop-state changes drive the
    // pending indicator; confirmations + agent questions render inline. Bound
    // Bound with cleanup so a re-mount (React StrictMode or a hot reload) always
    // rebinds to THIS component's state — a stale, once-bound subscription was
    // why live steps/status stopped updating after edits.
    useEffect(() => {
        const op = getOperatorBridge()
        if (!op) return

        // Restore the current operator task into the rail and checklist on
        // launch. Acting never resumes automatically; this is display state.
        void op
            .getSession?.()
            .then((view) => {
                if (!view.id || !view.goalText.trim()) return
                setOpSessionId(view.id)
                setOpState(initialConversationState(operatorViewToTurns(view)))
                setOpSteps(operatorViewToSteps(view))
            })
            .catch(() => undefined)

        // Operator activity flows into the SEPARATE operator conversation
        // (opState), never the copilot chat.
        const appendAssistant = (text: string): void => {
            const turn = makeTextTurn('assistant', text)
            if (turn) setOpState((s) => appendTurn(s, turn))
        }

        const unsubscribers: Array<void | (() => void)> = [
            op.onTrajectoryAppended?.((step) => {
                // Each step becomes a row in the live checklist (not a bubble).
                const item = describeStep(step)
                setOpSteps((prev) => [...prev, { id: `${step.index}-${prev.length}`, ...item }])
                // Live status pill: which provider served this step (so a
                // fallback shows in real time) + whether it acted via the DOM
                // (api) or raw pixels (vision).
                if (step.providerId) setOpActiveProvider(step.providerId)
                if (step.result?.mode) setOpActiveMode(step.result.mode)
                if (step.outcome === 'completion' || step.outcome === 'failure') {
                    setOpState((s) => setPending(s, false))
                }
            }),
            op.onStateChanged?.((view: LoopStateView) => {
                if (view.sessionId) setOpSessionId(view.sessionId)
                setOpState((s) => setPending(s, isBusyState(view.state)))
                if (isTerminalState(view.state)) {
                    setConfirmation(null)
                }
            }),
            op.onConfirmationRequired?.((req) => {
                setConfirmation(req)
                setOpState((s) => setPending(s, false))
            }),
            op.onHelpRequired?.((question) => {
                appendAssistant(
                    sanitizeHelpText(question) ?? 'The agent needs more information to continue.'
                )
                setOpState((s) => setPending(s, false))
            }),
            op.onError?.((err) => {
                setOpState((s) => setError(s, { kind: 'render-failed', message: err.message, recoverable: true }))
            })
        ]

        return () => {
            for (const unsub of unsubscribers) {
                if (typeof unsub === 'function') unsub()
            }
        }
    }, [])

    useEffect(() => {
        const el = conversationRef.current
        if (el) {
            el.scrollTop = el.scrollHeight
        }
    }, [
        state.turns,
        state.pending,
        state.error,
        opState.turns,
        opState.pending,
        opState.error,
        operatorMode
    ])

    // Auto-open the newest copilot answer's code in the right-hand panel the
    // first time it arrives (Claude-style). Marked per-turn so it opens exactly
    // once; the code pill in the message re-opens it on demand thereafter.
    useEffect(() => {
        const turns = state.turns
        for (let i = turns.length - 1; i >= 0; i -= 1) {
            const t = turns[i]
            if (t.role !== 'assistant') continue
            if (t.id === lastAutoOpenedTurnRef.current) return
            lastAutoOpenedTurnRef.current = t.id
            const blocks = extractCodeBlocks(t.text ?? '')
            if (blocks.length > 0) {
                const b = blocks[blocks.length - 1]
                setCodeArtifact({ code: b.code, language: b.language })
            }
            return
        }
    }, [state.turns])

    // Keep draftRef in sync (read synchronously by dictation), auto-grow the
    // input up to ~4 lines, then scroll to keep the latest line visible. Runs
    // as a layout effect so the textarea is sized before paint — switching back
    // from the dictation transcript doesn't flash a collapsed height.
    useLayoutEffect(() => {
        draftRef.current = draft
        const el = inputRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight}px`
        el.scrollTop = el.scrollHeight
    }, [draft])

    // Auto-collapse the sidebar when the window narrows past the mobile
    // breakpoint, and re-open it when it widens again (only on crossing, so a
    // manual collapse/expand within a width band is preserved).
    useEffect(() => {
        let wasWide = window.innerWidth > NAV_OVERLAY_BREAKPOINT
        const onResize = (): void => {
            const isWide = window.innerWidth > NAV_OVERLAY_BREAKPOINT
            if (isWide !== wasWide) {
                wasWide = isWide
                setNavOpen(isWide)
            }
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    // Load the currently configured model + gateway base URL for the picker.
    useEffect(() => {
        const cb = getConfigBridge()
        if (!cb) return
        void cb
            .getConfigStatus()
            .then((s) => {
                setCurrentModel(s.model)
                baseURLRef.current = s.baseURL
            })
            .catch(() => undefined)
    }, [])

    const openModels = useCallback(() => {
        setShowModels((v) => !v)
        // Always show task-appropriate recommended models (works offline, even
        // when the gateway key is down); merge in any live gateway models under
        // "show all". Copilot -> vision/step-guidance models; Operator ->
        // computer-use models.
        setCurated(curateForMode(operatorMode, []))
        const bridge = getChatBridge()
        if (bridge && typeof bridge.listModels === 'function') {
            void bridge
                .listModels()
                .then((list) => setCurated(curateForMode(operatorMode, list)))
                .catch(() => setCurated(curateForMode(operatorMode, [])))
        }
    }, [operatorMode])

    const selectModel = useCallback((m: string) => {
        setCurrentModel(m)
        setShowModels(false)
        // Operator mode: the agent reads its model from the OPERATOR provider
        // chain (operator-config.json), NOT the chat gateway config. Route the
        // pick to the provider that serves it and persist there — previously
        // the pick only wrote the chat config, so the agent silently kept
        // running its old model.
        if (operatorMode) {
            const op = getOperatorBridge()
            if (op && typeof op.getProviders === 'function' && typeof op.saveProviders === 'function') {
                void op
                    .getProviders()
                    .then((view) => {
                        const targetId = m.startsWith('openrouter')
                            ? 'openrouter'
                            : m.startsWith('gemini')
                                ? 'gemini'
                                : view.chain.providerIds[0] ?? null
                        if (!targetId || !view.providers.some((p) => p.id === targetId)) return
                        // Omitted apiKey keeps each provider's stored key.
                        const providers = view.providers.map((p) =>
                            p.id === targetId ? { ...p, model: m } : p
                        )
                        return op.saveProviders?.({ chain: view.chain, providers })
                    })
                    .catch(() => undefined)
            }
            return
        }
        const cb = getConfigBridge()
        if (cb) {
            // Persist via saveConfig; empty apiKey keeps the stored key.
            void cb
                .saveConfig({ baseURL: baseURLRef.current, model: m, apiKey: '' })
                .catch(() => undefined)
        }
    }, [operatorMode])

    // Start an operator task for `goal` in the given environment: record it in
    // the operator conversation and kick off the engine. Shared by the explicit
    // operator path and the auto-router (a copilot command routed to operator).
    const runOperatorGoal = useCallback(
        (
            goal: string,
            environment: 'browser' | 'container-desktop' | 'local',
            // Playbooks run with THEIR saved settings; the header pickers may
            // not have re-rendered yet when a run starts, so explicit
            // overrides beat possibly-stale state.
            overrides?: { autonomy?: 'manual' | 'supervised' | 'autonomous'; stepBudget?: number }
        ) => {
            setOpSessionId(null)
            // A submitted goal consumes the "New task" draft: the real task
            // takes over its place in the rail.
            setOpDraft(false)
            setOpState((s) => addUserMessage(s, goal).state)
            setOpSteps([]) // fresh checklist for the new run
            const op = getOperatorBridge()
            if (!op || typeof op.startGoal !== 'function') {
                setOpState((s) =>
                    setError(s, {
                        kind: 'render-failed',
                        message: 'Computer or Browser Use is not connected yet. Your goal was kept.',
                        recoverable: true
                    })
                )
                return
            }
            setOpState((s) => setPending(s, true))
            void op
                .startGoal({
                    goal,
                    autonomy: overrides?.autonomy ?? opAutonomy,
                    stepBudget:
                        overrides?.stepBudget ?? Math.max(1, Number.parseInt(opStepBudget, 10) || 25),
                    environment
                })
                .then((result) => {
                    if (!result.ok) {
                        setOpState((s) => setPending(s, false))
                        setOpState((s) =>
                            setError(s, { kind: 'render-failed', message: result.error.message, recoverable: true })
                        )
                        return
                    }
                    setOpSessionId(result.sessionId)
                })
                .catch((err: unknown) => {
                    setOpState((s) => setPending(s, false))
                    const message = err instanceof Error ? err.message : 'Failed to start the task.'
                    setOpState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
                })
        },
        [opAutonomy, opStepBudget]
    )

    // ---- Playbooks: list / run / save / delete --------------------------
    const refreshPlaybooks = useCallback(() => {
        const op = getOperatorBridge()
        if (op && typeof op.listPlaybooks === 'function') {
            void op.listPlaybooks().then(setPlaybooks).catch(() => undefined)
        }
    }, [])
    useEffect(() => {
        if (operatorMode) refreshPlaybooks()
    }, [operatorMode, refreshPlaybooks])
    const runPlaybook = useCallback(
        (pb: Playbook) => {
            // Reflect the playbook's saved settings in the header pickers and
            // run with explicit overrides (state updates land next render).
            setOpAutonomy(pb.autonomy)
            setOpStepBudget(String(pb.stepBudget))
            setOpEnvironment(pb.environment)
            runOperatorGoal(pb.goal, pb.environment, {
                autonomy: pb.autonomy,
                stepBudget: pb.stepBudget
            })
        },
        [runOperatorGoal]
    )
    const saveDraftAsPlaybook = useCallback(() => {
        const goal = draft.trim()
        if (goal.length === 0) return
        const op = getOperatorBridge()
        if (!op || typeof op.savePlaybook !== 'function') return
        const firstLine = goal.split('\n', 1)[0] ?? goal
        const name = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine
        void op
            .savePlaybook({
                name,
                goal,
                autonomy: opAutonomy,
                stepBudget: Math.max(1, Number.parseInt(opStepBudget, 10) || 25),
                environment: opEnvironment
            })
            .then(setPlaybooks)
            .catch(() => undefined)
    }, [draft, opAutonomy, opStepBudget, opEnvironment])
    const deletePlaybook = useCallback((id: string) => {
        const op = getOperatorBridge()
        if (!op || typeof op.deletePlaybooks !== 'function') return
        void op.deletePlaybooks([id]).then(setPlaybooks).catch(() => undefined)
    }, [])
    // Set / clear a playbook's daily schedule (null clears). Runs happen while
    // the app is open; a missed time catches up on next launch that day.
    const updatePlaybookSchedule = useCallback(
        (pb: Playbook, schedule: { timeOfDay: string; enabled: boolean } | null) => {
            const op = getOperatorBridge()
            if (!op || typeof op.savePlaybook !== 'function') return
            void op
                .savePlaybook({
                    id: pb.id,
                    name: pb.name,
                    goal: pb.goal,
                    autonomy: pb.autonomy,
                    stepBudget: pb.stepBudget,
                    environment: pb.environment,
                    schedule
                })
                .then(setPlaybooks)
                .catch(() => undefined)
        },
        []
    )

    // Mail connector: fetch the currently selected Mail message and stage it
    // as context for the next chat message. First use triggers the macOS
    // Automation permission prompt ("wants to control Mail").
    const attachSelectedEmail = useCallback((source: 'mail' | 'outlook' = 'mail') => {
        const bridge = getChatBridge()
        if (!bridge || typeof bridge.readSelectedMail !== 'function' || mailBusy) return
        setMailBusy(true)
        void bridge
            .readSelectedMail(source)
            .then((result) => {
                if (result.ok) {
                    setStagedEmail(result.email)
                    return
                }
                setState((s) =>
                    setError(s, { kind: 'render-failed', message: result.error, recoverable: true })
                )
            })
            .catch((err: unknown) => {
                const message =
                    err instanceof Error ? err.message : 'Could not read the selected email.'
                setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
            })
            .finally(() => setMailBusy(false))
    }, [mailBusy])

    const submit = useCallback(() => {
        // A fresh ask retracts the setup card; main re-emits it if keys are
        // still missing, and after a successful connect it stays gone.
        setNeedsSetup(false)
        const isPreparingAttachment = staged.some((attachment) => attachment.status === 'processing')
        if (isPreparingAttachment) {
            setState((current) =>
                setError(current, {
                    kind: 'render-failed',
                    message: 'Your video is still being converted into AI-readable frames.',
                    recoverable: true
                })
            )
            return
        }

        const captures = staged.flatMap((attachment) => attachment.captures)
        const hasCaptures = captures.length > 0
        // A staged email counts as content in copilot mode (like attachments).
        const emailStaged = !operatorMode && stagedEmail !== null
        // Images, PDFs, and sampled videos can be sent without typed text.
        if (!isSubmittable(draft) && !hasCaptures && !emailStaged) {
            return
        }
        // Fold a staged Mail message into the outgoing text so the model gets
        // the exact email (sender/subject/body) alongside the user's ask.
        const text = emailStaged && stagedEmail ? formatEmailContext(stagedEmail, draft) : draft
        setDraft('')
        if (emailStaged) setStagedEmail(null)

        // Sending ends the utterance: turn the mic off so it isn't left
        // listening after the message goes out. Cancel (rather than stop) so no
        // trailing transcription lands back in the now-cleared field.
        if (dictation.listening) cancelActive()

        // Every attachment reaches the provider as one or more image captures.
        // Video captures retain chronological frame metadata for request labels.
        if (hasCaptures) {
            setState((s) => addUserMessage(s, text).state)
            setStaged([])
            const bridge = getChatBridge()
            if (!bridge || typeof bridge.sendCaptures !== 'function') {
                setState((s) =>
                    setError(s, {
                        kind: 'render-failed',
                        message: 'Smart Copilot is not connected yet. Your message was kept.',
                        recoverable: true
                    })
                )
                return
            }
            void bridge.sendCaptures(captures, text).catch((err: unknown) => {
                const message = err instanceof Error ? err.message : 'Failed to send your attachments.'
                setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
            })
            return
        }

        // Operator mode (chosen explicitly): the message is a Goal for the
        // autonomous engine in the currently-selected environment.
        if (operatorMode) {
            runOperatorGoal(text, opEnvironment)
            return
        }

        // Copilot mode: auto-route. A "do this for me" command (open/play/turn
        // on ...) is handed to the OPERATOR — switching the UI to operator and
        // picking the environment (web vs Mac) from the prompt — while a
        // question / advice request stays in copilot. This is what lets the user
        // just type naturally and land in the right mode.
        const routed = routeIntent(text, false)
        if (routed.mode === 'operator') {
            setOperatorMode(true)
            setOpEnvironment(routed.environment)
            runOperatorGoal(text, routed.environment)
            return
        }

        // Copilot text message.
        setState((s) => addUserMessage(s, text).state)
        const bridge = getChatBridge()
        if (!bridge) {
            setState((s) =>
                setError(s, {
                    kind: 'render-failed',
                    message: 'Smart Copilot is not connected yet. Your message was kept.',
                    recoverable: true
                })
            )
            return
        }
        void bridge.sendMessage(text).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to send your message.'
            setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
        })
    }, [draft, staged, stagedEmail, operatorMode, opEnvironment, runOperatorGoal, dictation, cancelActive])

    /** Remove one local attachment before sending. */
    const removeStaged = useCallback((id: string) => {
        setStaged((prev) => prev.filter((attachment) => attachment.id !== id))
    }, [])

    /**
     * Add images, PDFs, and videos to the same composer carousel. PDFs become
     * page images. Videos stay playable locally while a bounded chronological
     * set of JPEG frames is prepared for the vision model.
     */
    const onAddFiles = useCallback((files: FileList | readonly File[] | null) => {
        if (!files) return
        let availableVideoSlots = Math.max(
            0,
            MAX_STAGED_VIDEOS - stagedRef.current.filter((attachment) => attachment.kind === 'video').length
        )
        const stageImage = (dataUrl: string, name: string): void => {
            setStaged((prev) => [
                ...prev,
                {
                    id: `file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    kind: 'image',
                    status: 'ready',
                    captures: [{
                        dataUrl,
                        thumbnailUrl: dataUrl,
                        rect: { x: 0, y: 0, width: 0, height: 0 }
                    }],
                    name
                }
            ])
        }

        const stageVideo = (file: File): void => {
            const id = `video-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const previewUrl = URL.createObjectURL(file)
            setStaged((prev) => [
                ...prev,
                {
                    id,
                    kind: 'video',
                    status: 'processing',
                    captures: [],
                    name: file.name,
                    previewUrl
                }
            ])
            void extractVideoFrames(file)
                .then(({ captures, durationSeconds }) => {
                    setStaged((prev) => prev.map((attachment) =>
                        attachment.id === id
                            ? { ...attachment, status: 'ready', captures, durationSeconds }
                            : attachment
                    ))
                })
                .catch((caught: unknown) => {
                    setStaged((prev) => prev.filter((attachment) => attachment.id !== id))
                    const detail = caught instanceof Error ? `: ${caught.message}` : ''
                    setState((current) =>
                        setError(current, {
                            kind: 'render-failed',
                            message: `Could not prepare the video "${file.name}"${detail}`,
                            recoverable: true
                        })
                    )
                })
        }

        for (const file of Array.from(files)) {
            const lowerName = file.name.toLowerCase()
            const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
            if (isPdf) {
                void renderPdfToImages(file)
                    .then((pages) => {
                        pages.forEach((dataUrl, index) => {
                            const label = pages.length > 1 ? `${file.name} p${index + 1}` : file.name
                            stageImage(dataUrl, label)
                        })
                    })
                    .catch((caught: unknown) => {
                        const detail = caught instanceof Error ? `: ${caught.message}` : ''
                        setState((current) =>
                            setError(current, {
                                kind: 'render-failed',
                                message: `Could not read the PDF "${file.name}"${detail}`,
                                recoverable: true
                            })
                        )
                    })
                continue
            }

            const isVideo =
                file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv)$/i.test(lowerName)
            if (isVideo) {
                if (availableVideoSlots <= 0) {
                    setState((current) =>
                        setError(current, {
                            kind: 'render-failed',
                            message: `Attach up to ${MAX_STAGED_VIDEOS} videos at a time so the AI request stays fast and reliable.`,
                            recoverable: true
                        })
                    )
                    continue
                }
                availableVideoSlots -= 1
                stageVideo(file)
                continue
            }

            if (!file.type.startsWith('image/')) continue
            const reader = new FileReader()
            reader.onload = () => {
                const dataUrl = String(reader.result ?? '')
                if (dataUrl) stageImage(dataUrl, file.name)
            }
            reader.onerror = () => {
                setState((current) =>
                    setError(current, {
                        kind: 'render-failed',
                        message: `Could not read the image "${file.name}".`,
                        recoverable: true
                    })
                )
            }
            reader.readAsDataURL(file)
        }
    }, [])

    // Prevent Electron from navigating to dropped files and route supported
    // images, PDFs, and videos through the same local attachment pipeline.
    useEffect(() => {
        const onDragOver = (event: DragEvent): void => {
            if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
        }
        const onDrop = (event: DragEvent): void => {
            const files = event.dataTransfer?.files
            const hasSupportedFile =
                !!files &&
                files.length > 0 &&
                Array.from(files).some((file) =>
                    file.type.startsWith('image/') ||
                    file.type.startsWith('video/') ||
                    file.type === 'application/pdf' ||
                    /\.(pdf|mp4|m4v|mov|webm|ogv)$/i.test(file.name)
                )
            event.preventDefault()
            if (hasSupportedFile) onAddFiles(files!)
        }
        window.addEventListener('dragover', onDragOver)
        window.addEventListener('drop', onDrop)
        return () => {
            window.removeEventListener('dragover', onDragOver)
            window.removeEventListener('drop', onDrop)
        }
    }, [onAddFiles])

    // Approve/decline a pending operator confirmation (Manual/Supervised).
    const decideConfirmation = useCallback((approved: boolean) => {
        setConfirmation((req) => {
            if (req) {
                const op = getOperatorBridge()
                void op?.confirmAction?.({ stepId: req.stepId, approved })
                if (approved) setOpState((s) => setPending(s, true))
            }
            return null
        })
    }, [])

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            // While dictating, clearing the field (Backspace/Delete, e.g. after
            // Cmd/Ctrl+A) aborts dictation and turns the mic off.
            if (dictation.listening && (e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault()
                cancelActive()
                return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
            }
        },
        [submit, dictation, cancelActive]
    )

    const refreshHistory = useCallback(() => {
        const bridge = getChatBridge()
        if (bridge && typeof bridge.listSessions === 'function') {
            void bridge
                .listSessions()
                .then((items) => setHistory(items))
                .catch(() => setHistory([]))
        }
    }, [])

    // Operator task history, mapped into the same shape the sidebar renders.
    const refreshOpHistory = useCallback(() => {
        const op = getOperatorBridge()
        if (op && typeof op.listSessions === 'function') {
            void op
                .listSessions()
                .then((items) =>
                    setOpHistory(
                        items.map((it) => ({
                            id: it.id,
                            title:
                                it.goalText && it.goalText.trim().length > 0
                                    ? compactSidebarText(it.goalText, 54)
                                    : 'Untitled task',
                            description:
                                it.status === 'running'
                                    ? 'Working on this task…'
                                    : it.status === 'completed'
                                        ? 'Task completed'
                                        : it.status === 'paused' || it.status === 'awaiting-help'
                                            ? 'Waiting to continue'
                                            : it.status === 'failed' || it.status === 'budget-exhausted'
                                                ? 'Task needs attention'
                                                : it.status === 'stopped'
                                                    ? 'Task stopped'
                                                    : 'Ready to continue',
                            updatedAt: it.updatedAt,
                            turnCount: 0
                        }))
                    )
                )
                .catch(() => setOpHistory([]))
        }
    }, [])

    // Load operator task history whenever operator mode is entered.
    useEffect(() => {
        if (operatorMode) refreshOpHistory()
    }, [operatorMode, refreshOpHistory])

    // Cancel a running operator task WITHOUT clearing the conversation, so the
    // user can change a setting (e.g. Autonomy) and start again. Stops the loop,
    // clears the pending spinner, and dismisses any pending confirmation.
    const onCancelOperator = useCallback(() => {
        const op = getOperatorBridge()
        void op?.stopSession?.().catch(() => undefined)
        setOpState((s) => setPending(s, false))
        setConfirmation(null)
    }, [])

    const onNewSession = useCallback(() => {
        // Leave an open Settings panel so the fresh chat is actually visible,
        // and close the right-hand code panel.
        setShowSettings(false)
        setCodeArtifact(null)
        lastAutoOpenedTurnRef.current = null
        // Operator mode: clear the operator workspace (hide, not delete) and stop
        // any running task so the next goal starts fresh.
        if (operatorMode) {
            const op = getOperatorBridge()
            void op?.stopSession?.().catch(() => undefined)
            setOpState(initialConversationState([]))
            setConfirmation(null)
            setDraft('')
            setOpActiveProvider(null)
            setOpActiveMode(null)
            setOpSessionId(null)
            setOpSteps([])
            // Mark the draft so its rail row survives browsing older tasks
            // until a goal consumes it or the user deletes it. Clicking New
            // task again while the draft exists just returns to this same
            // draft — no second one is ever created.
            setOpDraft(true)
            refreshOpHistory()
            if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
            return
        }
        const bridge = getChatBridge()
        if (!bridge || typeof bridge.newSession !== 'function') {
            return
        }
        void bridge.newSession().then(() => refreshHistory()).catch(() => undefined)
        setChatSessionId(null)
        setState(initialConversationState([]))
        setDraft('')
        setSummary(null)
        setStaged([])
        if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
    }, [operatorMode, refreshHistory, refreshOpHistory])

    const onOpenSession = useCallback(
        (id: string) => {
            // Clicking the parked draft returns to the New task workspace
            // (same clearing flow as the New chat button — still one draft).
            if (id === OPERATOR_DRAFT_ID) {
                if (opSessionId !== null) onNewSession()
                return
            }
            // Opening a chat must leave an open Settings panel, otherwise the
            // selected conversation stays hidden behind it.
            setShowSettings(false)
            // Keep the sidebar open on wide layouts (it's a persistent pane); only
            // auto-close on the narrow/mobile overlay where it covers the chat.
            if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)

            // The first rail row can be a synthesized view of the live in-memory
            // session, newer than the archived copy with the same id. Selecting it
            // is navigation-only; never ask main to restore the stale archive.
            const activeId = operatorMode ? opSessionId : chatSessionId
            if (id === activeId) return

            if (operatorMode) {
                setOpSessionId(id)
                const op = getOperatorBridge()
                if (op && typeof op.openSession === 'function') {
                    void op
                        .openSession(id)
                        .then((view) => {
                            setOpState(initialConversationState(operatorViewToTurns(view)))
                            setOpSteps(operatorViewToSteps(view))
                        })
                        .catch(() => undefined)
                }
                return
            }
            setChatSessionId(id)
            const bridge = getChatBridge()
            if (bridge && typeof bridge.openSession === 'function') {
                void bridge.openSession(id).then(() => refreshHistory()).catch(() => undefined)
            }
        },
        [operatorMode, opSessionId, chatSessionId, refreshHistory, onNewSession]
    )

    const toggleSettings = useCallback(() => {
        setShowSettings((v) => !v)
        // Settings lives in the rail footer; close the narrow overlay so the
        // panel it opens is immediately visible rather than hidden underneath.
        if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
    }, [])

    const onChatContextMenu = useCallback(
        (e: React.MouseEvent, id: string) => {
            e.preventDefault()
            // The ACTIVE draft pill is just the empty workspace — nothing to
            // delete. A PARKED draft row is deletable like any other row.
            if (id === OPERATOR_DRAFT_ID && opSessionId === null) return
            setMenu({ x: e.clientX, y: e.clientY, id })
        },
        [opSessionId]
    )

    const deleteOne = useCallback(
        (id: string) => {
            setMenu(null)
            // The operator draft is renderer state, not a stored session:
            // deleting it just removes its row.
            if (id === OPERATOR_DRAFT_ID) {
                setOpDraft(false)
                return
            }
            // Delete from whichever store owns the active mode: operator tasks go
            // through the operator bridge, copilot chats through the chat bridge.
            const deletingOpen = id === (operatorMode ? opSessionId : chatSessionId)
            if (operatorMode) {
                const op = getOperatorBridge()
                if (!op || typeof op.deleteSessions !== 'function') return
                void op
                    .deleteSessions([id])
                    .then(async () => {
                        if (deletingOpen) {
                            setOpState(initialConversationState([]))
                            setOpActiveProvider(null)
                            setOpActiveMode(null)
                            setOpSessionId(null)
                            setOpSteps([])
                            setCodeArtifact(null)
                            lastAutoOpenedTurnRef.current = null
                        }
                        await refreshOpHistory()
                    })
                    .catch((error: unknown) => {
                        const detail = error instanceof Error ? error.message : String(error)
                        setOpState((state) =>
                            setError(state, {
                                kind: 'render-failed',
                                message: `Could not delete operator history: ${detail}`,
                                recoverable: true
                            })
                        )
                    })
                return
            }
            const bridge = getChatBridge()
            if (!bridge || typeof bridge.deleteSessions !== 'function') return
            void bridge
                .deleteSessions([id])
                .then(async () => {
                    if (deletingOpen) {
                        // Main replaces a deleted active chat with a fresh session
                        // and emits it before this invoke resolves. Read that source
                        // of truth as well so this continuation cannot overwrite its
                        // valid id with null if event delivery and promise settlement
                        // happen in the opposite order.
                        const replacement = await bridge.getSession().catch(() => null)
                        if (replacement) {
                            setChatSessionId(replacement.id || null)
                            setState(initialConversationState(replacement.turns ?? []))
                            setSummary(replacement.summary ?? null)
                        }
                        setStaged([])
                        setCodeArtifact(null)
                        lastAutoOpenedTurnRef.current = null
                    }
                    await refreshHistory()
                })
                .catch((error: unknown) => {
                    const detail = error instanceof Error ? error.message : String(error)
                    setState((state) =>
                        setError(state, {
                            kind: 'render-failed',
                            message: `Could not delete chat history: ${detail}`,
                            recoverable: true
                        })
                    )
                })
        },
        [operatorMode, opSessionId, chatSessionId, refreshHistory, refreshOpHistory]
    )

    // The visible conversation + history depend on the active mode. Copilot and
    // operator each keep their own; toggling swaps which one shows. The current
    // in-memory session is synthesized into the rail because disk history lists
    // only archives.
    const conv = operatorMode ? opState : state
    const setConv = operatorMode ? setOpState : setState
    const archivedHistory = operatorMode ? opHistory : history
    const activeSessionId = operatorMode ? opSessionId : chatSessionId
    const latestTurn = conv.turns.at(-1)
    const latestStep = opSteps.at(-1)
    const preparingAttachments = staged.some((attachment) => attachment.status === 'processing')
    // The second line is live process status only. Completed/idle chats stay a
    // compact single row and do not reserve space for placeholder copy.
    const currentDescription = conv.pending
        ? operatorMode
            ? compactSidebarText(latestStep?.sub ?? latestStep?.label ?? 'Working on your task…')
            : 'Thinking through your request…'
        : ''
    const hasCurrentContent = conv.turns.length > 0 || conv.pending || (operatorMode && opSteps.length > 0)
    // The active chat is ALWAYS present in the rail: clicking New chat shows a
    // "New chat" pill immediately, which renames itself from the conversation
    // as soon as the first message lands (titleFromTurns).
    const currentItem: SessionListItem | null = activeSessionId
        ? {
            id: activeSessionId,
            title: hasCurrentContent
                ? titleFromTurns(
                    conv.turns,
                    operatorMode ? 'Untitled task' : summary?.inferredIntent ?? 'Untitled chat'
                )
                : operatorMode
                    ? 'New task'
                    : 'New chat',
            description: currentDescription,
            updatedAt:
                latestTurn?.createdAt ??
                archivedHistory.find((item) => item.id === activeSessionId)?.updatedAt ??
                new Date().toISOString(),
            turnCount: conv.turns.length
        }
        : operatorMode
            ? {
                // Operator draft state: tasks only exist once a goal is
                // submitted, so after "New task" there is no session id yet.
                // A navigation-inert pill keeps the rail's promise that the
                // active view is always visible (parity with chat).
                id: OPERATOR_DRAFT_ID,
                title: 'New task',
                description: '',
                updatedAt: new Date().toISOString(),
                turnCount: 0
            }
            : null
    // Strictly newest-first by last activity: opening an old chat does NOT
    // bump it to the top — only actually talking in it does (its latest turn
    // becomes its updatedAt, which floats it up with a fresh "now" stamp).
    const byNewest = (a: SessionListItem, b: SessionListItem): number =>
        (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0)
    // The parked operator draft: the user clicked New task, then went browsing
    // older tasks. Its row stays in the rail (deletable, reopenable) until a
    // goal consumes it — parity with parked empty chats in copilot mode.
    const parkedDraft: SessionListItem | null =
        operatorMode && opDraft && opSessionId !== null
            ? {
                id: OPERATOR_DRAFT_ID,
                title: 'New task',
                description: '',
                updatedAt: new Date().toISOString(),
                turnCount: 0
            }
            : null
    const shownHistory = (
        currentItem
            ? [
                currentItem,
                ...(parkedDraft ? [parkedDraft] : []),
                ...archivedHistory.filter((item) => item.id !== currentItem.id)
            ]
            : [...archivedHistory]
    ).sort(byNewest)

    return (
        <CodePanelContext.Provider value={codePanelApi}>
            <div className={`glass-app${navOpen ? '' : ' glass-app--navhidden'}${codeArtifact ? ' glass-app--codeopen' : ''}`}>
                <ChatSidebar
                    items={shownHistory}
                    activeId={currentItem?.id ?? null}
                    running={conv.pending}
                    operatorMode={operatorMode}
                    settingsOpen={showSettings}
                    onCollapse={() => setNavOpen(false)}
                    onNewSession={onNewSession}
                    onToggleOperator={() => setOperatorMode((value) => !value)}
                    onOpenSession={onOpenSession}
                    onChatContextMenu={onChatContextMenu}
                    onToggleSettings={toggleSettings}
                />

                {navOpen && <div className="glass-nav__scrim" onClick={() => setNavOpen(false)} />}

                {menu && (
                    <>
                        <div className="glass-ctx-backdrop" onClick={() => setMenu(null)} />
                        <div className="glass-ctx" style={{ left: menu.x, top: menu.y }}>
                            <button
                                type="button"
                                className="glass-ctx__item glass-ctx__item--danger"
                                onClick={() => deleteOne(menu.id)}
                            >
                                Delete
                            </button>
                        </div>
                    </>
                )}

                {showVideoRecorder && (
                    <VideoRecorder
                        onRecorded={(file) => onAddFiles([file])}
                        onClose={() => setShowVideoRecorder(false)}
                    />
                )}

                <div className="glass-main">
                    <header className="glass-header">
                        {!navOpen && (
                            <button
                                type="button"
                                className="glass-iconbtn glass-iconbtn--icon glass-header__lead"
                                onClick={() => setNavOpen(true)}
                                aria-label="Show chats"
                                title="Show chats"
                            >
                                <ChevronIcon open={false} />
                            </button>
                        )}
                        <div className="glass-header__actions">
                            {operatorMode && (
                                <>
                                    <HeaderSelect
                                        ariaLabel="Environment"
                                        title="Where the operator acts"
                                        value={opEnvironment}
                                        onChange={(v) => setOpEnvironment(v as typeof opEnvironment)}
                                        options={[
                                            { value: 'browser', label: 'Browser Use (Sandboxed browser)' },
                                            { value: 'local', label: 'Compute Use (My Mac)' }
                                        ]}
                                    />
                                    <HeaderSelect
                                        ariaLabel="Autonomy"
                                        title="How much the operator may do on its own"
                                        value={opAutonomy}
                                        onChange={(v) => setOpAutonomy(v as typeof opAutonomy)}
                                        options={[
                                            { value: 'autonomous', label: 'Autonomous' },
                                            { value: 'manual', label: 'Manual' }
                                        ]}
                                    />
                                    <input
                                        className="glass-select glass-select--budget"
                                        type="number"
                                        min={1}
                                        aria-label="Step budget"
                                        title="Maximum operator steps"
                                        value={opStepBudget}
                                        onChange={(e) => setOpStepBudget(e.target.value)}
                                    />
                                </>
                            )}
                        </div>
                    </header>

                    {showSettings ? (
                        <div className="glass-panel">
                            <div className="glass-settings__scroll">
                                <Settings />
                            </div>
                        </div>
                    ) : (
                        <div className="glass-conversation" ref={conversationRef} aria-live="polite">
                            {!operatorMode && summary && <GoalTracker summary={summary} />}
                            {operatorMode &&
                                conv.turns.length === 0 &&
                                opSteps.length === 0 &&
                                (playbooks.length > 0 || draft.trim().length > 0) && (
                                    <div className="glass-playbooks">
                                        <div className="glass-playbooks__head">
                                            <span className="glass-playbooks__title">Playbooks</span>
                                            {draft.trim().length > 0 && (
                                                <button
                                                    type="button"
                                                    className="glass-playbooks__save"
                                                    onClick={saveDraftAsPlaybook}
                                                    title="Save the task in the composer as a reusable playbook"
                                                >
                                                    Save current task
                                                </button>
                                            )}
                                        </div>
                                        {playbooks.map((pb) => (
                                            <div key={pb.id} className="glass-playbook">
                                                <button
                                                    type="button"
                                                    className="glass-playbook__run"
                                                    onClick={() => runPlaybook(pb)}
                                                    title={`Run: ${pb.goal}`}
                                                >
                                                    <span className="glass-playbook__name">{pb.name}</span>
                                                    <span className="glass-playbook__goal">{pb.goal}</span>
                                                </button>
                                                <div className="glass-playbook__schedule">
                                                    <input
                                                        type="time"
                                                        className="glass-playbook__time"
                                                        value={pb.schedule?.timeOfDay ?? ''}
                                                        onChange={(e) => {
                                                            const time = e.target.value
                                                            updatePlaybookSchedule(
                                                                pb,
                                                                time ? { timeOfDay: time, enabled: true } : null
                                                            )
                                                        }}
                                                        aria-label={`Daily run time for ${pb.name}`}
                                                        title="Run daily at this time (while the app is open)"
                                                    />
                                                    <button
                                                        type="button"
                                                        className={`glass-playbook__toggle${pb.schedule?.enabled ? ' glass-playbook__toggle--on' : ''}`}
                                                        onClick={() =>
                                                            updatePlaybookSchedule(
                                                                pb,
                                                                pb.schedule
                                                                    ? {
                                                                        timeOfDay: pb.schedule.timeOfDay,
                                                                        enabled: !pb.schedule.enabled
                                                                    }
                                                                    : { timeOfDay: '09:00', enabled: true }
                                                            )
                                                        }
                                                        aria-label={`${pb.schedule?.enabled ? 'Disable' : 'Enable'} daily schedule for ${pb.name}`}
                                                        title={
                                                            pb.schedule?.enabled
                                                                ? 'Scheduled daily; click to turn off'
                                                                : 'Click to run daily'
                                                        }
                                                    >
                                                        {pb.schedule?.enabled ? 'Daily' : 'Off'}
                                                    </button>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="glass-playbook__delete"
                                                    onClick={() => deletePlaybook(pb.id)}
                                                    aria-label={`Delete playbook ${pb.name}`}
                                                    title="Delete playbook"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                        {playbooks.length === 0 && (
                                            <div className="glass-playbooks__empty">
                                                Save repeat tasks once, run them with one click.
                                            </div>
                                        )}
                                    </div>
                                )}

                            {conv.turns.map((turn) => (
                                <React.Fragment key={turn.id}>
                                    <div
                                        className={[
                                            'glass-row',
                                            turn.role === 'user' ? 'glass-row--user' : 'glass-row--assistant',
                                            turn.status === 'error' ? 'glass-row--error' : ''
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                    >
                                        <div className="glass-bubble">
                                            {turn.captures && turn.captures.length > 0 && (
                                                <div className="glass-shots">
                                                    {turn.captures.map((cap, ci) => (
                                                        <img
                                                            key={ci}
                                                            className="glass-thumb"
                                                            src={cap.thumbnailUrl}
                                                            alt={cap.videoFrame
                                                                ? `Video frame ${cap.videoFrame.index} of ${cap.videoFrame.count}`
                                                                : `Captured screen region ${ci + 1}`}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                            {turn.capture?.thumbnailUrl && (
                                                <img
                                                    className="glass-thumb"
                                                    src={turn.capture.thumbnailUrl}
                                                    alt="Captured screen region"
                                                />
                                            )}
                                            {turn.text && <TurnBody turn={turn} />}
                                        </div>
                                    </div>
                                    {/* This question is still thinking: its own
                                    indicator + a Cancel for exactly this one. */}
                                    {!operatorMode && turn.role === 'user' && thinkingIds.includes(turn.id) && (
                                        <div className="glass-row glass-row--assistant">
                                            <div className="glass-pending glass-pending--perquestion" role="status" aria-label="Thinking about this question">
                                                <span className="glass-pending__dot" />
                                                <span className="glass-pending__dot" />
                                                <span className="glass-pending__dot" />
                                                <button
                                                    type="button"
                                                    className="glass-pending__cancel"
                                                    onClick={() => cancelThinking(turn.id)}
                                                    title="Stop thinking about this question"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </React.Fragment>
                            ))}

                            {/* Operator steps: a bordered checklist (tick per done
                            step, a spinner trailing while the agent works). */}
                            {operatorMode && (opSteps.length > 0 || conv.pending) && (
                                <div className="glass-steps" role="list" aria-label="Operator steps">
                                    {opSteps.map((s) => {
                                        const failed =
                                            s.kind === 'failure' ||
                                            (s.status !== undefined && s.status !== 'success')
                                        return (
                                            <div
                                                key={s.id}
                                                role="listitem"
                                                className={`glass-step${failed ? ' glass-step--error' : ''}`}
                                            >
                                                <span className="glass-step__icon" aria-hidden="true">
                                                    {failed ? '×' : <CheckIcon />}
                                                </span>
                                                <span className="glass-step__text">
                                                    <span className="glass-step__label">{s.label}</span>
                                                    {s.sub && <span className="glass-step__sub">{s.sub}</span>}
                                                    {s.meta && <span className="glass-step__meta">{s.meta}</span>}
                                                </span>
                                            </div>
                                        )
                                    })}
                                    {conv.pending && (
                                        <div className="glass-step glass-step--active" role="listitem">
                                            <span className="glass-step__icon">
                                                <span className="glass-spinner" aria-label="Working" />
                                            </span>
                                            <span className="glass-step__text">
                                                <span className="glass-step__label">Working…</span>
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Classic bottom thinking row: only when no per-question
                            row is already visible. */}
                            {conv.pending &&
                                !operatorMode &&
                                !conv.turns.some(
                                    (t) => t.role === 'user' && thinkingIds.includes(t.id)
                                ) && (
                                    <div className="glass-row glass-row--assistant">
                                        <div className="glass-pending" role="status" aria-label="Glass is thinking">
                                            <span className="glass-pending__dot" />
                                            <span className="glass-pending__dot" />
                                            <span className="glass-pending__dot" />
                                        </div>
                                    </div>
                                )}
                            {/* No provider configured: paste a free key right here. */}
                            {!operatorMode && needsSetup && (
                                <div className="glass-row glass-row--assistant">
                                    <SetupCard onOpenSettings={toggleSettings} />
                                </div>
                            )}

                            {confirmation && (
                                <div className="glass-confirm" role="alertdialog" aria-label="Confirm action">
                                    <div className="glass-confirm__title">
                                        {confirmation.highRisk ? 'Confirm high-risk action' : 'Confirm action'}
                                    </div>
                                    <div className="glass-confirm__action">
                                        {describeConfirmationAction(confirmation.action)}
                                    </div>
                                    <div className="glass-confirm__why">
                                        Review this exact action before allowing it to run.
                                    </div>
                                    <div className="glass-confirm__buttons">
                                        <button
                                            type="button"
                                            className="glass-confirm__btn glass-confirm__btn--approve"
                                            onClick={() => decideConfirmation(true)}
                                        >
                                            Approve
                                        </button>
                                        <button
                                            type="button"
                                            className="glass-confirm__btn glass-confirm__btn--decline"
                                            onClick={() => decideConfirmation(false)}
                                        >
                                            Decline
                                        </button>
                                    </div>
                                </div>
                            )}

                            {conv.error && (
                                <div className="glass-error" role="alert">
                                    <span className="glass-error__text">{conv.error.message}</span>
                                    <button
                                        type="button"
                                        className="glass-error__dismiss"
                                        onClick={() => setConv((s) => clearError(s))}
                                        aria-label="Dismiss error"
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {!showSettings && staged.length > 0 && (
                        <div className="glass-carousel" aria-label="Staged attachments">
                            {staged.map((attachment) => {
                                const thumbnail = attachment.captures[0]?.thumbnailUrl
                                return (
                                    <div
                                        className={`glass-shot${attachment.kind === 'video' ? ' glass-shot--video' : ''}`}
                                        key={attachment.id}
                                    >
                                        <button
                                            type="button"
                                            className="glass-shot__remove"
                                            onClick={() => removeStaged(attachment.id)}
                                            aria-label={`Remove ${attachment.name}`}
                                            title="Remove"
                                        >
                                            ×
                                        </button>
                                        <div className="glass-shot__thumb">
                                            {attachment.kind === 'video' && attachment.previewUrl ? (
                                                <video src={attachment.previewUrl} controls preload="metadata" playsInline />
                                            ) : thumbnail ? (
                                                <img src={thumbnail} alt={attachment.name} draggable={false} />
                                            ) : null}
                                            {attachment.status === 'processing' && (
                                                <div className="glass-shot__processing" role="status">
                                                    <span className="glass-spinner" />
                                                    Sampling frames…
                                                </div>
                                            )}
                                        </div>
                                        <div className="glass-shot__name">{finderName(attachment.name)}</div>
                                        {attachment.kind === 'video' && (
                                            <div className="glass-shot__meta">
                                                {attachment.status === 'ready'
                                                    ? `${formatMediaDuration(attachment.durationSeconds ?? 0)} · ${attachment.captures.length} AI frames`
                                                    : 'Preparing for AI'}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {!showSettings && stagedEmail && !operatorMode && (
                        <div className="glass-mailchip" role="status">
                            <span className="glass-mailchip__icon" aria-hidden="true">
                                <MailIcon />
                            </span>
                            <span className="glass-mailchip__text">
                                <span className="glass-mailchip__subject">{stagedEmail.subject}</span>
                                <span className="glass-mailchip__sender">{stagedEmail.sender}</span>
                            </span>
                            <button
                                type="button"
                                className="glass-mailchip__remove"
                                onClick={() => setStagedEmail(null)}
                                aria-label="Remove attached email"
                                title="Remove attached email"
                            >
                                ×
                            </button>
                        </div>
                    )}
                    {!showSettings && (
                        <div className="glass-composer">
                            <div className="glass-composer__top">
                                <div className="glass-composer__text">
                                    <textarea
                                        ref={inputRef}
                                        className="glass-input"
                                        placeholder={
                                            dictation.listening
                                                ? 'Listening…'
                                                : operatorMode
                                                    ? 'Describe a task for Computer or Browser Use…'
                                                    : 'Message Smart Copilot…'
                                        }
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        onKeyDown={onKeyDown}
                                        readOnly={dictation.listening}
                                        rows={1}
                                        aria-label="Message Smart Copilot"
                                    />
                                </div>
                                {operatorMode && (
                                    <div className="glass-composer__status">
                                        <div
                                            className="glass-status-pill"
                                            title="Active model, live. Updates as the fallback chain shifts. API = acting via the page's structure; Vision = reading pixels."
                                        >
                                            <span
                                                className={`glass-status-pill__dot glass-status-pill__dot--${opActiveMode ?? 'idle'}`}
                                            />
                                            <span className="glass-status-pill__text">
                                                {opActiveProvider ? friendlyProvider(opActiveProvider) : 'Auto'}
                                                {opActiveMode ? ` · ${opActiveMode === 'api' ? 'API' : 'Vision'}` : ''}
                                            </span>
                                        </div>
                                        {opState.pending && (
                                            <button
                                                type="button"
                                                className="glass-cancel-pill"
                                                onClick={onCancelOperator}
                                                title="Stop the running task so you can change settings and start again"
                                            >
                                                <StopIcon />
                                                <span>Cancel</span>
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div className="glass-composer__bar">
                                <div className="glass-composer__left">
                                    <div className="glass-attach-wrap">
                                        {showAttachMenu && (
                                            <>
                                                <div
                                                    className="glass-model-backdrop"
                                                    onClick={() => setShowAttachMenu(false)}
                                                />
                                                <div className="glass-model-menu glass-attach-menu" role="menu">
                                                    <button
                                                        type="button"
                                                        className="glass-model-item"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            setShowAttachMenu(false)
                                                            setShowVideoRecorder(true)
                                                        }}
                                                    >
                                                        <span className="glass-model-item__check"><VideoCameraIcon /></span>
                                                        <span className="glass-model-item__text">
                                                            <span className="glass-model-item__name">Camera</span>
                                                            <span className="glass-model-item__sub">Record a video with this device</span>
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="glass-model-item"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            setShowAttachMenu(false)
                                                            addFileRef.current?.click()
                                                        }}
                                                    >
                                                        <span className="glass-model-item__check"><ImageFileIcon /></span>
                                                        <span className="glass-model-item__text">
                                                            <span className="glass-model-item__name">Files</span>
                                                            <span className="glass-model-item__sub">Images, PDFs, or videos</span>
                                                        </span>
                                                    </button>
                                                    {!operatorMode && (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="glass-model-item"
                                                                role="menuitem"
                                                                disabled={mailBusy}
                                                                onClick={() => {
                                                                    setShowAttachMenu(false)
                                                                    attachSelectedEmail('mail')
                                                                }}
                                                            >
                                                                <span className="glass-model-item__check"><MailIcon /></span>
                                                                <span className="glass-model-item__text">
                                                                    <span className="glass-model-item__name">Email — Apple Mail</span>
                                                                    <span className="glass-model-item__sub">The message selected in Mail</span>
                                                                </span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="glass-model-item"
                                                                role="menuitem"
                                                                disabled={mailBusy}
                                                                onClick={() => {
                                                                    setShowAttachMenu(false)
                                                                    attachSelectedEmail('outlook')
                                                                }}
                                                            >
                                                                <span className="glass-model-item__check"><MailIcon /></span>
                                                                <span className="glass-model-item__text">
                                                                    <span className="glass-model-item__name">Email — Outlook</span>
                                                                    <span className="glass-model-item__sub">The message selected in Outlook</span>
                                                                </span>
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                        <button
                                            type="button"
                                            className="glass-addfile"
                                            onClick={() => setShowAttachMenu((value) => !value)}
                                            aria-expanded={showAttachMenu}
                                            aria-haspopup="menu"
                                            aria-label="Attach from camera or files"
                                            title="Attach — camera or files"
                                        >
                                            <PaperclipIcon />
                                        </button>
                                    </div>
                                    <input
                                        ref={addFileRef}
                                        type="file"
                                        accept="image/*,video/*,application/pdf,.pdf,.mp4,.m4v,.mov,.webm,.ogv"
                                        multiple
                                        className="glass-file-input"
                                        onChange={(e) => {
                                            onAddFiles(e.target.files)
                                            e.target.value = ''
                                        }}
                                    />
                                </div>
                                <div className="glass-composer__actions">
                                    <div className="glass-model-wrap">
                                        {showModels && (
                                            <>
                                                <div
                                                    className="glass-model-backdrop"
                                                    onClick={() => setShowModels(false)}
                                                />
                                                <div className="glass-model-menu" role="menu">
                                                    {curated.recommended.length === 0 &&
                                                        curated.others.length === 0 ? (
                                                        <div className="glass-model-empty">No models found</div>
                                                    ) : (
                                                        <>
                                                            {curated.recommended.length > 0 && (
                                                                <div className="glass-model-section">
                                                                    Recommended
                                                                </div>
                                                            )}
                                                            {curated.recommended.map((m) => (
                                                                <button
                                                                    type="button"
                                                                    key={m.id}
                                                                    className={`glass-model-item${m.id === currentModel ? ' glass-model-item--on' : ''}`}
                                                                    onClick={() => selectModel(m.id)}
                                                                    title={m.id}
                                                                >
                                                                    <span className="glass-model-item__check">
                                                                        {m.id === currentModel ? <CheckIcon /> : null}
                                                                    </span>
                                                                    <span className="glass-model-item__text">
                                                                        <span className="glass-model-item__name">{m.label}</span>
                                                                        {m.sublabel && (
                                                                            <span className="glass-model-item__sub">
                                                                                ({m.sublabel})
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                </button>
                                                            ))}

                                                            {curated.others.length > 0 && (
                                                                <button
                                                                    type="button"
                                                                    className="glass-model-toggle"
                                                                    onClick={() => setShowAllModels((v) => !v)}
                                                                >
                                                                    <CaretIcon open={showAllModels} />
                                                                    {showAllModels
                                                                        ? 'Hide other models'
                                                                        : `Show all models (${curated.others.length})`}
                                                                </button>
                                                            )}

                                                            {showAllModels &&
                                                                curated.others.map((m) => (
                                                                    <button
                                                                        type="button"
                                                                        key={m.id}
                                                                        className={`glass-model-item${m.id === currentModel ? ' glass-model-item--on' : ''}`}
                                                                        onClick={() => selectModel(m.id)}
                                                                        title={m.id}
                                                                    >
                                                                        <span className="glass-model-item__check">
                                                                            {m.id === currentModel ? (
                                                                                <CheckIcon />
                                                                            ) : null}
                                                                        </span>
                                                                        <span className="glass-model-item__text">
                                                                            <span className="glass-model-item__name">{m.label}</span>
                                                                            {m.sublabel && (
                                                                                <span className="glass-model-item__sub">
                                                                                    ({m.sublabel})
                                                                                </span>
                                                                            )}
                                                                        </span>
                                                                    </button>
                                                                ))}
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                        <button
                                            type="button"
                                            className="glass-model"
                                            onClick={openModels}
                                            title={currentModel ? `Model: ${currentModel}` : 'Choose model'}
                                            aria-label="Choose model"
                                        >
                                            <span className="glass-model__name">
                                                {currentModel ? friendlyLabel(currentModel) : 'Model'}
                                            </span>
                                            <CaretIcon open={showModels} />
                                        </button>
                                    </div>
                                    {dictation.supported && (
                                        <button
                                            type="button"
                                            className={`glass-voicepill__mic${dictation.listening || dictation.transcribing ? ' glass-voicepill__mic--on' : ''}`}
                                            onClick={dictation.toggle}
                                            disabled={dictation.transcribing}
                                            aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                                            aria-pressed={dictation.listening}
                                            title={
                                                dictation.transcribing
                                                    ? 'Transcribing your speech…'
                                                    : dictation.listening
                                                        ? 'Stop dictation'
                                                        : 'Dictate: speak instead of typing'
                                            }
                                        >
                                            <VoiceBars active={dictation.listening} />
                                        </button>
                                    )}
                                    {(isSubmittable(draft) || staged.length > 0) && (
                                        <button
                                            type="button"
                                            className="glass-send"
                                            onClick={submit}
                                            disabled={preparingAttachments}
                                            aria-label={preparingAttachments ? 'Preparing video frames' : 'Send message'}
                                            title={preparingAttachments ? 'Preparing video frames for the AI…' : 'Send'}
                                        >
                                            <SendIcon />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
                {codeArtifact && (
                    <CodePanel
                        artifact={codeArtifact}
                        onClose={() => setCodeArtifact(null)}
                        width={codePanelWidth}
                        onResize={setCodePanelWidth}
                    />
                )}
            </div>
        </CodePanelContext.Provider>
    )
}
