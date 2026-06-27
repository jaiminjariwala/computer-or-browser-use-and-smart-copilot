import type {
    ChatCompletionMessageParam,
    ChatCompletionContentPart
} from 'openai/resources/chat/completions'
import type {
    Action,
    Observation,
    ReasoningContext,
    TrajectoryStep,
    TrajectorySummary
} from '@op-shared/types'
import { OPERATOR_SYSTEM_PROMPT } from './system-prompt'

/**
 * Bounded context assembly + OpenAI-shaped message rendering (Req 3.5, 4.3).
 *
 * Everything here is pure and deterministic so Property 12 (and the request
 * shape) can be exercised in-memory without a gateway.
 */

/**
 * Maximum number of most-recent Trajectory steps included verbatim in a
 * {@link ReasoningContext}. Older steps live only in the {@link TrajectorySummary};
 * the full step-by-step Trajectory is never replayed (Req 3.5, 4.3). This is the
 * K validated by Property 12.
 */
export const RECENT_STEPS_LIMIT = 8

/**
 * Assemble a bounded {@link ReasoningContext} from the full session state. The
 * result carries the {@link TrajectorySummary} plus AT MOST `limit`
 * most-recent Trajectory steps (the suffix of the trajectory); it NEVER
 * includes the complete step-by-step Trajectory (Req 3.5, 4.3). This is the
 * pure core validated by Property 12.
 */
export function assembleReasoningContext(
    goal: string,
    summary: TrajectorySummary,
    trajectory: readonly TrajectoryStep[],
    currentObservation: Observation,
    limit: number = RECENT_STEPS_LIMIT
): ReasoningContext {
    const k = Math.max(0, Math.floor(limit))
    const recentSteps = k === 0 ? [] : trajectory.slice(Math.max(0, trajectory.length - k))
    return { goal, summary, recentSteps: [...recentSteps], currentObservation }
}

function textPart(text: string): ChatCompletionContentPart {
    return { type: 'text', text }
}

function imagePart(dataUrl: string): ChatCompletionContentPart {
    return { type: 'image_url', image_url: { url: dataUrl } }
}

/** Render the progress summary (goal + inferred progress + completed sub-steps). */
export function formatProgress(summary: TrajectorySummary): string {
    const progress = summary.inferredProgress.trim()
    const steps = summary.completedSubSteps.filter((s) => s.trim().length > 0)
    const progressLine = progress.length > 0 ? progress : '(no progress yet)'
    const stepsLine = steps.length > 0 ? steps.map((s) => `- ${s}`).join('\n') : '(none yet)'
    return `Progress summary: ${progressLine}\nCompleted sub-steps:\n${stepsLine}`
}

/** Compactly render one recent Trajectory step (Action + result + rationale). */
export function renderRecentStep(step: TrajectoryStep): string {
    const parts: string[] = [`#${step.index}`]
    if (step.action) {
        parts.push(`action=${describeAction(step.action)}`)
    } else {
        parts.push(`outcome=${step.reasoning.outcome}`)
    }
    if (step.result) {
        parts.push(`result=${step.result.status}${step.result.reason ? `(${step.result.reason})` : ''}`)
    }
    const rationale = step.reasoning.rationale.trim()
    if (rationale.length > 0) parts.push(`rationale="${rationale}"`)
    return parts.join(' ')
}

/** A short human-readable description of an Action + its parameters. */
export function describeAction(action: Action): string {
    switch (action.kind) {
        case 'screenshot':
            return 'screenshot'
        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click':
            return `${action.kind}(${action.at.x},${action.at.y})`
        case 'drag':
            return `drag(${action.from.x},${action.from.y}->${action.to.x},${action.to.y})`
        case 'type':
            return `type("${action.text}")`
        case 'key':
            return `key(${action.keys.join('+')})`
        case 'scroll':
            return `scroll(${action.at.x},${action.at.y},d=${action.dx},${action.dy})`
        case 'wait':
            return `wait(${action.ms}ms)`
    }
}

/** The coordinate metadata attached to the current-Observation user message. */
export function formatObservationMetadata(observation: Observation): string {
    const lines: string[] = [
        'Current screen observation:',
        `- image size: ${observation.imageWidth}x${observation.imageHeight} px`,
        `- displayId: ${observation.displayId}`
    ]
    if (observation.displayBounds) {
        const b = observation.displayBounds
        lines.push(`- display bounds (logical points): x=${b.x} y=${b.y} w=${b.width} h=${b.height}`)
    } else {
        lines.push('- display bounds: unknown')
    }
    lines.push(
        `- scaleFactor: ${observation.scaleFactor ?? 'unknown'}`,
        `- observation complete: ${observation.complete}`,
        'Give coordinates in the image space above.'
    )
    // DOM-based environments provide a readable text digest of the page so the
    // agent can read CONTENT (prices, results, headings) without an image.
    if (observation.pageText && observation.pageText.trim().length > 0) {
        lines.push('', 'Page text (what is visible on the page):', observation.pageText.trim())
    }
    // Hybrid perception: when the environment provides the page's interactive
    // elements with their click coordinates, list them so the agent can act on
    // this structured text instead of visually hunting (fewer vision tokens).
    if (observation.a11yElements && observation.a11yElements.length > 0) {
        lines.push(
            '',
            'Interactive elements on the page (click at the given x,y):'
        )
        for (const el of observation.a11yElements) {
            const b = el.bounds
            if (!b) continue
            const cx = Math.round(b.x + b.width / 2)
            const cy = Math.round(b.y + b.height / 2)
            const label = (el.title ?? el.role).slice(0, 80)
            lines.push(`- "${label}" at (${cx}, ${cy})`)
        }
    }
    return lines.join('\n')
}

/**
 * Assemble the full OpenAI-compatible message list for one Reasoning_Step:
 *  1. `system` — operator behavior + safety contract.
 *  2. `system` — `Goal:` + progress summary (goal + completed sub-steps).
 *  3. `system` — the most-recent K steps rendered compactly (older steps live
 *     only in the summary; the full Trajectory is never replayed).
 *  4. `user`   — the current Observation: coordinate metadata text + the
 *     screenshot as an `image_url` content part.
 *
 * Pure and deterministic so it can be unit-tested without a gateway.
 */
export function buildReasoningMessages(
    ctx: ReasoningContext,
    systemPrompt: string = OPERATOR_SYSTEM_PROMPT
): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `Goal: ${ctx.goal}\n${formatProgress(ctx.summary)}` }
    ]

    if (ctx.recentSteps.length > 0) {
        const recent = ctx.recentSteps.map(renderRecentStep).join('\n')
        messages.push({ role: 'system', content: `Recent steps (oldest first):\n${recent}` })
    }

    const obs = ctx.currentObservation
    const userParts: ChatCompletionContentPart[] = [textPart(formatObservationMetadata(obs))]
    if (obs.screenshotDataUrl.trim().length > 0) {
        userParts.push(imagePart(obs.screenshotDataUrl))
    }
    messages.push({ role: 'user', content: userParts })

    return messages
}
