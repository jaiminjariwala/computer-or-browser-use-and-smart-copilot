import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionSummary, TurnView } from '@shared/types'
import { CodeMarkdown } from './CodeBlock'

/** Presentation of individual chat turns and the running goal tracker. */

/** Markdown component overrides: render fenced code with the rich CodeBlock. */
const MARKDOWN_COMPONENTS = {
    code: CodeMarkdown,
    // Our CodeBlock provides its own container, so drop the default <pre> wrapper.
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}

/** Render assistant text as Markdown; user text stays plain. */
export function TurnBody({ turn }: { turn: TurnView }): React.JSX.Element {
    if (turn.role === 'assistant') {
        return (
            <div className="glass-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                    {turn.text ?? ''}
                </ReactMarkdown>
            </div>
        )
    }
    return <>{turn.text}</>
}

/** Compact goal/step tracker — surfaces the running session summary. */
export function GoalTracker({ summary }: { summary: SessionSummary }): React.JSX.Element | null {
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
