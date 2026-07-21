import { isAction, type Action, type ReasoningOutcome } from '@op-shared/types'

/**
 * Response parsing — one model response → EXACTLY ONE {@link ReasoningOutcome}
 * (Req 3.2, 3.4 / Properties 10, 11).
 *
 * Provider-agnostic and pure: concrete providers adapt their SDK/wire response
 * into {@link ReasoningResponseMessage} so this parser stays testable in-memory.
 * It is TOTAL — any input maps to exactly one outcome with one `kind` — and it
 * fails closed (`failure`) on anything it cannot turn into a valid Action,
 * completion, or help signal, so no bad Action ever executes.
 */

/** A single tool call extracted from a model response. */
export interface ParsedToolCall {
    name: string
    /** The raw JSON arguments string returned by the model. */
    arguments: string
}

/**
 * The minimal, provider-agnostic view of a model response consumed by
 * {@link parseReasoningResponse}. Concrete providers adapt their SDK response
 * into this shape so parsing stays pure and testable.
 */
export interface ReasoningResponseMessage {
    content?: string | null
    toolCalls?: ParsedToolCall[]
}

/** A best-effort `{ x, y }` point, or undefined when the value isn't a point. */
type MaybePoint = { x: number; y: number } | undefined

/**
 * Optional parse-time context supplied by the provider.
 *
 * `scrollAnchor` is the image-space point a coordinate-less `scroll` is
 * anchored at — the center of the screenshot the model was shown. Models
 * (Gemini 2.5 Flash among them) routinely emit page-level scrolls like
 * `{"action":"scroll","dy":400}` with no x/y; that is a perfectly executable
 * intent, and failing it closed burned steps and stalled real tasks. The
 * anchor keeps Action_Space itself strict (executors always get `at`).
 */
export interface ParseReasoningOptions {
    scrollAnchor?: { x: number; y: number }
}

/**
 * A finite number, or undefined. Also coerces a numeric STRING (e.g. `"1227"`)
 * to a number, because some OpenAI-compatible endpoints (notably Gemini) emit
 * function-call arguments with numeric fields serialized as strings; without
 * this the coordinate would be dropped and the whole Action would fail closed.
 */
function finite(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value)
        return Number.isFinite(n) ? n : undefined
    }
    return undefined
}

/**
 * Extract a coordinate point from tool args, tolerating the several encodings a
 * computer-use model emits (Req 27):
 *  - an `{ x, y }` object under the given field keys (e.g. `x`/`y`, `fromX`/`fromY`);
 *  - a two-element `[x, y]` array under any of `arrayKeys` (for example,
 *    `coordinate` / `start_coordinate`).
 * Returns undefined only when no accepted encoding yields two finite numbers, so
 * the caller can fail closed on a genuinely unmappable emission.
 */
function extractPoint(
    args: Record<string, unknown>,
    xKey: string,
    yKey: string,
    arrayKeys: readonly string[]
): MaybePoint {
    const x = finite(args[xKey])
    const y = finite(args[yKey])
    if (x !== undefined && y !== undefined) return { x, y }

    for (const key of arrayKeys) {
        const arr = args[key]
        if (Array.isArray(arr) && arr.length === 2) {
            const ax = finite(arr[0])
            const ay = finite(arr[1])
            if (ax !== undefined && ay !== undefined) return { x: ax, y: ay }
        }
    }
    return undefined
}

/** Pixels scrolled per unit of a direction/amount scroll. */
const SCROLL_UNIT_PX = 100

/** Normalize a `key` value to a string[] chord, accepting arrays or "ctrl+l" strings. */
function readKeys(args: Record<string, unknown>): string[] | undefined {
    if (Array.isArray(args.keys) && args.keys.every((k) => typeof k === 'string')) {
        return args.keys as string[]
    }
    // Some providers emit a single string like "ctrl+l" or "Return".
    const raw = args.keys ?? args.text ?? args.key
    if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw.trim().split(/[+\s]+/).filter(Boolean)
    }
    return undefined
}

/**
 * Read scroll deltas from `{dx,dy}`, `{scroll_direction, scroll_amount}`, or
 * the unprefixed `{direction, amount}` some models emit.
 */
function readScrollDelta(args: Record<string, unknown>): { dx: number; dy: number } | undefined {
    const dx = finite(args.dx)
    const dy = finite(args.dy)
    if (dx !== undefined || dy !== undefined) return { dx: dx ?? 0, dy: dy ?? 0 }

    const rawDir = args.scroll_direction ?? args.direction
    const dir = typeof rawDir === 'string' ? rawDir.toLowerCase() : ''
    if (dir) {
        const amount = finite(args.scroll_amount) ?? finite(args.amount) ?? 3
        const px = amount * SCROLL_UNIT_PX
        switch (dir) {
            case 'down':
                return { dx: 0, dy: px }
            case 'up':
                return { dx: 0, dy: -px }
            case 'right':
                return { dx: px, dy: 0 }
            case 'left':
                return { dx: -px, dy: 0 }
            default:
                return undefined
        }
    }
    return undefined
}

/**
 * Convert `computer` tool arguments into a typed {@link Action}, or null.
 *
 * Tolerant of the several shapes computer-use models emit (Req 27): coordinates
 * as `{x,y}` or `[x,y]`/`coordinate`; `key` as a string[] or a `"ctrl+l"` string;
 * `scroll` as `{dx,dy}` or `{scroll_direction, scroll_amount}`; `wait` as `ms` or
 * `duration` seconds. A few provider-specific aliases map onto our Action_Space
 * (`left_click_drag`→drag, `triple_click`→double_click, `middle_click`→left_click,
 * `cursor_position`→screenshot). Fails closed only when no mapping is valid.
 */
function toolArgsToAction(args: Record<string, unknown>, opts?: ParseReasoningOptions): Action | null {
    const rawKind = args.action
    if (typeof rawKind !== 'string') return null

    // Normalize native + common alternate names onto our Action_Space kinds.
    // Some providers emit `triple_click`/`middle_click`/`cursor_position`/
    // `left_click_drag`; others sometimes emit shorter names like
    // `click`, `move`, `press`, `type_text`. Map them all onto the fixed space.
    const ALIASES: Record<string, string> = {
        triple_click: 'double_click',
        middle_click: 'left_click',
        cursor_position: 'screenshot',
        left_click_drag: 'drag',
        click: 'left_click',
        leftclick: 'left_click',
        left: 'left_click',
        tap: 'left_click',
        rightclick: 'right_click',
        right: 'right_click',
        doubleclick: 'double_click',
        double: 'double_click',
        move: 'mouse_move',
        mousemove: 'mouse_move',
        hover: 'mouse_move',
        type_text: 'type',
        input: 'type',
        input_text: 'type',
        write: 'type',
        press: 'key',
        keypress: 'key',
        key_press: 'key',
        hotkey: 'key',
        capture: 'screenshot',
        sleep: 'wait',
        pause: 'wait'
    }
    const kind = ALIASES[rawKind] ?? rawKind

    let candidate: unknown
    switch (kind) {
        case 'screenshot':
            candidate = { kind }
            break
        case 'mouse_move':
        case 'left_click':
        case 'right_click':
        case 'double_click':
            candidate = { kind, at: extractPoint(args, 'x', 'y', ['coordinate']) }
            break
        case 'drag':
            candidate = {
                kind,
                from: extractPoint(args, 'fromX', 'fromY', ['start_coordinate', 'from']),
                to: extractPoint(args, 'toX', 'toY', ['coordinate', 'to'])
            }
            break
        case 'type':
            candidate = { kind, text: args.text }
            break
        case 'key': {
            const keys = readKeys(args)
            candidate = keys ? { kind, keys } : null
            break
        }
        case 'scroll': {
            const delta = readScrollDelta(args)
            // A scroll without coordinates means "scroll the page" — anchor it
            // at the provider-supplied screenshot center instead of failing.
            const at = extractPoint(args, 'x', 'y', ['coordinate']) ?? opts?.scrollAnchor
            candidate = delta ? { kind, at, dx: delta.dx, dy: delta.dy } : null
            break
        }
        case 'wait': {
            // Require an explicit ms or duration; a bare `wait` is underspecified
            // and fails closed (keeps Property 11 honest).
            const durationSec = finite(args.duration)
            const ms = finite(args.ms) ?? (durationSec !== undefined ? durationSec * 1000 : undefined)
            candidate = ms !== undefined ? { kind, ms } : null
            break
        }
        default:
            return null
    }

    // Fail closed: only accept a fully well-formed Action_Space member (Req 27.4).
    return isAction(candidate) ? candidate : null
}

/**
 * Parse a model response into EXACTLY ONE {@link ReasoningOutcome}:
 *  - a single `computer` tool call whose args validate against the Action_Space
 *    → `{ kind: 'action' }` (+ rationale);
 *  - a single `task_complete` tool call → `{ kind: 'completion' }`;
 *  - a single `request_help` tool call → `{ kind: 'help' }`;
 *  - ANYTHING else — no tool call, unknown tool, malformed args, an invalid
 *    Action, or multiple/conflicting tool calls — → `{ kind: 'failure' }`
 *    (fail closed; no Action executes, Req 3.4).
 *
 * This function is total: for any input it returns one outcome with one `kind`.
 */
export function parseReasoningResponse(
    message: ReasoningResponseMessage,
    opts?: ParseReasoningOptions
): ReasoningOutcome {
    const toolCalls = message.toolCalls ?? []

    if (toolCalls.length === 0) {
        return { kind: 'failure', reason: 'No tool call in response; expected computer, task_complete, or request_help.' }
    }

    // Some models (and OpenRouter's free router) emit multiple/parallel tool
    // calls in one turn. Rather than fail the whole step, act on the first
    // RECOGNIZED call, preferring an actionable `computer` call, then the
    // terminal signals. This keeps one Action per step (Req 3.2) while
    // tolerating chatty models. Only a wholly unknown set falls through.
    const KNOWN_TOOLS = new Set(['computer', 'task_complete', 'request_help'])
    const call =
        toolCalls.find((c) => c.name === 'computer') ??
        toolCalls.find((c) => KNOWN_TOOLS.has(c.name)) ??
        toolCalls[0]
    let args: Record<string, unknown>
    try {
        const parsed = JSON.parse(call.arguments.trim().length > 0 ? call.arguments : '{}')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { kind: 'failure', reason: 'Tool arguments were not a JSON object.' }
        }
        args = parsed as Record<string, unknown>
    } catch {
        return { kind: 'failure', reason: 'Tool arguments were not valid JSON.' }
    }

    switch (call.name) {
        case 'computer': {
            const action = toolArgsToAction(args, opts)
            if (!action) {
                // Include a compact echo of what the model sent so an unmappable
                // emission is diagnosable instead of an opaque failure.
                let echo = ''
                try {
                    echo = ` Received: ${JSON.stringify(args).slice(0, 300)}`
                } catch {
                    echo = ''
                }
                return {
                    kind: 'failure',
                    reason: `computer tool arguments were not a valid Action_Space action.${echo}`
                }
            }
            const rationale =
                typeof args.rationale === 'string' && args.rationale.trim().length > 0
                    ? args.rationale.trim()
                    : typeof message.content === 'string' && message.content.trim().length > 0
                        ? message.content.trim()
                        : ''
            return { kind: 'action', action, rationale }
        }
        case 'task_complete': {
            const summary =
                typeof args.summary === 'string' && args.summary.trim().length > 0
                    ? args.summary.trim()
                    : 'Task complete.'
            const evidence =
                typeof args.evidence === 'string' && args.evidence.trim().length > 0
                    ? args.evidence.trim()
                    : undefined
            return evidence
                ? { kind: 'completion', summary, evidence }
                : { kind: 'completion', summary }
        }
        case 'request_help': {
            const question =
                typeof args.question === 'string' && args.question.trim().length > 0
                    ? args.question.trim()
                    : 'The operator requested help.'
            return { kind: 'help', question }
        }
        default:
            return { kind: 'failure', reason: `Unknown tool "${call.name}".` }
    }
}
