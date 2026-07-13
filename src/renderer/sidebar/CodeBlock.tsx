import React from 'react'
import { normalizeLanguage } from './codeTheme'
import { useCodePanel } from './codePanelContext'

/**
 * A Claude-style code artifact pill shown inline in an assistant answer. It does
 * NOT render the code itself — clicking it opens the code in the right-hand
 * Monaco panel. (The newest artifact in a fresh answer is also opened
 * automatically; see the auto-open effect in App.)
 */
export function CodeArtifactPill({
    language,
    value
}: {
    language: string
    value: string
}): React.JSX.Element {
    const panel = useCodePanel()
    return (
        <button
            type="button"
            className="code-fab code-open-btn"
            onClick={() => panel?.open({ code: value, language })}
            title="Open code in the side panel"
        >
            Code
        </button>
    )
}

/**
 * react-markdown `code` renderer: fenced/multiline code becomes a
 * {@link CodeArtifactPill}; short inline code stays a simple `<code>` chip.
 */
export function CodeMarkdown({
    className,
    children
}: {
    className?: string
    children?: React.ReactNode
}): React.JSX.Element {
    const raw = String(children ?? '')
    const match = /language-([\w+#.-]+)/.exec(className ?? '')
    const isBlock = match != null || raw.includes('\n')
    if (!isBlock) {
        return <code className="glass-inline-code">{children}</code>
    }
    return <CodeArtifactPill language={normalizeLanguage(match?.[1])} value={raw.replace(/\n$/, '')} />
}


