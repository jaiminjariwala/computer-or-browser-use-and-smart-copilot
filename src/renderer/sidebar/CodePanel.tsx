import React, { useCallback, useEffect, useState } from 'react'
import Editor, { type BeforeMount } from '@monaco-editor/react'
import { MONACO_THEME, ensureCopilotTheme } from './monacoSetup'
import { languageLabel, monacoLanguage } from './codeTheme'
import type { CodeArtifact } from './codePanelContext'

/**
 * The Claude-style right-hand code panel, backed by Monaco and styled to match
 * the component-library CodeModal: language pill(s) floating at the top-left and
 * text-only "Copy" / close pill buttons at the top-right, over a read-only
 * Monaco editor using the light "copilot-light" theme.
 */
export function CodePanel({
    artifact,
    onClose,
    width,
    onResize
}: {
    artifact: CodeArtifact
    onClose: () => void
    /** Current panel width in px. */
    width: number
    /** Called with a new width while the user drags the left edge. */
    onResize: (width: number) => void
}): React.JSX.Element {
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        setCopied(false)
    }, [artifact])

    // Drag the left edge to resize the panel width. Clamped so both the chat and
    // the panel stay usable.
    const startResize = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault()
            const onMove = (ev: PointerEvent): void => {
                const next = window.innerWidth - ev.clientX
                const max = Math.max(360, window.innerWidth - 360)
                onResize(Math.min(max, Math.max(320, next)))
            }
            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
            }
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
        },
        [onResize]
    )

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const onCopy = useCallback(() => {
        void navigator.clipboard.writeText(artifact.code).then(
            () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
            },
            () => undefined
        )
    }, [artifact.code])

    const beforeMount: BeforeMount = (monaco) => {
        ensureCopilotTheme(monaco)
        const diag = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diag)
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diag)
    }

    return (
        <aside
            className="code-panel"
            aria-label="Code viewer"
            style={{ flex: '0 0 auto', width: `${width}px` }}
        >
            {/* Drag handle on the left edge to resize the panel width. */}
            <div
                className="code-panel__resizer"
                onPointerDown={startResize}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize code panel"
            />
            {/* Floating language pill(s), top-left. */}
            <div className="code-pills">
                <span className="code-pill">{languageLabel(artifact.language)}</span>
                {artifact.title && <span className="code-pill">{artifact.title}</span>}
            </div>

            {/* Floating text-only buttons, top-right. */}
            <div className="code-fabs">
                <button type="button" className="code-fab" onClick={onCopy}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                    type="button"
                    className="code-fab"
                    onClick={onClose}
                    aria-label="Close code panel"
                    title="Close"
                >
                    Close
                </button>
            </div>

            <div className="code-panel__body">
                <Editor
                    key={artifact.language + '-' + artifact.code.length}
                    height="100%"
                    theme={MONACO_THEME}
                    language={monacoLanguage(artifact.language)}
                    value={artifact.code}
                    beforeMount={beforeMount}
                    loading={<div className="code-panel__loading">Loading editor…</div>}
                    options={{
                        readOnly: true,
                        domReadOnly: true,
                        automaticLayout: true,
                        minimap: { enabled: false },
                        lineNumbers: 'on',
                        lineNumbersMinChars: 3,
                        glyphMargin: false,
                        folding: false,
                        renderLineHighlight: 'none',
                        scrollBeyondLastLine: false,
                        overviewRulerBorder: false,
                        hideCursorInOverviewRuler: true,
                        fontFamily:
                            '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
                        fontSize: 14,
                        lineHeight: 26,
                        wordWrap: 'off',
                        tabSize: 2,
                        stickyScroll: { enabled: false },
                        // Top padding clears the floating pill/buttons toolbar.
                        padding: { top: 64, bottom: 28 },
                        smoothScrolling: true,
                        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                        contextmenu: false
                    }}
                />
            </div>
        </aside>
    )
}
