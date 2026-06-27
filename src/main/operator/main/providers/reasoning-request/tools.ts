import type { ChatCompletionTool } from 'openai/resources/chat/completions'

/**
 * The `computer` / `task_complete` / `request_help` tool schemas offered on
 * every Reasoning_Step (Req 3.1, 3.2).
 *
 * The request shape is identical across providers; only transport differs.
 */

/** The Action_Space kinds exposed to the model on the `computer` tool. */
const COMPUTER_ACTION_KINDS = [
    'screenshot',
    'mouse_move',
    'left_click',
    'right_click',
    'double_click',
    'drag',
    'type',
    'key',
    'scroll',
    'wait'
] as const

/**
 * A single function tool `computer` whose `action` is a discriminated enum over
 * the Action_Space, with per-kind parameters (coordinates, text, keys, scroll
 * deltas, wait ms). Coordinates are flat top-level `x`/`y` (and `fromX/Y`,
 * `toX/Y` for drag) so any OpenAI-compatible endpoint can express them.
 */
export const COMPUTER_TOOL: ChatCompletionTool = {
    type: 'function',
    function: {
        name: 'computer',
        description:
            'Perform exactly one low-level computer input action from the fixed Action_Space. Use this to move the mouse, click, drag, type, press keys, scroll, wait, or request a fresh screenshot.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: {
                    type: 'string',
                    enum: [...COMPUTER_ACTION_KINDS],
                    description: 'The kind of input action to perform.'
                },
                rationale: {
                    type: 'string',
                    description: 'A short, concrete reason for choosing this action now.'
                },
                x: { type: 'number', description: 'Image-space X for mouse_move/click/scroll.' },
                y: { type: 'number', description: 'Image-space Y for mouse_move/click/scroll.' },
                fromX: { type: 'number', description: 'Drag start X (image space).' },
                fromY: { type: 'number', description: 'Drag start Y (image space).' },
                toX: { type: 'number', description: 'Drag end X (image space).' },
                toY: { type: 'number', description: 'Drag end Y (image space).' },
                text: { type: 'string', description: 'Text to type for the `type` action.' },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Key chord for the `key` action, e.g. ["cmd","c"].'
                },
                dx: { type: 'number', description: 'Horizontal scroll delta for `scroll`.' },
                dy: { type: 'number', description: 'Vertical scroll delta for `scroll`.' },
                ms: { type: 'number', description: 'Milliseconds to wait for the `wait` action.' }
            },
            required: ['action']
        }
    }
}

/** A zero-risk tool signaling the Goal is complete (maps to a completion outcome). */
export const TASK_COMPLETE_TOOL: ChatCompletionTool = {
    type: 'function',
    function: {
        name: 'task_complete',
        description: 'Signal that the Goal has been accomplished. Call this instead of `computer` when no further action is needed.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                summary: {
                    type: 'string',
                    description: 'A short summary of what was accomplished.'
                }
            },
            required: ['summary']
        }
    }
}

/** A zero-risk tool signaling the operator needs the user (maps to a help outcome). */
export const REQUEST_HELP_TOOL: ChatCompletionTool = {
    type: 'function',
    function: {
        name: 'request_help',
        description: 'Ask the user for help or a decision when you are unsure or a step is consequential. Call this instead of `computer`.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                question: {
                    type: 'string',
                    description: 'The concrete question or decision you need from the user.'
                }
            },
            required: ['question']
        }
    }
}

/** The full tool set offered on every Reasoning_Step (Req 3.1, 3.2). */
export function buildReasoningTools(): ChatCompletionTool[] {
    return [COMPUTER_TOOL, TASK_COMPLETE_TOOL, REQUEST_HELP_TOOL]
}
