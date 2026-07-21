import React, { useCallback, useEffect, useState } from 'react'
import type { MemoryEntry } from '@shared/types'
import { getConfigBridge } from './config-bridge'
import { getChatBridge } from './bridges'

/**
 * AI settings — deliberately small. Two ways to connect, nothing else:
 *
 *  1. A free key (Google Gemini or OpenRouter), pasted once.
 *  2. Your own OpenAI-compatible endpoint (company gateway or personal), with
 *     base URL + model + key.
 *
 * Keys are sent to the main process, encrypted with the macOS keychain, and
 * never rendered back. The chain tries your own endpoint first (when set),
 * then the free providers.
 */

type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-dim)',
    margin: '12px 0 4px'
}

const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: 13,
    color: 'var(--text)',
    background: 'var(--field-bg)',
    border: '1px solid var(--field-border)',
    borderRadius: 8,
    outline: 'none'
}

const sectionTitle: React.CSSProperties = {
    fontSize: 12.5,
    color: 'var(--text)',
    margin: '22px 0 2px',
    fontWeight: 600
}

const hintStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: 'var(--text-dim)',
    margin: '0 0 4px',
    lineHeight: 1.4
}

const storedDot = <span style={{ color: '#19c37d' }}>●</span>

export function Settings(): React.JSX.Element {
    const [baseURL, setBaseURL] = useState('')
    const [model, setModel] = useState('')
    const [apiKey, setApiKey] = useState('')
    const [hasCredentials, setHasCredentials] = useState(false)
    const [openrouterKey, setOpenrouterKey] = useState('')
    const [hasOpenrouter, setHasOpenrouter] = useState(false)
    const [geminiKey, setGeminiKey] = useState('')
    const [hasGemini, setHasGemini] = useState(false)
    const [bridgeMissing, setBridgeMissing] = useState(false)
    const [save, setSave] = useState<SaveState>({ kind: 'idle' })

    const loadStatus = useCallback(async () => {
        const bridge = getConfigBridge()
        if (!bridge) {
            setBridgeMissing(true)
            return
        }
        setBridgeMissing(false)
        try {
            const status = await bridge.getConfigStatus()
            setBaseURL(status.baseURL)
            setModel(status.model)
            setHasCredentials(status.hasCredentials)
            setHasOpenrouter(status.hasOpenrouter)
            setHasGemini(status.hasGemini)
        } catch {
            /* Leave fields as-is; the user can still enter values. */
        }
    }, [])

    useEffect(() => {
        void loadStatus()
    }, [loadStatus])

    const anyConnected = hasCredentials || hasOpenrouter || hasGemini

    const onSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault()
            const bridge = getConfigBridge()
            if (!bridge) {
                setSave({ kind: 'error', message: 'Settings are unavailable right now.' })
                return
            }
            setSave({ kind: 'saving' })
            try {
                await bridge.saveConfig({
                    baseURL: baseURL.trim(),
                    model: model.trim(),
                    apiKey,
                    openrouterApiKey: openrouterKey,
                    geminiApiKey: geminiKey
                })
                setApiKey('')
                setOpenrouterKey('')
                setGeminiKey('')
                setSave({ kind: 'saved' })
                await loadStatus()
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to save settings.'
                setSave({ kind: 'error', message })
            }
        },
        [baseURL, model, apiKey, openrouterKey, geminiKey, loadStatus]
    )

    return (
        <section aria-label="AI settings" className="glass-settings">
            <div className="glass-settings__status">
                <span
                    className="glass-settings__dot"
                    style={{ background: anyConnected ? '#19c37d' : '#d29922' }}
                    title={anyConnected ? 'An AI provider is connected' : 'No AI connected yet'}
                />
                <span className="glass-settings__statuslabel">
                    {anyConnected ? 'Connected' : 'Not connected'}
                </span>
            </div>

            {bridgeMissing && (
                <p style={{ fontSize: 12, color: '#d29922', margin: '4px 0' }}>
                    Settings bridge not available.
                </p>
            )}

            <form onSubmit={onSubmit}>
                <p style={sectionTitle}>Free keys</p>
                <p style={hintStyle}>
                    Paste one and you're done — it's encrypted on this Mac and used
                    automatically. Either provider works; with both, Gemini is tried first
                    for tasks and OpenRouter first for chat fallback.
                </p>

                <label style={labelStyle} htmlFor="glass-gem-key">
                    Google Gemini key {hasGemini && storedDot}
                </label>
                <p style={hintStyle}>Get it at aistudio.google.com/app/apikey</p>
                <input
                    id="glass-gem-key"
                    type="password"
                    autoComplete="off"
                    placeholder={hasGemini ? '•••••••• (stored — paste to replace)' : 'AIza…'}
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    style={inputStyle}
                />

                <label style={labelStyle} htmlFor="glass-or-key">
                    OpenRouter key {hasOpenrouter && storedDot}
                </label>
                <p style={hintStyle}>Get it at openrouter.ai/settings/keys</p>
                <input
                    id="glass-or-key"
                    type="password"
                    autoComplete="off"
                    placeholder={hasOpenrouter ? '•••••••• (stored — paste to replace)' : 'sk-or-…'}
                    value={openrouterKey}
                    onChange={(e) => setOpenrouterKey(e.target.value)}
                    style={inputStyle}
                />

                <p style={sectionTitle}>
                    Your own AI (company or personal) {hasCredentials && storedDot}
                </p>
                <p style={hintStyle}>
                    Any OpenAI-compatible endpoint: a corporate gateway, a paid account, or
                    a local server. When set, it is always tried first.
                </p>

                <label style={labelStyle} htmlFor="glass-baseurl">
                    Base URL
                </label>
                <input
                    id="glass-baseurl"
                    type="url"
                    placeholder="https://your-gateway/v1"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    style={inputStyle}
                />

                <label style={labelStyle} htmlFor="glass-model">
                    Model
                </label>
                <input
                    id="glass-model"
                    type="text"
                    placeholder="vision-capable-model-id"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    style={inputStyle}
                />

                <label style={labelStyle} htmlFor="glass-apikey">
                    API key {hasCredentials && <span style={{ color: '#a6a6ad' }}>(stored, leave blank to keep)</span>}
                </label>
                <input
                    id="glass-apikey"
                    type="password"
                    autoComplete="off"
                    placeholder={hasCredentials ? '••••••••' : 'Enter API key'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    style={inputStyle}
                />

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                    <button
                        type="submit"
                        disabled={save.kind === 'saving'}
                        style={{
                            padding: '7px 16px',
                            fontSize: 13,
                            fontWeight: 400,
                            color: 'var(--text)',
                            background: 'var(--field-bg)',
                            border: '1px solid var(--field-border)',
                            borderRadius: 8,
                            cursor: save.kind === 'saving' ? 'default' : 'pointer',
                            opacity: save.kind === 'saving' ? 0.6 : 1
                        }}
                    >
                        {save.kind === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                    {save.kind === 'saved' && (
                        <span style={{ fontSize: 12, color: '#6b6b73' }}>Saved</span>
                    )}
                    {save.kind === 'error' && (
                        <span style={{ fontSize: 12, color: '#9a2530' }}>{save.message}</span>
                    )}
                </div>
            </form>

            <MemorySection />
        </section>
    )
}

/**
 * Persistent memory — the audit surface. Everything the assistant remembers
 * lives here: add a fact, delete one, or clear the lot. Entries also arrive
 * from chat when a message starts with "remember …". Local JSON only; the
 * only place memories ever travel is inside your own AI requests.
 */
function MemorySection(): React.JSX.Element {
    const [entries, setEntries] = useState<MemoryEntry[]>([])
    const [newFact, setNewFact] = useState('')

    const bridge = getChatBridge()

    useEffect(() => {
        if (bridge && typeof bridge.listMemories === 'function') {
            void bridge.listMemories().then(setEntries).catch(() => undefined)
        }
        // The bridge is a stable global; run once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const add = useCallback(() => {
        const text = newFact.trim()
        if (text.length === 0) return
        if (!bridge || typeof bridge.addMemory !== 'function') return
        void bridge
            .addMemory(text)
            .then((list) => {
                setEntries(list)
                setNewFact('')
            })
            .catch(() => undefined)
    }, [bridge, newFact])

    const remove = useCallback(
        (id: string) => {
            if (!bridge || typeof bridge.deleteMemory !== 'function') return
            void bridge.deleteMemory(id).then(setEntries).catch(() => undefined)
        },
        [bridge]
    )

    const clearAll = useCallback(() => {
        if (!bridge || typeof bridge.clearMemories !== 'function') return
        void bridge.clearMemories().then(setEntries).catch(() => undefined)
    }, [bridge])

    return (
        <div aria-label="Persistent memory">
            <h3 style={sectionTitle}>Memory</h3>
            <p style={hintStyle}>
                Facts the assistant keeps across chats. Say “remember …” in a chat, or add one
                here. Stored only on this Mac; delete anything, anytime.
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                    type="text"
                    placeholder="e.g. I prefer short answers"
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            add()
                        }
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                    aria-label="New memory"
                />
                <button
                    type="button"
                    onClick={add}
                    disabled={newFact.trim().length === 0}
                    style={{
                        padding: '7px 14px',
                        fontSize: 13,
                        color: 'var(--text)',
                        background: 'var(--field-bg)',
                        border: '1px solid var(--field-border)',
                        borderRadius: 8,
                        cursor: newFact.trim().length === 0 ? 'default' : 'pointer',
                        opacity: newFact.trim().length === 0 ? 0.5 : 1
                    }}
                >
                    Add
                </button>
            </div>

            {entries.length === 0 ? (
                <p style={{ ...hintStyle, margin: '10px 0 0' }}>Nothing remembered yet.</p>
            ) : (
                <div style={{ marginTop: 10 }}>
                    {entries.map((entry) => (
                        <div
                            key={entry.id}
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '7px 2px',
                                borderBottom: '1px solid var(--field-border)'
                            }}
                        >
                            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                                {entry.text}
                            </span>
                            <button
                                type="button"
                                onClick={() => remove(entry.id)}
                                aria-label={`Forget "${entry.text}"`}
                                title="Forget this"
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: 'var(--text-dim)',
                                    fontSize: 14,
                                    lineHeight: 1,
                                    cursor: 'pointer',
                                    padding: '2px 6px'
                                }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={clearAll}
                        style={{
                            marginTop: 10,
                            padding: '6px 12px',
                            fontSize: 12,
                            color: 'var(--text-dim)',
                            background: 'transparent',
                            border: '1px solid var(--field-border)',
                            borderRadius: 8,
                            cursor: 'pointer'
                        }}
                    >
                        Forget everything
                    </button>
                </div>
            )}
        </div>
    )
}
