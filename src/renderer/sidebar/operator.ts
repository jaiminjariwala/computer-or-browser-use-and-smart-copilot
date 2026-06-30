import type { Action } from '@op-shared/types'
import type { TrajectoryStepView, LoopState } from '@op-shared/types'

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
    /** Outcome kind, so the UI can mark failures distinctly. */
    kind: TrajectoryStepView['outcome']
}

/**
 * Turn a trajectory step into a compact checklist row: the action (or terminal
 * outcome) as the label and the agent's rationale as the muted sub-line.
 */
export function describeStep(step: TrajectoryStepView): StepItem {
    const rationale = step.rationale.trim()
    if (step.outcome === 'action' && step.action) {
        let label = describeAction(step.action)
        if (step.result && step.result.status !== 'success') {
            const reason = step.result.reason ? `: ${step.result.reason}` : ''
            label += ` (${step.result.status}${reason})`
        }
        return { label, sub: rationale || undefined, kind: 'action' }
    }
    if (step.outcome === 'completion') {
        return { label: 'Task complete', sub: rationale || undefined, kind: 'completion' }
    }
    if (step.outcome === 'failure') {
        return { label: 'Could not complete the task', sub: rationale || undefined, kind: 'failure' }
    }
    return { label: 'Needs your input', sub: rationale || undefined, kind: 'help' }
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

    return lines.join('\n\n')
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
