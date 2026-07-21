import type { Action } from '@op-shared/types'
import type { TrajectoryStepView, LoopState, TokenUsage } from '@op-shared/types'
import { estimateCostUsd, formatCostUsd, formatTokens, hasUsage } from '@op-shared/usage'
import { redactSensitiveText } from './privacy'

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

/** A concise, privacy-aware phrase for one Action_Space action. */
export function describeAction(action: Action): string {
    switch (action.kind) {
        case 'screenshot':
            return 'Checked the current screen'
        case 'mouse_move':
            return 'Moved the cursor to the intended control'
        case 'left_click':
            return 'Clicked the intended control'
        case 'right_click':
            return 'Opened the control’s context menu'
        case 'double_click':
            return 'Opened the intended item'
        case 'drag':
            return 'Dragged the intended item to its destination'
        case 'type':
            // Typed content may contain credentials or personal information; the
            // activity timeline records the operation, never the value.
            return 'Entered text in the active field'
        case 'key':
            return describeKeyAction(action.keys)
        case 'scroll':
            return action.dy < 0 ? 'Scrolled up to inspect more content' : 'Scrolled down to inspect more content'
        case 'wait':
            return 'Waited for the interface to update'
        default:
            return 'Performed an action'
    }
}

/**
 * Describe the concrete action a user is being asked to approve. Unlike the
 * durable activity label, this exposes the exact key chord. Typed values stay
 * hidden, but their length is shown so text entry is distinguishable and useful
 * for review without echoing credentials or personal data.
 */
export function describeConfirmationAction(action: Action): string {
    switch (action.kind) {
        case 'key': {
            const chord = action.keys.map(confirmationKeyLabel).join(' + ')
            return chord.length > 0
                ? `Press keyboard shortcut: ${chord}`
                : 'Press an unspecified keyboard shortcut'
        }
        case 'type': {
            const characters = [...action.text].length
            return (
                `Enter ${characters} character${characters === 1 ? '' : 's'} in the active field ` +
                '(value hidden for privacy)'
            )
        }
        case 'screenshot':
            return 'Capture the current screen'
        case 'mouse_move':
            return `Move the cursor to ${formatPoint(action.at)}`
        case 'left_click':
            return `Left-click at ${formatPoint(action.at)}`
        case 'right_click':
            return `Right-click at ${formatPoint(action.at)}`
        case 'double_click':
            return `Double-click at ${formatPoint(action.at)}`
        case 'drag':
            return `Drag from ${formatPoint(action.from)} to ${formatPoint(action.to)}`
        case 'scroll':
            return (
                `Scroll by Δx ${formatNumber(action.dx)}, Δy ${formatNumber(action.dy)} ` +
                `at ${formatPoint(action.at)}`
            )
        case 'wait':
            return `Wait ${formatNumber(action.ms)} ms`
        default:
            return 'Perform the requested action'
    }
}

function formatPoint(point: { x: number; y: number }): string {
    return `(${formatNumber(point.x)}, ${formatNumber(point.y)})`
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return 'invalid'
    return Object.is(value, -0) ? '0' : String(value)
}

function confirmationKeyLabel(value: string): string {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, '').trim().slice(0, 32)
    const aliases: Record<string, string> = {
        cmd: 'Cmd',
        command: 'Cmd',
        meta: 'Cmd',
        ctrl: 'Ctrl',
        control: 'Ctrl',
        alt: 'Option',
        option: 'Option',
        shift: 'Shift',
        enter: 'Enter',
        return: 'Enter',
        escape: 'Esc',
        esc: 'Esc',
        tab: 'Tab',
        space: 'Space',
        backspace: 'Backspace',
        delete: 'Delete'
    }
    return aliases[normalized.toLocaleLowerCase()] ?? normalized.toLocaleUpperCase()
}

function describeKeyAction(keys: readonly string[]): string {
    const normalized = new Set(keys.map((key) => key.trim().toLowerCase()))
    const primary =
        normalized.has('cmd') ||
        normalized.has('command') ||
        normalized.has('meta') ||
        normalized.has('ctrl') ||
        normalized.has('control')
    if (primary && normalized.has('t')) return 'Opened a new browser tab'
    if (primary && normalized.has('w')) return 'Closed the active browser tab'
    if (
        primary &&
        (normalized.has('tab') ||
            normalized.has('[') ||
            normalized.has(']') ||
            normalized.has('pageup') ||
            normalized.has('pagedown'))
    ) {
        return 'Switched browser tabs'
    }
    if (primary && [...normalized].some((key) => /^[1-9]$/.test(key))) {
        return 'Selected a browser tab'
    }
    return 'Pressed a keyboard shortcut'
}

/** A checklist row for one trajectory step: a concise label + optional reason. */
export interface StepItem {
    /** The concrete thing done / outcome. Sensitive values are never included. */
    label: string
    /** The agent's short reason or an execution failure explanation. */
    sub?: string
    /** Execution mode plus tokens · cost · model (shown muted). */
    meta?: string
    /** Outcome kind, so terminal failures render distinctly. */
    kind: TrajectoryStepView['outcome']
    /** Attempt status, so blocked/failed Actions do not render with a success tick. */
    status?: 'success' | 'failure' | 'blocked' | 'rejected'
}

/**
 * Turn a trajectory step into a compact checklist row: the action (or terminal
 * outcome) as the label and the agent's rationale as the muted sub-line.
 */
export function describeStep(step: TrajectoryStepView): StepItem {
    const meta = formatStepUsage(step) ?? undefined
    if (step.outcome === 'action' && step.action) {
        const action = describeAction(step.action)
        const status = step.result?.status
        const failed = status !== undefined && status !== 'success'
        return {
            label: failed ? `Could not complete: ${lowercaseFirst(action)}` : action,
            sub: failed ? failureCategory(status) : undefined,
            meta,
            kind: 'action',
            status
        }
    }
    if (step.outcome === 'completion') {
        return { label: 'Task complete', meta, kind: 'completion' }
    }
    if (step.outcome === 'failure') {
        // A completion claim bounced by the evidence gate is progress-shaped
        // feedback, not an inscrutable failure — say what actually happened.
        const unverified = step.rationale?.startsWith('completion-unverified:')
        // Rate limits are an account/quota condition, not a reasoning bug;
        // hiding them behind generic copy sent users down the wrong path.
        const rateLimited = /\b429\b|rate.?limit|too many requests|quota/i.test(step.rationale ?? '')
        return {
            label: unverified
                ? 'Rejected a premature "task complete"'
                : rateLimited
                    ? 'Model provider rate-limited the request'
                    : 'Could not complete the task',
            sub: unverified
                ? 'The claim had no matching on-screen evidence; the agent keeps working.'
                : rateLimited
                    ? 'Free-tier quota hit (HTTP 429). Wait a bit, or switch to a model with spare quota.'
                    : 'Reasoning did not produce a usable next step.',
            meta,
            kind: 'failure',
            status: 'failure'
        }
    }
    return {
        label: 'Needs your input',
        sub: sanitizeHelpText(step.rationale),
        meta,
        kind: 'help'
    }
}

function failureCategory(status: StepItem['status']): string {
    switch (status) {
        case 'blocked':
            return 'Blocked by a safety check.'
        case 'rejected':
            return 'Rejected because the action was not valid.'
        default:
            return 'The action failed; the agent will reassess.'
    }
}

/** Help questions must be visible, but obvious secrets and identifiers are removed. */
export function sanitizeHelpText(value: string): string | undefined {
    const safe = redactSensitiveText(value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (safe.length === 0) return undefined
    return safe.length <= 180 ? safe : `${safe.slice(0, 179).trimEnd()}…`
}

function lowercaseFirst(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toLocaleLowerCase() + value.slice(1)
}

/**
 * Render one trajectory step as a Markdown block for an assistant turn: the
 * agent's rationale, the action it took (or the terminal outcome), and any
 * failure reason from the result.
 */
export function formatTrajectoryStep(step: TrajectoryStepView): string {
    const lines: string[] = []

    if (step.outcome === 'action' && step.action) {
        let line = `**${describeAction(step.action)}**`
        if (step.result && step.result.status !== 'success') {
            line += ` _(${step.result.status}: ${failureCategory(step.result.status)})_`
        }
        lines.push(line)
    } else if (step.outcome === 'completion') {
        lines.push('**Task complete.**')
    } else if (step.outcome === 'failure') {
        lines.push('**Could not complete the task.**')
    } else if (step.outcome === 'help') {
        const question = sanitizeHelpText(step.rationale)
        if (question) lines.push(question)
        lines.push('**Needs your input.**')
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
    const parts: string[] = []
    if (step.result?.mode) parts.push(step.result.mode === 'api' ? 'DOM/API' : 'Vision')
    if (hasUsage(step.usage)) {
        parts.push(`${formatTokens(step.usage.totalTokens)} tok`)
        const cost = formatCostUsd(estimateCostUsd(step.model, step.usage))
        if (cost) parts.push(cost)
        if (step.model) parts.push(step.model)
    }
    return parts.length > 0 ? parts.join(' · ') : null
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
