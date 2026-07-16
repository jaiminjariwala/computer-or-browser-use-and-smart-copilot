import React, { useCallback, useEffect, useState } from 'react'
import type {
    GitHubAuthStatus,
    GitHubDeviceChallenge,
    SessionListItem
} from '@shared/types'

interface ChatSidebarProps {
    items: SessionListItem[]
    activeId: string | null
    running: boolean
    operatorMode: boolean
    settingsOpen: boolean
    onCollapse: () => void
    onNewSession: () => void
    onToggleOperator: () => void
    onOpenSession: (id: string) => void
    onChatContextMenu: (event: React.MouseEvent, id: string) => void
    onToggleSettings: () => void
}

function SidebarCollapseIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M9 3v18" />
            <path d="m15 9-3 3 3 3" />
        </svg>
    )
}

function NewChatIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
    )
}

function BrowserUseIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="14" rx="2.5" />
            <path d="M8 21h8M12 18v3" />
            <path d="m16.5 7 .45 1.05L18 8.5l-1.05.45L16.5 10l-.45-1.05L15 8.5l1.05-.45Z" />
        </svg>
    )
}

function SettingsIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
        </svg>
    )
}

function GitHubIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.57.1.78-.25.78-.55v-2.2c-3.18.7-3.85-1.35-3.85-1.35-.52-1.33-1.27-1.68-1.27-1.68-1.04-.7.08-.7.08-.7 1.15.09 1.75 1.19 1.75 1.19 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.54-.29-5.21-1.27-5.21-5.64 0-1.25.44-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.03 0 0 .96-.31 3.14 1.17A10.9 10.9 0 0 1 12 6.18c.97 0 1.93.13 2.84.38 2.18-1.48 3.14-1.17 3.14-1.17.62 1.58.23 2.74.11 3.03.74.8 1.18 1.82 1.18 3.07 0 4.38-2.68 5.34-5.22 5.63.41.36.77 1.05.77 2.12v3.21c0 .3.21.66.79.55A11.4 11.4 0 0 0 12 .8Z" />
        </svg>
    )
}

function dateBucketLabel(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return 'Earlier'
    const atDayStart = (value: Date): number =>
        new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
    const now = new Date()
    const days = Math.round((atDayStart(now) - atDayStart(date)) / 86_400_000)
    if (days <= 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return 'Previous 7 days'
    if (days < 30) return 'Previous 30 days'
    return date.toLocaleDateString(
        undefined,
        date.getFullYear() === now.getFullYear()
            ? { month: 'long' }
            : { month: 'long', year: 'numeric' }
    )
}

function groupHistory(items: SessionListItem[]): Array<{ label: string; items: SessionListItem[] }> {
    const groups: Array<{ label: string; items: SessionListItem[] }> = []
    const indexes = new Map<string, number>()
    for (const item of items) {
        const label = dateBucketLabel(item.updatedAt)
        const known = indexes.get(label)
        if (known !== undefined) {
            groups[known].items.push(item)
            continue
        }
        indexes.set(label, groups.length)
        groups.push({ label, items: [item] })
    }
    return groups
}

/** Fast type/delete cycle for the active running row; static under reduced motion. */
function useTypewriter(text: string, animate: boolean): string {
    const [visible, setVisible] = useState(text)

    useEffect(() => {
        if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setVisible(text)
            return
        }
        let cancelled = false
        let length = 0
        let deleting = false
        let timer: ReturnType<typeof setTimeout> | null = null
        setVisible('')

        const tick = (): void => {
            if (cancelled) return
            if (!deleting) {
                length = Math.min(text.length, length + 1)
                setVisible(text.slice(0, length))
                if (length === text.length) {
                    deleting = true
                    timer = setTimeout(tick, 760)
                } else {
                    timer = setTimeout(tick, 18)
                }
                return
            }
            length = Math.max(0, length - 1)
            setVisible(text.slice(0, length))
            if (length === 0) {
                deleting = false
                timer = setTimeout(tick, 180)
            } else {
                timer = setTimeout(tick, 9)
            }
        }

        timer = setTimeout(tick, 80)
        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [animate, text])

    return visible
}

function ChatDescription({ text, animate }: { text: string; animate: boolean }): React.JSX.Element {
    const visible = useTypewriter(text, animate)
    return (
        <span className={`glass-history__item-description${animate ? ' glass-history__item-description--live' : ''}`} aria-label={text}>
            <span aria-hidden="true">{visible || '\u00a0'}</span>
        </span>
    )
}

function authLabel(status: GitHubAuthStatus | null): { primary: string; secondary: string } {
    if (!status) return { primary: 'GitHub account', secondary: 'Checking sign-in…' }
    if (status.state === 'signed-in' && status.user) {
        return {
            primary: status.user.name || `@${status.user.login}`,
            secondary: status.user.name ? `@${status.user.login}` : 'Connected with GitHub'
        }
    }
    if (status.state === 'authorizing') {
        return { primary: 'Finish GitHub sign-in', secondary: status.message ?? 'Waiting for approval…' }
    }
    if (status.state === 'unconfigured') {
        return { primary: 'GitHub login setup', secondary: 'Public client ID required' }
    }
    if (status.state === 'error') {
        return { primary: 'Try GitHub sign-in again', secondary: status.message ?? 'Connection failed' }
    }
    return { primary: 'Log in / sign up with GitHub', secondary: status.message ?? 'Sync your account securely' }
}

export function ChatSidebar({
    items,
    activeId,
    running,
    operatorMode,
    settingsOpen,
    onCollapse,
    onNewSession,
    onToggleOperator,
    onOpenSession,
    onChatContextMenu,
    onToggleSettings
}: ChatSidebarProps): React.JSX.Element {
    const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
    const [challenge, setChallenge] = useState<GitHubDeviceChallenge | null>(null)
    const [authBusy, setAuthBusy] = useState(false)
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        let mounted = true
        const apply = (status: GitHubAuthStatus): void => {
            if (!mounted) return
            setAuthStatus(status)
            if (status.state !== 'authorizing') setChallenge(null)
        }
        void window.glass.getGitHubAuthStatus().then(apply).catch(() => {
            apply({ state: 'error', message: 'GitHub sign-in status is unavailable.' })
        })
        const unsubscribe = window.glass.onGitHubAuthChanged(apply)
        return () => {
            mounted = false
            unsubscribe()
        }
    }, [])

    const beginGitHubLogin = useCallback(() => {
        if (authBusy || authStatus?.state === 'unconfigured') return
        setAuthBusy(true)
        setCopied(false)
        void window.glass
            .startGitHubLogin()
            .then((nextChallenge) => {
                setChallenge(nextChallenge)
                setAuthStatus({
                    state: 'authorizing',
                    message: 'Enter this code in the GitHub page opened in your browser.'
                })
            })
            .catch((error: unknown) => {
                setAuthStatus({
                    state: 'error',
                    message: error instanceof Error ? error.message : 'GitHub sign-in could not start.'
                })
            })
            .finally(() => setAuthBusy(false))
    }, [authBusy, authStatus?.state])

    const logout = useCallback(() => {
        setAuthBusy(true)
        void window.glass
            .logoutGitHub()
            .then(() => {
                setChallenge(null)
                setAuthStatus({ state: 'signed-out' })
            })
            .catch((error: unknown) => {
                setAuthStatus({
                    state: 'error',
                    message: error instanceof Error ? error.message : 'GitHub sign-out failed.'
                })
            })
            .finally(() => setAuthBusy(false))
    }, [])

    const copyCode = useCallback(() => {
        if (!challenge) return
        void navigator.clipboard
            .writeText(challenge.userCode)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
    }, [challenge])

    const account = authLabel(authStatus)
    const signedIn = authStatus?.state === 'signed-in'
    const authDisabled =
        authBusy ||
        authStatus?.state === 'unconfigured' ||
        authStatus?.state === 'authorizing' ||
        signedIn

    return (
        <aside className="glass-nav glass-nav--open" aria-label="Conversation sidebar">
            <div className="glass-nav__top">
                <button type="button" className="glass-nav__collapse" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar">
                    <SidebarCollapseIcon />
                </button>
            </div>

            <div className="glass-nav__primary">
                <button type="button" className="glass-nav__new" onClick={onNewSession}>
                    <NewChatIcon />
                    <span>{operatorMode ? 'New task' : 'New chat'}</span>
                </button>
                <button type="button" className={`glass-modebtn${operatorMode ? ' glass-modebtn--on' : ''}`} onClick={onToggleOperator} aria-pressed={operatorMode}>
                    <BrowserUseIcon />
                    <span>Computer or Browser Use</span>
                </button>
            </div>

            <div className="glass-nav__list">
                {items.length > 0 && groupHistory(items).map((group) => (
                    <div className="glass-history__group" key={group.label}>
                        <div className="glass-history__group-label">{group.label}</div>
                        {group.items.map((item) => {
                            const active = item.id === activeId
                            const isRunning = active && running
                            return (
                                <button
                                    type="button"
                                    key={item.id}
                                    className={`glass-history__item${active ? ' glass-history__item--selected' : ''}${isRunning ? ' glass-history__item--running' : ''}`}
                                    onClick={() => onOpenSession(item.id)}
                                    onContextMenu={(event) => onChatContextMenu(event, item.id)}
                                    aria-current={active ? 'page' : undefined}
                                >
                                    {isRunning && (
                                        <span className="glass-history__status">
                                            <span className="glass-history__running-dot" title="Task running" />
                                        </span>
                                    )}
                                    <span className="glass-history__text">
                                        <span className="glass-history__item-title">{item.title}</span>
                                        {isRunning && item.description && (
                                            <ChatDescription text={item.description} animate />
                                        )}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                ))}
            </div>

            <div className="glass-nav__footer">
                {challenge && authStatus?.state === 'authorizing' && (
                    <div className="glass-account-code" role="status">
                        <span>GitHub code</span>
                        <button type="button" onClick={copyCode} title="Copy GitHub verification code">
                            {challenge.userCode}
                        </button>
                        <span>{copied ? 'Copied' : 'Browser opened'}</span>
                    </div>
                )}
                <div className="glass-account">
                    <button
                        type="button"
                        className="glass-nav__footer-button glass-account__button"
                        onClick={beginGitHubLogin}
                        disabled={authDisabled}
                        title={authStatus?.message ?? account.primary}
                    >
                        <span className="glass-nav__footer-icon"><GitHubIcon /></span>
                        <span className="glass-nav__footer-copy">
                            <span>{account.primary}</span>
                            <span>{account.secondary}</span>
                        </span>
                    </button>
                    {signedIn && (
                        <button type="button" className="glass-account__logout" onClick={logout} disabled={authBusy}>
                            Log out
                        </button>
                    )}
                </div>
                <button
                    type="button"
                    className={`glass-nav__footer-button${settingsOpen ? ' glass-nav__footer-button--selected' : ''}`}
                    onClick={onToggleSettings}
                    aria-pressed={settingsOpen}
                >
                    <span className="glass-nav__footer-icon"><SettingsIcon /></span>
                    <span>Settings</span>
                </button>
            </div>
        </aside>
    )
}
