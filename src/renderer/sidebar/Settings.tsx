import React, { useCallback, useEffect, useState } from 'react'
import { getConfigBridge } from './config-bridge'

/**
 * Gateway settings form (Req 7.2, 7.4).
 *
 * Primary gateway (URL, model, key) plus an optional fallback gateway used when
 * the primary is unavailable (e.g. a local Ollama instance). The keys are sent
 * to the main process which encrypts and stores them separately. A connection
 * indicator (green = connected, orange = not) reflects the primary credentials.
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

export function Settings(): React.JSX.Element {
    const [baseURL, setBaseURL] = useState('')
    const [model, setModel] = useState('')
    const [apiKey, setApiKey] = useState('')
    const [hasCredentials, setHasCredentials] = useState(false)
    const [fallbackBaseURL, setFallbackBaseURL] = useState('')
    const [fallbackModel, setFallbackModel] = useState('')
    const [fallbackApiKey, setFallbackApiKey] = useState('')
    const [hasFallback, setHasFallback] = useState(false)
    // Free hosted fallback chain (each: paste a key once, used automatically).
    const [openrouterKey, setOpenrouterKey] = useState('')
    const [openrouterModel, setOpenrouterModel] = useState('')
    const [hasOpenrouter, setHasOpenrouter] = useState(false)
    const [glmKey, setGlmKey] = useState('')
    const [glmModel, setGlmModel] = useState('')
    const [hasGlm, setHasGlm] = useState(false)
    const [geminiKey, setGeminiKey] = useState('')
    const [geminiModel, setGeminiModel] = useState('')
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
            setFallbackBaseURL(status.fallbackBaseURL)
            setFallbackModel(status.fallbackModel)
            setHasFallback(status.hasFallback)
            setOpenrouterModel(status.openrouterModel)
            setHasOpenrouter(status.hasOpenrouter)
            setGlmModel(status.glmModel)
            setHasGlm(status.hasGlm)
            setGeminiModel(status.geminiModel)
            setHasGemini(status.hasGemini)
        } catch {
            /* Leave fields as-is; the user can still enter values. */
        }
    }, [])

    useEffect(() => {
        void loadStatus()
    }, [loadStatus])

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
                    fallbackBaseURL: fallbackBaseURL.trim(),
                    fallbackModel: fallbackModel.trim(),
                    fallbackApiKey,
                    openrouterApiKey: openrouterKey,
                    openrouterModel: openrouterModel.trim(),
                    glmApiKey: glmKey,
                    glmModel: glmModel.trim(),
                    geminiApiKey: geminiKey,
                    geminiModel: geminiModel.trim()
                })
                setApiKey('')
                setFallbackApiKey('')
                setOpenrouterKey('')
                setGlmKey('')
                setGeminiKey('')
                setSave({ kind: 'saved' })
                await loadStatus()
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to save settings.'
                setSave({ kind: 'error', message })
            }
        },
        [
            baseURL,
            model,
            apiKey,
            fallbackBaseURL,
            fallbackModel,
            fallbackApiKey,
            openrouterKey,
            openrouterModel,
            glmKey,
            glmModel,
            geminiKey,
            geminiModel,
            loadStatus
        ]
    )

    return (
        <section aria-label="Gateway settings" className="glass-settings">
            <div className="glass-settings__status">
                <span
                    className="glass-settings__dot"
                    style={{ background: hasCredentials ? '#19c37d' : '#5b8def' }}
                    title={hasCredentials ? 'Connected' : 'Running on-device (offline)'}
                />
                <span className="glass-settings__statuslabel">
                    {hasCredentials ? 'Connected' : 'On-device (offline)'}
                </span>
            </div>

            {bridgeMissing && (
                <p style={{ fontSize: 12, color: '#d29922', margin: '4px 0' }}>
                    Settings bridge not available.
                </p>
            )}

            <form onSubmit={onSubmit}>
                <label style={labelStyle} htmlFor="glass-baseurl">
                    Gateway base URL
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

                <p style={sectionTitle}>
                    Fallback gateway {hasFallback && <span style={{ color: '#19c37d' }}>●</span>}
                </p>
                <p style={hintStyle}>
                    Used automatically when the primary is unavailable. For a free local option
                    (private, offline), install Ollama and use base URL http://localhost:11434/v1
                    with a vision model like llama3.2-vision. For higher quality, point it at any
                    OpenAI-compatible vision API such as Google Gemini's free tier. That option
                    sends captures to a third party.
                </p>

                <label style={labelStyle} htmlFor="glass-fb-baseurl">
                    Fallback base URL
                </label>
                <input
                    id="glass-fb-baseurl"
                    type="url"
                    placeholder="http://localhost:11434/v1"
                    value={fallbackBaseURL}
                    onChange={(e) => setFallbackBaseURL(e.target.value)}
                    style={inputStyle}
                />

                <label style={labelStyle} htmlFor="glass-fb-model">
                    Fallback model
                </label>
                <input
                    id="glass-fb-model"
                    type="text"
                    placeholder="llava"
                    value={fallbackModel}
                    onChange={(e) => setFallbackModel(e.target.value)}
                    style={inputStyle}
                />

                <label style={labelStyle} htmlFor="glass-fb-apikey">
                    Fallback API key {fallbackBaseURL && <span style={{ color: '#a6a6ad' }}>(optional)</span>}
                </label>
                <input
                    id="glass-fb-apikey"
                    type="password"
                    autoComplete="off"
                    placeholder="Leave blank for Ollama"
                    value={fallbackApiKey}
                    onChange={(e) => setFallbackApiKey(e.target.value)}
                    style={inputStyle}
                />

                <p style={sectionTitle}>Free fallback models (optional)</p>
                <p style={hintStyle}>
                    Paste a free API key once and it is used automatically whenever the primary
                    gateway is down, in this order, before the on-device model. Each is free and
                    OpenAI-compatible. Get keys at openrouter.ai/keys, open.bigmodel.cn, and
                    aistudio.google.com/apikey.
                </p>

                <label style={labelStyle} htmlFor="glass-or-key">
                    OpenRouter key {hasOpenrouter && <span style={{ color: '#19c37d' }}>●</span>}
                </label>
                <input
                    id="glass-or-key"
                    type="password"
                    autoComplete="off"
                    placeholder={hasOpenrouter ? '•••••••• (stored)' : 'sk-or-...'}
                    value={openrouterKey}
                    onChange={(e) => setOpenrouterKey(e.target.value)}
                    style={inputStyle}
                />
                <input
                    type="text"
                    placeholder="openrouter/free"
                    value={openrouterModel}
                    onChange={(e) => setOpenrouterModel(e.target.value)}
                    style={{ ...inputStyle, marginTop: 6 }}
                />

                <label style={labelStyle} htmlFor="glass-glm-key">
                    Zhipu GLM key {hasGlm && <span style={{ color: '#19c37d' }}>●</span>}
                </label>
                <input
                    id="glass-glm-key"
                    type="password"
                    autoComplete="off"
                    placeholder={hasGlm ? '•••••••• (stored)' : 'Zhipu API key'}
                    value={glmKey}
                    onChange={(e) => setGlmKey(e.target.value)}
                    style={inputStyle}
                />
                <input
                    type="text"
                    placeholder="glm-4v-flash"
                    value={glmModel}
                    onChange={(e) => setGlmModel(e.target.value)}
                    style={{ ...inputStyle, marginTop: 6 }}
                />

                <label style={labelStyle} htmlFor="glass-gem-key">
                    Google Gemini key {hasGemini && <span style={{ color: '#19c37d' }}>●</span>}
                </label>
                <input
                    id="glass-gem-key"
                    type="password"
                    autoComplete="off"
                    placeholder={hasGemini ? '•••••••• (stored)' : 'AIza...'}
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    style={inputStyle}
                />
                <input
                    type="text"
                    placeholder="gemini-2.5-flash"
                    value={geminiModel}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    style={{ ...inputStyle, marginTop: 6 }}
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
        </section>
    )
}
