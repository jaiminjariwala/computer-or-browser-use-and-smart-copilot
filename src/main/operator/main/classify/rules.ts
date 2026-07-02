/**
 * High_Risk detectors (part of Task 10.1, Req 9.2).
 *
 * The Action_Space is intentionally low-level (`left_click`, `type`, `key`, …),
 * so a raw Action carries no intrinsic "this is a purchase" signal. These
 * detectors recover intent from the three sources the classifier consults:
 *
 *   1. the model risk hint  (see {@link hintSaysHigh} / {@link hintSaysLow}),
 *   2. the target's role / label / surrounding text, and
 *   3. the Action's own parameters (typed text, key combination).
 *
 * Everything here is pure string/shape matching. The fail-closed decision that
 * ties these together lives in `classifier.ts`; this module only answers narrow
 * "does this signal look high-risk?" questions.
 */

import type { Action, ActionKind } from '@op-shared/types'
import type { ClassificationContext, ModelRiskHint, RiskCategory } from './context'

// ---------------------------------------------------------------------------
// Structural action classes
// ---------------------------------------------------------------------------

/**
 * Kinds that cannot, on their own, trigger an enumerated high-risk category.
 * They observe, move the pointer, scroll, or idle — none commits a purchase,
 * sends a message, deletes data, submits credentials, or runs a shell command.
 * Everything NOT in this set is a "committing" kind that must prove itself
 * ordinary before it is treated as such.
 */
export const NON_COMMITTING_KINDS: readonly ActionKind[] = [
    'screenshot',
    'mouse_move',
    'scroll',
    'wait'
] as const

/** True iff the kind is non-committing (see {@link NON_COMMITTING_KINDS}). */
export function isNonCommitting(kind: ActionKind): boolean {
    return NON_COMMITTING_KINDS.includes(kind)
}

// ---------------------------------------------------------------------------
// High-risk lexicon (per enumerated category, Req 9.2)
// ---------------------------------------------------------------------------

/**
 * Phrases that, when present in a target label, surrounding text, or typed
 * text, indicate one of the enumerated high-risk categories. Matching is
 * case-insensitive substring matching on normalized text.
 */
const HIGH_RISK_LEXICON: Readonly<Record<RiskCategory, readonly string[]>> = {
    purchase: [
        'buy',
        'purchase',
        'place order',
        'order now',
        'complete order',
        'complete purchase',
        'checkout',
        'check out',
        'pay ',
        'pay now',
        'payment',
        'submit payment',
        'confirm payment',
        'subscribe',
        'donate',
        'add funds'
    ],
    message: [
        'send',
        'send message',
        'send email',
        'reply',
        'reply all',
        'post',
        'publish',
        'tweet',
        'share',
        'submit post'
    ],
    delete: [
        'delete',
        'remove',
        'erase',
        'discard',
        'trash',
        'move to trash',
        'overwrite',
        'wipe',
        'format',
        'clear all',
        'empty trash'
    ],
    credential: [
        'password',
        'passcode',
        'credential',
        'sign in',
        'signin',
        'log in',
        'login',
        'authenticate',
        'authentication',
        'one-time code',
        'verification code',
        'otp',
        '2fa',
        'credit card',
        'card number',
        'cvv',
        'security code',
        'social security',
        'ssn',
        'pin '
    ],
    destructive: [
        'rm -rf',
        'rm -r',
        'sudo',
        'mkfs',
        'diskutil erase',
        'shutdown',
        'reboot',
        'killall',
        'drop table',
        'drop database',
        'truncate table',
        'del /',
        'format c:',
        '> /dev/'
    ]
}

/** All lexicon phrases flattened, for a single scan. */
const ALL_HIGH_RISK_PHRASES: readonly string[] = Object.values(HIGH_RISK_LEXICON).flat()

/** Normalize text for matching: lowercase + collapse whitespace. */
function normalize(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ')
}

/** True iff any high-risk lexicon phrase appears in the given text. */
export function matchesHighRiskLexicon(text: string | undefined): boolean {
    if (!text) return false
    const normalized = normalize(text)
    return ALL_HIGH_RISK_PHRASES.some((phrase) => normalized.includes(phrase))
}

// ---------------------------------------------------------------------------
// Destructive keystroke detection (for `key` Actions)
// ---------------------------------------------------------------------------

const MODIFIER_KEYS = new Set(['cmd', 'command', 'meta', 'super', 'win', 'ctrl', 'control'])
const DELETION_KEYS = new Set(['delete', 'backspace', 'forwarddelete', 'del'])

/**
 * A key combination is treated as destructive when it pairs a command/control
 * modifier with a deletion key (e.g. `⌘+Delete` to trash, `Ctrl+Delete`). Bare
 * deletion keys are handled by the general ambiguity rule rather than singled
 * out here.
 */
export function isDestructiveKeyCombo(keys: readonly string[]): boolean {
    const normalized = keys.map((k) => k.trim().toLowerCase())
    const hasModifier = normalized.some((k) => MODIFIER_KEYS.has(k))
    const hasDeletion = normalized.some((k) => DELETION_KEYS.has(k))
    return hasModifier && hasDeletion
}

// ---------------------------------------------------------------------------
// Signal extraction + hint interpretation
// ---------------------------------------------------------------------------

/** Collect every free-text signal relevant to an Action + its context. */
export function textSignals(action: Action, context: ClassificationContext): string[] {
    const signals: string[] = []
    const target = context.target
    if (target?.label) signals.push(target.label)
    if (target?.surroundingText) signals.push(target.surroundingText)
    if (target?.role) signals.push(target.role)
    if (action.kind === 'type') signals.push(action.text)
    if (action.kind === 'key') signals.push(action.keys.join('+'))
    return signals
}

/** True iff the model hint positively marks the Action High_Risk. */
export function hintSaysHigh(hint: ModelRiskHint | undefined): boolean {
    if (!hint) return false
    if (hint.level === 'high') return true
    if (hint.categories && hint.categories.length > 0) return true
    return false
}

/** True iff the model hint positively asserts the Action is ordinary. */
export function hintSaysLow(hint: ModelRiskHint | undefined): boolean {
    if (!hint) return false
    if (hint.categories && hint.categories.length > 0) return false
    return hint.level === 'low'
}
