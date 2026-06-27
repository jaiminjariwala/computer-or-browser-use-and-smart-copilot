/**
 * Reasoning request construction + response parsing (Task 6.2 / 6.4).
 *
 * This module is the **provider-agnostic**, PURE core of the Reasoning Layer.
 * It owns three responsibilities from the design's "Reasoning Request
 * Construction" section, none of which touch the network or Electron:
 *
 *  1. The operator-behavior + safety-contract system prompt  → `system-prompt.ts`
 *  2. The `computer` / `task_complete` / `request_help` tools → `tools.ts`
 *  3. Bounded context assembly + OpenAI-shaped message render → `messages.ts`
 *  4. Parsing a response into exactly one ReasoningOutcome    → `parse.ts`
 *
 * It was split into the sibling `reasoning-request/` folder for readability;
 * this file stays a BARREL so every existing import path keeps working
 * (Req 3.1, 15.1). Providers differ only in transport; the request shape here is
 * identical no matter which Model_Provider serves the step.
 */

export { OPERATOR_SYSTEM_PROMPT } from './reasoning-request/system-prompt'
export {
    COMPUTER_TOOL,
    TASK_COMPLETE_TOOL,
    REQUEST_HELP_TOOL,
    buildReasoningTools
} from './reasoning-request/tools'
export {
    RECENT_STEPS_LIMIT,
    assembleReasoningContext,
    formatProgress,
    renderRecentStep,
    describeAction,
    formatObservationMetadata,
    buildReasoningMessages
} from './reasoning-request/messages'
export {
    parseReasoningResponse,
    type ParsedToolCall,
    type ReasoningResponseMessage
} from './reasoning-request/parse'
