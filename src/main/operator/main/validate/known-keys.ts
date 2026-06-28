/**
 * The `key` / `wait` vocabulary (part of Task 8.2) — PURE, Electron-free.
 *
 * This is the fixed set of key names a `key` Action may reference and the upper
 * bound on a `wait`. Keeping the vocabulary in its own module lets the schema
 * checks in `schema.ts` stay focused on *shape*, while this file owns *which
 * names/durations are admissible*.
 */

/** Upper bound on a `wait` Action's duration (ms). Prevents unbounded stalls. */
export const MAX_WAIT_MS = 60_000

/**
 * The set of key names a `key` Action may reference. Case-insensitive. Covers
 * the modifiers, editing keys, navigation, function keys, and printable
 * single-character keys the operator needs for keyboard shortcuts.
 */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
    // Modifiers
    'cmd',
    'command',
    'meta',
    'super',
    'win',
    'ctrl',
    'control',
    'alt',
    'option',
    'shift',
    'fn',
    // Editing / whitespace
    'enter',
    'return',
    'tab',
    'space',
    'backspace',
    'delete',
    'del',
    'escape',
    'esc',
    'capslock',
    'insert',
    // Navigation
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'pageup',
    'pagedown',
    // Function keys F1..F20
    ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
    // Digits 0..9
    ...Array.from({ length: 10 }, (_, i) => String(i))
    // (printable single characters are accepted dynamically below)
])

/** True iff `key` is a recognised key name (case-insensitive) or a single printable char. */
export function isKnownKey(key: unknown): key is string {
    if (typeof key !== 'string' || key.length === 0) return false
    if (KNOWN_KEYS.has(key.toLowerCase())) return true
    // Accept a single printable character (e.g. 'a', '/', '=').
    return Array.from(key).length === 1
}
