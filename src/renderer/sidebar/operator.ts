import type { Action } from '@op-shared/types'
import type { TrajectoryStepView, LoopState, TokenUsage } from '@op-shared/types'
import { estimateCostUsd, formatCostUsd, formatTokens, hasUsage } from '@op-shared/usage'

/**
 * Pure helpers for rendering merged Click Operator activity inside the Click
 * Copilot chat.
 *
 * The operator engine streams `TrajectoryStepView`s (one per perceive -> reason
 * -> act step) plus loop-state changes. These helpers turn that machine-facing
 * data into short, human-readable lines shown as assistant turns, so the
 * autonomous run reads like a running commentary in the existing conversation
 * view. Kept free of React/DOM so the formatting is unit-testable.
 */

/** A concise, human phrase for one Action_Space action. */
export function describeAction(action: Action): string {
    switch (action.kind) {
        case 'screenshot':
            return 'Took a screenshot'
        case 'mouse_move':
            return `Moved the cursor to (${Math.round(action.at.x)}, ${Math.round(action.at.y)})`
        case 'left_click':
            return `Clicked at (${Math.round(action.at.x)}, ${Math.round(action.at.y)})`
        case 'right_click':
            return `Right-clicked at (${Math.round(action.at.x)}, ${Math.round(action.at.y)})`
        case 'double_click':
            return `Double-clicked at (${Math.round(action.at.x)}, ${Math.round(action.at.y)})`
        case 'drag':
            return `Dragged from (${Math.round(action.from.x)}, ${Math.round(action.from.y)}) to (${Math.round(action.to.x)}, ${Math.round(action.to.y)})`
        case 'type':
            return `Typed "${action.text}"`
        case 'key':
            return `Pressed ${action.keys.join(' + ')}`
        case 'scroll':
            return `Scrolled (${action.dx}, ${action.dy})`
        case 'wait':
            return `Waited ${action.ms} ms`
        default:
            return 'Performed an action'
    }
}

/** A checklist row for one trajectory step: a concise label + optional reason. */
export interface StepItem {
    /** The concrete thing done / outcome (e.g. `Typed "youtube.com"`). */
    label: string
    /** The agent's short reason for this step (shown muted under the label). */
    sub?: string
    /** Observability note: tokens · cost · model for this step (shown muted). */
    meta?: string
    /** Outcome kind, so the UI can mark failures distinctly. */
    kind: TrajectoryStepView['outcome']
}

/**
 * Turn a trajectory step into a compact checklist row: the action (or terminal
 * outcome) as the label and the agent's rationale as the muted sub-line.
 */
export function describeStep(step: TrajectoryStepView): StepItem {
    const rationale = step.rationale.trim()
    const meta = formatStepUsage(step) ?? undefined
    if (step.outcome === 'action' && step.action) {
        let label = describeAction(step.action)
        if (step.result && step.result.status !== 'success') {
            const reason = step.result.reason ? `: ${step.result.reason}` : ''
            label += ` (${step.result.status}${reason})`
        }
        return { label, sub: rationale || undefined, meta, kind: 'action' }
    }
    if (step.outcome === 'completion') {
        return { label: 'Task complete', sub: rationale || undefined, meta, kind: 'completion' }
    }
    if (step.outcome === 'failure') {
        return { label: 'Could not complete the task', sub: rationale || undefined, meta, kind: 'failure' }
    }
    return { label: 'Needs your input', sub: rationale || undefined, meta, kind: 'help' }
}

/**
 * Render one trajectory step as a Markdown block for an assistant turn: the
 * agent's rationale, the action it took (or the terminal outcome), and any
 * failure reason from the result.
 */
export function formatTrajectoryStep(step: TrajectoryStepView): string {
    const lines: string[] = []
    const rationale = step.rationale.trim()
    if (rationale.length > 0) {
        lines.push(rationale)
    }

    if (step.outcome === 'action' && step.action) {
        let line = `**${describeAction(step.action)}**`
        if (step.result && step.result.status !== 'success') {
            const reason = step.result.reason ? `: ${step.result.reason}` : ''
            line += ` _(${step.result.status}${reason})_`
        }
        lines.push(line)
    } else if (step.outcome === 'completion') {
        lines.push('**Task complete.**')
    } else if (step.outcome === 'failure') {
        lines.push('**Could not complete the task.**')
    }

    const usage = formatStepUsage(step)
    if (usage) lines.push(`\`${usage}\``)

    return lines.join('\n\n')
}

/**
 * A compact observability note for one step: token count, estimated cost, and
 * the serving model — e.g. `1.2k tok · $0.0004 · gpt-4o-mini`. Returns null when
 * the step reported no token usage (nothing to show).
 */
export function formatStepUsage(step: TrajectoryStepView): string | null {
    if (!hasUsage(step.usage)) return null
    const parts: string[] = [`${formatTokens(step.usage.totalTokens)} tok`]
    const cost = formatCostUsd(estimateCostUsd(step.model, step.usage))
    if (cost) parts.push(cost)
    if (step.model) parts.push(step.model)
    return parts.join(' · ')
}

/**
 * A one-line session usage summary for the whole run — e.g.
 * `12.3k tokens · $0.01 across 8 steps`. Returns null when nothing was reported.
 */
export function formatSessionUsage(
    usageTotal: TokenUsage | undefined,
    stepCount: number,
    model?: string
): string | null {
    if (!hasUsage(usageTotal)) return null
    const parts: string[] = [`${formatTokens(usageTotal.totalTokens)} tokens`]
    const cost = formatCostUsd(estimateCostUsd(model, usageTotal))
    if (cost) parts.push(cost)
    return `${parts.join(' · ')} across ${stepCount} step${stepCount === 1 ? '' : 's'}`
}

/** Whether a loop state means the agent is actively working (drives the pending dots). */
export function isBusyState(state: LoopState): boolean {
    return state === 'perceiving' || state === 'reasoning' || state === 'acting'
}

/** Whether a loop state is terminal (the run has ended one way or another). */
export function isTerminalState(state: LoopState): boolean {
    return (
        state === 'stopped' ||
        state === 'completed' ||
        state === 'failed' ||
        state === 'budget-exhausted'
    )
}
