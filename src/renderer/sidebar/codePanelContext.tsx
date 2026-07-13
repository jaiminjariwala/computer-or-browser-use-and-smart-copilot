import { createContext, useContext } from 'react'

/** A code artifact shown in the right-hand panel (Claude-style). */
export interface CodeArtifact {
    code: string
    language: string
    /** Optional title/filename shown in the panel header. */
    title?: string
}

export interface CodePanelApi {
    /** Open the given code in the right-hand panel. */
    open: (artifact: CodeArtifact) => void
}

/**
 * Lets a deeply-nested code block (rendered inside assistant Markdown) ask the
 * app to open its code in the right-hand panel, without threading a callback
 * through every layer. Null when no provider is mounted (block still renders).
 */
export const CodePanelContext = createContext<CodePanelApi | null>(null)

export function useCodePanel(): CodePanelApi | null {
    return useContext(CodePanelContext)
}
