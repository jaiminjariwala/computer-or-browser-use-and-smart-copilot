import React, { useCallback, useState } from 'react'
import { getConfigBridge } from './config-bridge'

/**
 * In-chat key setup card, shown when a question arrives and NO AI provider is
 * configured. The user pastes one free key right here — no Settings hunt —
 * and asks again. Company/personal endpoints route to the full Settings form.
 */

type Provider = 'gemini' | 'openrouter'

const PROVIDERS: Record<Provider, { label: string; keyHint: string; getKeyAt: string }> = {
    gemini: {
        label: 'Google Gemini',
        keyHint: 'AIza…',
        getKeyAt: 'aistudio.google.com/app/apikey'
    },
    openrouter: {
        label: 'OpenRouter',
        keyHint: 'sk-or-…',
        getKeyAt: 'openrouter.ai/settings/keys'
    }
}

interface SetupCardProps {
    /** Open the full Settings form (company/personal endpoint path). */
    onOpenSettings: () => void
}

export function SetupCard({ onOpenSettings }: SetupCardProps): React.JSX.Element {
    const [provider, setProvider] = useState<Provider>('gemini')
    const [key, setKey] = useState('')
    const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
    const [errorText, setErrorText] = useState('')

    const connect = useCallback(async () => {
        const trimmed = key.trim()
        if (trimmed.length === 0) return
        const bridge = getConfigBridge()
        if (!bridge) {
            setState('error')
            setErrorText('Settings are unavailable right now.')
            return
        }
        setState('saving')
        try {
            // Preserve whatever else is stored; only add the pasted key.
            const status = await bridge.getConfigStatus()
            await bridge.saveConfig({
                baseURL: status.baseURL,
                model: status.model,
                apiKey: '',
                geminiApiKey: provider === 'gemini' ? trimmed : undefined,
                openrouterApiKey: provider === 'openrouter' ? trimmed : undefined
            })
            setKey('')
            setState('saved')
        } catch (err) {
            setState('error')
            setErrorText(err instanceof Error ? err.message : 'Could not save the key.')
        }
    }, [key, provider])

    if (state === 'saved') {
        return (
            <div className="glass-setupcard" role="status">
                <div className="glass-setupcard__title">Connected ✓</div>
                <p className="glass-setupcard__sub">
                    Your {PROVIDERS[provider].label} key is saved (encrypted on this Mac).
                    Ask your question again and it will answer.
                </p>
            </div>
        )
    }

    return (
        <div className="glass-setupcard" role="form" aria-label="Connect an AI provider">
            <div className="glass-setupcard__title">Connect an AI to get answers</div>
            <p className="glass-setupcard__sub">
                One free key is enough — it takes about a minute and is stored
                encrypted on this Mac only.
            </p>

            <div className="glass-setupcard__tabs" role="tablist" aria-label="Free key provider">
                {(Object.keys(PROVIDERS) as Provider[]).map((id) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={provider === id}
                        className={`glass-setupcard__tab${provider === id ? ' glass-setupcard__tab--on' : ''}`}
                        onClick={() => setProvider(id)}
                    >
                        {PROVIDERS[id].label}
                        <span className="glass-setupcard__free">free</span>
                    </button>
                ))}
            </div>

            <p className="glass-setupcard__hint">
                Get your free key at <strong>{PROVIDERS[provider].getKeyAt}</strong>, then paste it:
            </p>

            <div className="glass-setupcard__row">
                <input
                    type="password"
                    autoComplete="off"
                    className="glass-setupcard__input"
                    placeholder={PROVIDERS[provider].keyHint}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            void connect()
                        }
                    }}
                    aria-label={`${PROVIDERS[provider].label} API key`}
                />
                <button
                    type="button"
                    className="glass-setupcard__connect"
                    onClick={() => void connect()}
                    disabled={state === 'saving' || key.trim().length === 0}
                >
                    {state === 'saving' ? 'Saving…' : 'Connect'}
                </button>
            </div>
            {state === 'error' && <p className="glass-setupcard__error">{errorText}</p>}

            <button type="button" className="glass-setupcard__alt" onClick={onOpenSettings}>
                Using a company or personal endpoint instead? Open Settings
            </button>
        </div>
    )
}
