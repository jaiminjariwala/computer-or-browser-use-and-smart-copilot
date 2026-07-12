import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GlassError, SessionContext, SessionListItem, SessionSummary, TurnCapture, TurnView } from '@shared/types'
import type { AgentSessionView, ConfirmationRequest, LoopStateView } from '@op-shared/types'
import { Settings } from './Settings'
import { getConfigBridge } from './config-bridge'
import { isSubmittable, makeTextTurn } from './chat'
import { describeStep, describeAction, isBusyState, isTerminalState, type StepItem } from './operator'
import { renderPdfToImages } from './pdf'
import { runLocalFallback, buildFallbackRequest } from './localFallback'
import { curateForMode, friendlyLabel, type CuratedModels } from './models'
import { routeIntent } from './intentRouter'
import { VoiceBars } from '../voice-lib'
import { useSmoothDictation as useDictationV2 } from '../voice-lib-v2'
import { useSmoothDictation as useDictationV3 } from '../voice-lib-v3'
import {
    addUserMessage,
    appendTurn,
    clearError,
    initialConversationState,
    setError,
    setPending,
    type ConversationState
} from './conversation'

/**
 * Sidebar shell + chat UI.
 *
 * Capture is triggered from the floating pencil window. Assistant guidance is
 * rendered as Markdown. The header exposes History, New, and Settings panels.
 */

interface ChatBridge {
    sendMessage(text: string): Promise<void>
    sendCaptures(captures: TurnCapture[], text?: string): Promise<void>
    newSession(): Promise<void>
    getSession(): Promise<{ turns: TurnView[]; summary?: SessionSummary }>
    listSessions(): Promise<SessionListItem[]>
    openSession(id: string): Promise<void>
    deleteSessions(ids: string[]): Promise<void>
    listModels(): Promise<string[]>
    onTurnAppended(cb: (turn: TurnView) => void): void | (() => void)
    onPending(cb: (pending: boolean) => void): void | (() => void)
    onError(cb: (err: GlassError) => void): void | (() => void)
    onSessionState?(cb: (session: { turns: TurnView[]; summary?: SessionSummary }) => void): void | (() => void)
    onCredentialsRequired?(cb: () => void): void | (() => void)
    onSummary?(cb: (summary: SessionSummary) => void): void | (() => void)
    onCaptureStaged?(cb: (capture: TurnCapture) => void): void | (() => void)
    onGatewayFallback?(cb: (ctx: SessionContext, originId: string) => void): void | (() => void)
    submitFallbackResult?(text: string | null, originId: string): Promise<void>
}

function getChatBridge(): ChatBridge | null {
    const glass = (window as unknown as { glass?: Partial<ChatBridge> }).glass
    if (glass && typeof glass.sendMessage === 'function') {
        return glass as ChatBridge
    }
    return null
}

/** The merged operator engine bridge, or null when it is not injected. */
function getOperatorBridge(): NonNullable<typeof window.operator> | null {
    const op = window.operator
    return op && typeof op.startGoal === 'function' ? op : null
}

/** Render assistant text as Markdown; user text stays plain. */
function TurnBody({ turn }: { turn: TurnView }): React.JSX.Element {
    if (turn.role === 'assistant') {
        return (
            <div className="glass-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text ?? ''}</ReactMarkdown>
            </div>
        )
    }
    return <>{turn.text}</>
}

/** A staged screenshot awaiting send: the capture plus a display name. */
interface StagedShot {
    id: string
    capture: TurnCapture
    name: string
}

/**
 * A macOS-style display name for a freshly captured screenshot, e.g.
 * "Screenshot 9.02.15 PM.png". Screenshots have no real filename, so we mint
 * one from the capture time to show under each carousel card.
 */
function makeShotName(): string {
    const time = new Date().toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    })
    return `Screenshot ${time}.png`
}

/** macOS Finder style middle-truncation, e.g. "Screens…PM.png". */
function finderName(name = '', startChars = 7, endChars = 6): string {
    if (name.length <= startChars + endChars + 1) return name
    return name.slice(0, startChars) + '\u2026' + name.slice(name.length - endChars)
}

/**
 * Convert a restored operator task (goal + trajectory) into displayable turns so
 * an opened operator session reads like a chat: the goal as a user turn, then
 * each perceive -> reason -> act step as an assistant turn.
 */
function operatorViewToTurns(view: AgentSessionView): TurnView[] {
    // Only the goal renders as a chat turn; the steps render in the checklist
    // (populated separately from the trajectory when the session is opened).
    const turns: TurnView[] = []
    if (view.goalText && view.goalText.trim().length > 0) {
        turns.push({
            id: `op-goal-${view.id}`,
            role: 'user',
            text: view.goalText,
            createdAt: view.createdAt,
            status: 'ok'
        })
    }
    return turns
}

/** The checklist rows for a (restored) operator session's trajectory. */
function operatorViewToSteps(view: AgentSessionView): Array<{ id: string } & StepItem> {
    return (view.trajectory ?? []).map((step) => ({
        id: `op-step-${view.id}-${step.index}`,
        ...describeStep(step)
    }))
}

/** A relative date-bucket label for grouping chats (Today, Yesterday, then month). */
function dateBucketLabel(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'Earlier'
    const startOfDay = (x: Date): number =>
        new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const now = new Date()
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
    if (diffDays <= 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return 'Previous 7 days'
    if (diffDays < 30) return 'Previous 30 days'
    const sameYear = d.getFullYear() === now.getFullYear()
    return d.toLocaleDateString(
        undefined,
        sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }
    )
}

/**
 * Bucket the (already newest-first) chat list into date groups, preserving
 * order so Today comes first, then Yesterday, then older months.
 */
function groupHistoryByDate(
    items: SessionListItem[]
): Array<{ label: string; items: SessionListItem[] }> {
    const groups: Array<{ label: string; items: SessionListItem[] }> = []
    const indexByLabel = new Map<string, number>()
    for (const item of items) {
        const label = dateBucketLabel(item.updatedAt)
        let gi = indexByLabel.get(label)
        if (gi === undefined) {
            gi = groups.length
            indexByLabel.set(label, gi)
            groups.push({ label, items: [] })
        }
        groups[gi].items.push(item)
    }
    return groups
}

/** The two remaining voice engines, shown as V1/V2 (v1 tiny-WASM was dropped). */
const VOICE_VERSIONS: Array<{ value: 2 | 3; label: string; sub: string; title: string }> = [
    { value: 2, label: 'V1', sub: 'reliable', title: 'Whisper base (WebGPU)' },
    { value: 3, label: 'V2', sub: 'fast', title: 'Moonshine base (WebGPU)' }
]

/** Pin glyph for the pin-on-top toggle. */
function PinIcon(): React.JSX.Element {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
    )
}

/** Paperclip glyph for the Add file button. */
function PaperclipIcon(): React.JSX.Element {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
    )
}

/** Clean upward send arrow. */
function SendIcon(): React.JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
        </svg>
    )
}

/** Clean checkmark used for history selection. */
function CheckIcon(): React.JSX.Element {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6L9 17l-5-5" />
        </svg>
    )
}

/** Right-angle chevron used to collapse/expand the sidebar. */
function ChevronIcon({ open }: { open: boolean }): React.JSX.Element {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ display: 'block', transform: open ? 'none' : 'rotate(180deg)' }}
        >
            <path d="M15 6l-6 6 6 6" />
        </svg>
    )
}

/** Small caret used in the model pill to signal the accordion. */
function CaretIcon({ open }: { open: boolean }): React.JSX.Element {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ display: 'block', transform: open ? 'rotate(180deg)' : 'none' }}
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    )
}

/** A filled square "stop" glyph for the Cancel pill. */
function StopIcon(): React.JSX.Element {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="2.5" />
        </svg>
    )
}

/** Friendly display names for the operator's provider ids (for the status pill). */
const PROVIDER_LABELS: Record<string, string> = {
    primary: 'Primary',
    gemini: 'Gemini',
    openrouter: 'OpenRouter',
    glm: 'GLM'
}

/** Map an operator provider id to a short human label; fall back to the id. */
function friendlyProvider(id: string): string {
    return PROVIDER_LABELS[id] ?? id
}

/** One option in a {@link HeaderSelect}. */
interface HeaderSelectOption {
    value: string
    label: string
}

/**
 * A custom header dropdown styled like the composer's model/voice pills, so the
 * operator's Environment / Autonomy controls match the rest of the UI instead
 * of rendering the native macOS `<select>` popup. Opens downward (it lives in
 * the header) and closes on selection or an outside click.
 */
function HeaderSelect({
    value,
    options,
    onChange,
    ariaLabel,
    title
}: {
    value: string
    options: HeaderSelectOption[]
    onChange: (value: string) => void
    ariaLabel: string
    title: string
}): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const current = options.find((o) => o.value === value)

    useEffect(() => {
        if (!open) return
        const onDocPointerDown = (e: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', onDocPointerDown)
        return () => document.removeEventListener('mousedown', onDocPointerDown)
    }, [open])

    return (
        <div className="glass-hselect" ref={rootRef}>
            <button
                type="button"
                className="glass-hselect__btn"
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={title}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="glass-hselect__label">{current?.label ?? ariaLabel}</span>
                <CaretIcon open={open} />
            </button>
            {open && (
                <div className="glass-hselect__menu" role="listbox" aria-label={ariaLabel}>
                    {options.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            role="option"
                            aria-selected={o.value === value}
                            className={`glass-hselect__item${o.value === value ? ' glass-hselect__item--on' : ''}`}
                            onClick={() => {
                                onChange(o.value)
                                setOpen(false)
                            }}
                        >
                            <span className="glass-hselect__check">
                                {o.value === value ? <CheckIcon /> : null}
                            </span>
                            <span className="glass-hselect__text">{o.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

/** Compact goal/step tracker — surfaces the running session summary. */
function GoalTracker({ summary }: { summary: SessionSummary }): React.JSX.Element | null {
    const hasGoal = summary.inferredIntent.trim().length > 0
    const steps = summary.completedSteps
    if (!hasGoal && steps.length === 0) {
        return null
    }
    return (
        <div className="glass-tracker">
            <div className="glass-tracker__label">Goal</div>
            <div className="glass-tracker__goal">
                {hasGoal ? summary.inferredIntent : 'Figuring out your goal…'}
            </div>
            {steps.length > 0 && (
                <ul className="glass-tracker__steps">
                    {steps.map((step, i) => (
                        <li key={i} className="glass-tracker__step">
                            <span className="glass-tracker__check">✓</span>
                            {step}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

export function App(): React.JSX.Element {
    const [state, setState] = useState<ConversationState>(() => initialConversationState())
    const [draft, setDraft] = useState('')
    const [showSettings, setShowSettings] = useState(false)
    const [navOpen, setNavOpen] = useState(() =>
        typeof window !== 'undefined' ? window.innerWidth > 600 : true
    )
    const [history, setHistory] = useState<SessionListItem[]>([])
    const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
    const [showInstructions, setShowInstructions] = useState(false)
    // Whether the window is pinned on top (floating-panel behavior). Off by
    // default so the window behaves like any other and isn't "stubborn".
    const [pinned, setPinnedState] = useState(false)
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
    // The chat currently shown in the chat area (its archived id, once opened),
    // so deleting that exact chat can also clear the view instead of leaving a
    // stale conversation behind.
    const [openSessionId, setOpenSessionId] = useState<string | null>(null)
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
    const [staged, setStaged] = useState<StagedShot[]>([])
    // Operator mode keeps its OWN conversation + history, separate from copilot.
    // Toggling modes swaps the visible chat (copilot chat is hidden, not lost),
    // so each mode reads like its own workspace.
    const [opState, setOpState] = useState<ConversationState>(() => initialConversationState())
    const [opHistory, setOpHistory] = useState<SessionListItem[]>([])
    const baseURLRef = useRef('')
    const conversationRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const addFileRef = useRef<HTMLInputElement>(null)
    const draftRef = useRef('')

    // Live A/B switch between the three frozen voice engines. All three hooks
    // are mounted unconditionally (they stay idle until start() is called and
    // load their worker lazily on first transcribe), so switching is instant
    // and can't regress any baseline. v1 = Whisper tiny (WASM), v2 = Whisper
    // base (WebGPU), v3 = Moonshine base (WebGPU, current default).
    const [voiceVer, setVoiceVer] = useState<2 | 3>(3)
    // The voice-engine picker is a collapsible pill: a mic icon that expands to
    // show the engine versions and collapses again once one is chosen.
    const [voiceOpen, setVoiceOpen] = useState(false)
    const voiceOpts = {
        getText: () => draftRef.current,
        setText: setDraft,
        onError: (message: string) =>
            setState((s) => setError(s, { kind: 'render-failed', message: `Voice: ${message}`, recoverable: true }))
    }
    // v1 (Whisper tiny WASM) was dropped; only the two WebGPU engines remain,
    // shown to the user as V1 (Whisper base) and V2 (Moonshine, default).
    const d2 = useDictationV2(voiceOpts)
    const d3 = useDictationV3(voiceOpts)
    const dictation = voiceVer === 2 ? d2 : d3

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
                if (active && session?.turns?.length) {
                    setState(initialConversationState(session.turns))
                }
                if (active && session?.summary) {
                    setSummary(session.summary)
                }
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
                setState(initialConversationState(session?.turns ?? []))
                setSummary(session?.summary ?? null)
            }),
            bridge.onSummary?.((s) => setSummary(s)),
            bridge.onCaptureStaged?.((capture) =>
                setStaged((prev) => [
                    ...prev,
                    { id: `shot-${Date.now()}-${prev.length}`, capture, name: makeShotName() }
                ])
            ),
            // Gateway is down -> answer with the on-device SmolVLM fallback and
            // report the result back so main appends it + clears pending.
            bridge.onGatewayFallback?.((ctx, originId) => {
                const { images, prompt } = buildFallbackRequest(ctx)
                runLocalFallback(images, prompt)
                    .then((text) => bridge.submitFallbackResult?.(text || null, originId))
                    .catch(() => bridge.submitFallbackResult?.(null, originId))
            }),
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
                appendAssistant(question)
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
        let wasWide = window.innerWidth > 600
        const onResize = (): void => {
            const isWide = window.innerWidth > 600
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
        const cb = getConfigBridge()
        if (cb) {
            // Persist via saveConfig; empty apiKey keeps the stored key.
            void cb
                .saveConfig({ baseURL: baseURLRef.current, model: m, apiKey: '' })
                .catch(() => undefined)
        }
    }, [])

    // Start an operator task for `goal` in the given environment: record it in
    // the operator conversation and kick off the engine. Shared by the explicit
    // operator path and the auto-router (a copilot command routed to operator).
    const runOperatorGoal = useCallback(
        (goal: string, environment: 'browser' | 'container-desktop' | 'local') => {
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
                    autonomy: opAutonomy,
                    stepBudget: Math.max(1, Number.parseInt(opStepBudget, 10) || 25),
                    environment
                })
                .then((result) => {
                    if (!result.ok) {
                        setOpState((s) => setPending(s, false))
                        setOpState((s) =>
                            setError(s, { kind: 'render-failed', message: result.error.message, recoverable: true })
                        )
                    }
                })
                .catch((err: unknown) => {
                    setOpState((s) => setPending(s, false))
                    const message = err instanceof Error ? err.message : 'Failed to start the task.'
                    setOpState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
                })
        },
        [opAutonomy, opStepBudget]
    )

    const submit = useCallback(() => {
        const hasCaptures = staged.length > 0
        // Screenshots can be sent on their own, so an empty draft is fine when
        // the carousel has captures.
        if (!isSubmittable(draft) && !hasCaptures) {
            return
        }
        const text = draft
        setDraft('')

        // Sending ends the utterance: turn the mic off so it isn't left
        // listening after the message goes out. Cancel (rather than stop) so no
        // trailing transcription lands back in the now-cleared field.
        if (dictation.listening) cancelActive()

        // Staged screenshots take priority: send them (plus any typed text) as a
        // single multi-image message to the COPILOT chat, then clear the carousel.
        if (hasCaptures) {
            setState((s) => addUserMessage(s, text).state)
            const captures = staged.map((s) => s.capture)
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
                const message = err instanceof Error ? err.message : 'Failed to send your screenshots.'
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
    }, [draft, staged, operatorMode, opEnvironment, runOperatorGoal, dictation, cancelActive])

    /** Remove one staged screenshot from the carousel before sending. */
    const removeStaged = useCallback((id: string) => {
        setStaged((prev) => prev.filter((s) => s.id !== id))
    }, [])

    /**
     * Add image and PDF files from disk to the same carousel the screenshots
     * use, so they send as one multi-image message. Images are staged directly;
     * PDFs are rasterized page-by-page (a vision gateway can't read a raw PDF)
     * and each page is staged as its own card.
     */
    const onAddFiles = useCallback((files: FileList | null) => {
        if (!files) return
        const stageImage = (dataUrl: string, name: string): void => {
            setStaged((prev) => [
                ...prev,
                {
                    id: `file-${Date.now()}-${prev.length}-${name}`,
                    capture: { dataUrl, thumbnailUrl: dataUrl, rect: { x: 0, y: 0, width: 0, height: 0 } },
                    name
                }
            ])
        }

        for (const file of Array.from(files)) {
            const isPdf =
                file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
            if (isPdf) {
                void renderPdfToImages(file)
                    .then((pages) => {
                        pages.forEach((dataUrl, i) => {
                            const label =
                                pages.length > 1
                                    ? `${file.name} p${i + 1}`
                                    : file.name
                            stageImage(dataUrl, label)
                        })
                    })
                    .catch((err: unknown) => {
                        const detail = err instanceof Error ? `: ${err.message}` : ''
                        setState((s) =>
                            setError(s, {
                                kind: 'render-failed',
                                message: `Could not read the PDF "${file.name}"${detail}`,
                                recoverable: true
                            })
                        )
                    })
                continue
            }
            if (!file.type.startsWith('image/')) continue
            const reader = new FileReader()
            reader.onload = () => {
                const dataUrl = String(reader.result ?? '')
                if (dataUrl) stageImage(dataUrl, file.name)
            }
            reader.readAsDataURL(file)
        }
    }, [])

    // Drag-and-drop an image (e.g. a screenshot from the Desktop) anywhere onto
    // the app to stage it above the input. Electron would otherwise NAVIGATE to
    // the dropped file (the "it just goes away" bug), so we preventDefault on the
    // whole window and route image files through the same staging path.
    useEffect(() => {
        const onDragOver = (e: DragEvent): void => {
            if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
        }
        const onDrop = (e: DragEvent): void => {
            const files = e.dataTransfer?.files
            const hasImage =
                !!files &&
                files.length > 0 &&
                Array.from(files).some((f) => f.type.startsWith('image/') || f.type === 'application/pdf')
            // Always prevent the default file navigation; only stage images/PDFs.
            e.preventDefault()
            if (hasImage) onAddFiles(files!)
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
                                    ? it.goalText
                                    : 'Untitled task',
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
            setOpenSessionId(null)
            setOpSteps([])
            refreshOpHistory()
            if (window.innerWidth <= 600) setNavOpen(false)
            return
        }
        const bridge = getChatBridge()
        if (!bridge || typeof bridge.newSession !== 'function') {
            return
        }
        void bridge.newSession().then(() => refreshHistory()).catch(() => undefined)
        setOpenSessionId(null)
        setState(initialConversationState([]))
        setDraft('')
        setSummary(null)
        setStaged([])
        if (window.innerWidth <= 600) setNavOpen(false)
    }, [operatorMode, refreshHistory, refreshOpHistory])

    const onOpenSession = useCallback(
        (id: string) => {
            // Keep the sidebar open on wide layouts (it's a persistent pane); only
            // auto-close on the narrow/mobile overlay where it covers the chat.
            if (window.innerWidth <= 600) setNavOpen(false)
            setOpenSessionId(id)
            if (operatorMode) {
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
            const bridge = getChatBridge()
            if (bridge && typeof bridge.openSession === 'function') {
                void bridge.openSession(id).then(() => refreshHistory()).catch(() => undefined)
            }
        },
        [operatorMode, refreshHistory]
    )

    const toggleSettings = useCallback(() => {
        setShowSettings((v) => !v)
        setShowInstructions(false)
    }, [])

    const toggleInstructions = useCallback(() => {
        setShowInstructions((v) => !v)
        setShowSettings(false)
    }, [])

    const togglePin = useCallback(() => {
        setPinnedState((prev) => {
            const next = !prev
            const bridge = getChatBridge()
            void (bridge as { setPinned?: (f: boolean) => Promise<void> })?.setPinned?.(next)
            return next
        })
    }, [])

    const onChatContextMenu = useCallback((e: React.MouseEvent, id: string) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, id })
    }, [])

    const deleteOne = useCallback(
        (id: string) => {
            setMenu(null)
            // Delete from whichever store owns the active mode: operator tasks go
            // through the operator bridge, copilot chats through the chat bridge.
            const deletingOpen = id === openSessionId
            if (operatorMode) {
                const op = getOperatorBridge()
                if (op && typeof op.deleteSessions === 'function') {
                    void op
                        .deleteSessions([id])
                        .then(() => refreshOpHistory())
                        .catch(() => undefined)
                }
                // Deleting the chat currently on screen clears the operator view
                // (the copilot view is cleared by main via session:state).
                if (deletingOpen) {
                    void op?.stopSession?.().catch(() => undefined)
                    setOpState(initialConversationState([]))
                    setOpActiveProvider(null)
                    setOpActiveMode(null)
                    setOpenSessionId(null)
                    setOpSteps([])
                }
                return
            }
            const bridge = getChatBridge()
            if (bridge && typeof bridge.deleteSessions === 'function') {
                void bridge.deleteSessions([id]).then(() => refreshHistory()).catch(() => undefined)
            }
            if (deletingOpen) setOpenSessionId(null)
        },
        [operatorMode, openSessionId, refreshHistory, refreshOpHistory]
    )

    // The visible conversation + history depend on the active mode. Copilot and
    // operator each keep their own; toggling swaps which one shows.
    const conv = operatorMode ? opState : state
    const setConv = operatorMode ? setOpState : setState
    const shownHistory = operatorMode ? opHistory : history

    return (
        <div className={`glass-app${navOpen ? '' : ' glass-app--navhidden'}`}>
            <aside className={`glass-nav${navOpen ? ' glass-nav--open' : ''}`}>
                <div className="glass-nav__top">
                    <button
                        type="button"
                        className="glass-iconbtn glass-iconbtn--icon"
                        onClick={() => setNavOpen(false)}
                        aria-label="Collapse chats"
                        title="Collapse chats"
                    >
                        <ChevronIcon open={true} />
                    </button>
                </div>
                <div className="glass-nav__modes">
                    <button
                        type="button"
                        className={`glass-modebtn${operatorMode ? ' glass-modebtn--on' : ''}`}
                        onClick={() => setOperatorMode((v) => !v)}
                        aria-pressed={operatorMode}
                        title={
                            operatorMode
                                ? 'Computer or Browser Use is ON (autonomous agent). Click to switch back to Smart Copilot.'
                                : 'Switch to Computer or Browser Use (an autonomous agent that controls the browser or your Mac).'
                        }
                    >
                        Computer or Browser Use
                    </button>
                </div>
                <div className="glass-nav__list">
                    {shownHistory.length === 0 ? null : (
                        groupHistoryByDate(shownHistory).map((group) => (
                            <div className="glass-history__group" key={group.label}>
                                <div className="glass-history__group-label">{group.label}</div>
                                {group.items.map((item) => (
                                    <button
                                        type="button"
                                        key={item.id}
                                        className="glass-history__item"
                                        onClick={() => onOpenSession(item.id)}
                                        onContextMenu={(e) => onChatContextMenu(e, item.id)}
                                    >
                                        <span className="glass-history__text">
                                            <span className="glass-history__item-title">
                                                {item.title}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                </div>
            </aside>

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
                        <button
                            type="button"
                            className={`glass-iconbtn glass-iconbtn--icon${pinned ? ' glass-iconbtn--on' : ''}`}
                            onClick={togglePin}
                            aria-pressed={pinned}
                            aria-label={pinned ? 'Window stays on top: on' : 'Window stays on top: off'}
                            title={
                                pinned
                                    ? 'Keep window on top: ON (click to let it go behind others)'
                                    : 'Keep window on top: OFF (click to float above all windows)'
                            }
                        >
                            <PinIcon />
                        </button>
                        <button
                            type="button"
                            className="glass-iconbtn"
                            onClick={onNewSession}
                            title={operatorMode ? 'Start a new operator task' : 'Start a new chat'}
                        >
                            New
                        </button>
                        {!operatorMode && (
                            <button
                                type="button"
                                className="glass-iconbtn"
                                onClick={toggleInstructions}
                                title="Custom instructions the copilot follows every reply"
                            >
                                Instructions
                            </button>
                        )}
                        <button
                            type="button"
                            className="glass-iconbtn"
                            onClick={toggleSettings}
                            title="Settings: API keys, models, and preferences"
                        >
                            Settings
                        </button>
                    </div>
                </header>

                {showSettings ? (
                    <div className="glass-panel">
                        <div className="glass-settings__scroll">
                            <Settings />
                        </div>
                    </div>
                ) : showInstructions ? (
                    <div className="glass-panel">
                        <div className="glass-history__bar">
                            <span className="glass-history__title">How to use Smart Copilot</span>
                            <button
                                type="button"
                                className="glass-iconbtn"
                                onClick={() => setShowInstructions(false)}
                            >
                                Close
                            </button>
                        </div>
                        <div className="glass-settings__scroll">
                            <ol className="glass-onboard">
                                <li>Open Settings and add your gateway (URL, model, key), or a free key.</li>
                                <li>Take a screenshot with macOS (⌘⇧4 region, ⌘⇧3 full, or ⌘⇧5) to the clipboard, then paste it here with ⌘V. You can also drag an image in or use the paperclip.</li>
                                <li>Ask about it, or just type a question. Smart Copilot remembers the whole conversation, so you never explain yourself twice.</li>
                                <li>Type a command like "open youtube and play a song" and it switches to Computer or Browser Use to do it for you.</li>
                            </ol>
                        </div>
                    </div>
                ) : (
                    <div className="glass-conversation" ref={conversationRef} aria-live="polite">
                        {!operatorMode && summary && <GoalTracker summary={summary} />}

                        {conv.turns.map((turn) => (
                            <div
                                key={turn.id}
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
                                                    alt={`Captured screen region ${ci + 1}`}
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
                        ))}

                        {/* Operator steps: a bordered checklist (tick per done
                            step, a spinner trailing while the agent works). */}
                        {operatorMode && (opSteps.length > 0 || conv.pending) && (
                            <div className="glass-steps" role="list" aria-label="Operator steps">
                                {opSteps.map((s) => (
                                    <div
                                        key={s.id}
                                        role="listitem"
                                        className={`glass-step${s.kind === 'failure' ? ' glass-step--error' : ''}`}
                                    >
                                        <span className="glass-step__icon">
                                            <CheckIcon />
                                        </span>
                                        <span className="glass-step__text">
                                            <span className="glass-step__label">{s.label}</span>
                                            {s.sub && <span className="glass-step__sub">{s.sub}</span>}
                                            {s.meta && <span className="glass-step__meta">{s.meta}</span>}
                                        </span>
                                    </div>
                                ))}
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

                        {/* Copilot uses the classic three-dot thinking row. */}
                        {conv.pending && !operatorMode && (
                            <div className="glass-row glass-row--assistant">
                                <div className="glass-pending" role="status" aria-label="Glass is thinking">
                                    <span className="glass-pending__dot" />
                                    <span className="glass-pending__dot" />
                                    <span className="glass-pending__dot" />
                                </div>
                            </div>
                        )}

                        {confirmation && (
                            <div className="glass-confirm" role="alertdialog" aria-label="Confirm action">
                                <div className="glass-confirm__title">
                                    {confirmation.highRisk ? 'Confirm high-risk action' : 'Confirm action'}
                                </div>
                                <div className="glass-confirm__action">
                                    {describeAction(confirmation.action)}
                                </div>
                                {confirmation.rationale.trim().length > 0 && (
                                    <div className="glass-confirm__why">{confirmation.rationale}</div>
                                )}
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

                {staged.length > 0 && (
                    <div className="glass-carousel" aria-label="Staged screenshots">
                        {staged.map((shot) => (
                            <div className="glass-shot" key={shot.id}>
                                <button
                                    type="button"
                                    className="glass-shot__remove"
                                    onClick={() => removeStaged(shot.id)}
                                    aria-label={`Remove ${shot.name}`}
                                    title="Remove"
                                >
                                    ×
                                </button>
                                <div className="glass-shot__thumb">
                                    <img
                                        src={shot.capture.thumbnailUrl}
                                        alt={shot.name}
                                        draggable={false}
                                    />
                                </div>
                                <div className="glass-shot__name">{finderName(shot.name)}</div>
                            </div>
                        ))}
                    </div>
                )}

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
                            <button
                                type="button"
                                className="glass-addfile"
                                onClick={() => addFileRef.current?.click()}
                                aria-label="Add image files"
                                title="Attach images or a PDF"
                            >
                                <PaperclipIcon />
                            </button>
                            <input
                                ref={addFileRef}
                                type="file"
                                accept="image/*,application/pdf,.pdf"
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
                                <div
                                    className={`glass-voicepill${voiceOpen ? ' glass-voicepill--open' : ''}`}
                                    role="group"
                                    aria-label="Voice"
                                >
                                    {voiceOpen && (
                                        <>
                                            <div
                                                className="glass-model-backdrop"
                                                onClick={() => setVoiceOpen(false)}
                                            />
                                            <div className="glass-voice-menu" role="menu">
                                                {VOICE_VERSIONS.map(({ value, label, sub, title }) => (
                                                    <button
                                                        type="button"
                                                        key={value}
                                                        className={`glass-model-item${voiceVer === value ? ' glass-model-item--on' : ''}`}
                                                        onClick={() => {
                                                            // Stop the current (possibly stuck)
                                                            // engine before switching.
                                                            cancelActive()
                                                            setVoiceVer(value)
                                                            setVoiceOpen(false)
                                                        }}
                                                        title={title}
                                                    >
                                                        <span className="glass-model-item__check">
                                                            {voiceVer === value ? <CheckIcon /> : null}
                                                        </span>
                                                        <span className="glass-model-item__text">
                                                            <span className="glass-model-item__name">{label}</span>
                                                            <span className="glass-model-item__sub">({sub})</span>
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
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
                                    <button
                                        type="button"
                                        className="glass-voicepill__caret"
                                        onClick={() => setVoiceOpen((v) => !v)}
                                        title="Choose voice engine (V1 reliable / V2 fast)"
                                        aria-label="Choose voice engine"
                                    >
                                        <CaretIcon open={voiceOpen} />
                                    </button>
                                </div>
                            )}
                            {(isSubmittable(draft) || staged.length > 0) && (
                                <button
                                    type="button"
                                    className="glass-send"
                                    onClick={submit}
                                    aria-label="Send message"
                                    title="Send"
                                >
                                    <SendIcon />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
