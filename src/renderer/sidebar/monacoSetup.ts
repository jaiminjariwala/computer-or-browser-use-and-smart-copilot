/// <reference types="vite/client" />
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

    /**
     * Local Monaco setup — no CDN.
     *
     * `@monaco-editor/react` loads Monaco from a CDN by default, which the app's CSP
     * and offline goal forbid. We instead point its loader at the bundled
     * `monaco-editor` package and wire the language web workers through Vite's
     * `?worker` imports so syntax coloring (and TS hovers) work fully on-device.
     * Imported once, for its side effects, before any editor mounts.
     */

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ; (self as any).MonacoEnvironment = {
        getWorker(_workerId: string, label: string): Worker {
            if (label === 'json') return new jsonWorker()
            if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
            if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
            if (label === 'typescript' || label === 'javascript') return new tsWorker()
            return new editorWorker()
        }
    }

loader.config({ monaco })

/** The name of the light theme defined to match the component-library editor. */
export const MONACO_THEME = 'copilot-light'

let themeDefined = false

/**
 * Define the light Monaco theme once (idempotent). Colors mirror the
 * component-library "component-library-light" theme: fuchsia keywords, green
 * strings, orange numbers, muted italic comments, teal types, red tags, blue
 * attributes — over a transparent background so the panel surface shows through.
 */
export function ensureCopilotTheme(monacoInstance: typeof monaco): void {
    if (themeDefined) return
    themeDefined = true
    monacoInstance.editor.defineTheme(MONACO_THEME, {
        base: 'vs',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '94A3B8', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'C026D3' },
            { token: 'string', foreground: '16A34A' },
            { token: 'number', foreground: 'EA580C' },
            { token: 'regexp', foreground: '0EA5E9' },
            { token: 'type.identifier', foreground: '0F766E' },
            { token: 'identifier', foreground: '0F172A' },
            { token: 'delimiter', foreground: '475569' },
            { token: 'delimiter.bracket', foreground: '334155' },
            { token: 'tag', foreground: 'DC2626' },
            { token: 'attribute.name', foreground: '2563EB' },
            { token: 'attribute.value', foreground: '16A34A' }
        ],
        colors: {
            'editor.background': '#00000000',
            'editorGutter.background': '#00000000',
            'editor.lineHighlightBackground': '#00000000',
            'editor.lineHighlightBorder': '#00000000',
            'editorLineNumber.foreground': '#cbd5e1',
            'editorLineNumber.activeForeground': '#64748b',
            'editor.foreground': '#0F172A',
            'editorCursor.foreground': '#111827',
            'editor.selectionBackground': '#1118271f',
            'editorBracketMatch.background': '#E0F2FE',
            'editorBracketMatch.border': '#7DD3FC',
            'scrollbar.shadow': '#00000000'
        }
    })
}
