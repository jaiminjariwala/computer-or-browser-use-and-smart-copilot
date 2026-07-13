/**
 * Language helpers + code-block extraction for the copilot code viewer.
 *
 * The right-hand panel renders code with Monaco (see {@link ./CodePanel}); these
 * pure helpers map a fenced-code language token to a Monaco language id, produce
 * a short pill label, and pull fenced code blocks out of an assistant answer so
 * they can be shown as pills / opened in the panel.
 */

/** A fenced code block pulled from a Markdown answer. */
export interface ExtractedCode {
    language: string
    code: string
}

/** Normalize a fenced-code language token to a canonical id (maps aliases). */
export function normalizeLanguage(lang: string | undefined): string {
    const id = (lang ?? '').trim().toLowerCase()
    const aliases: Record<string, string> = {
        js: 'javascript',
        node: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        ts: 'typescript',
        py: 'python',
        py3: 'python',
        sh: 'bash',
        shell: 'bash',
        zsh: 'bash',
        console: 'bash',
        htm: 'html',
        xml: 'html',
        yml: 'yaml',
        'c++': 'cpp',
        cc: 'cpp',
        rb: 'ruby',
        golang: 'go',
        rs: 'rust',
        kt: 'kotlin',
        plaintext: 'text',
        txt: 'text'
    }
    return aliases[id] ?? id ?? 'text'
}

/** Map a normalized language to the Monaco language id used by the editor. */
export function monacoLanguage(lang: string): string {
    const id = normalizeLanguage(lang)
    const map: Record<string, string> = {
        bash: 'shell',
        text: 'plaintext',
        '': 'plaintext'
    }
    return map[id] ?? id
}

/** A short, human label for the language pill (e.g. `js`, `ts`, `py`). */
export function languageLabel(lang: string): string {
    const id = normalizeLanguage(lang)
    const labels: Record<string, string> = {
        javascript: 'js',
        typescript: 'ts',
        python: 'py',
        bash: 'sh',
        text: 'text'
    }
    return labels[id] ?? id
}

/**
 * Extract fenced code blocks (```lang ... ```) from a Markdown string, in order.
 * Used to turn the code in an assistant answer into artifacts (pills + panel).
 */
export function extractCodeBlocks(markdown: string): ExtractedCode[] {
    const blocks: ExtractedCode[] = []
    const fence = /```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g
    let m: RegExpExecArray | null
    while ((m = fence.exec(markdown)) !== null) {
        const language = m[1] || 'text'
        const code = m[2].replace(/\n$/, '')
        if (code.trim().length > 0) blocks.push({ language, code })
    }
    return blocks
}
