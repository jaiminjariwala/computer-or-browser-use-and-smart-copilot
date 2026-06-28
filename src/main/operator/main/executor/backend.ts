import type { Point } from '@op-shared/types'
import { loadNativeBackend } from './native-backend'
import { CliclickInputBackend, isCliclickAvailable } from './cliclick-backend'

/**
 * The InputBackend abstraction — the narrow surface the executor drives to
 * synthesize OS input, plus the soft backend selection that picks one.
 *
 * The executor is only ever reached THROUGH the fail-closed Safety gate; by the
 * time a backend is called the Action is already approved, validated, and its
 * coordinates mapped to logical display points. A backend just posts events.
 */

/** Which physical mouse button an action drives. */
export type MouseButton = 'left' | 'right'

/**
 * The narrow surface the executor drives to synthesize input. Coordinates
 * passed to a backend are ALREADY mapped to logical display points (the
 * executor applies Coordinate_Mapping first), so a backend only posts events.
 *
 * Methods may be sync or async (the native addon is synchronous; the `cliclick`
 * fallback spawns a subprocess), so every method returns `void | Promise<void>`
 * and the executor always awaits. A backend throws to signal an execution
 * failure, which the executor records as an `ActionResult` failure (Req 5.4).
 */
export interface InputBackend {
    /** Identifies the active backend, for diagnostics/audit. */
    readonly kind: 'native' | 'cliclick'
    /** Move the pointer to a logical point (Req 5.1). */
    mouseMove(at: Point): void | Promise<void>
    /** Press+release `button` at a logical point; `clickCount` 2 = double-click. */
    click(at: Point, button: MouseButton, clickCount: number): void | Promise<void>
    /** Press at `from`, move, release at `to` (Req 5.1). */
    drag(from: Point, to: Point): void | Promise<void>
    /** Type Unicode text (Req 5.1). */
    typeText(text: string): void | Promise<void>
    /** Post a key chord, e.g. `['cmd','c']`, applying modifiers (Req 5.1). */
    key(keys: string[]): void | Promise<void>
    /** Post a scroll-wheel event anchored at a logical point (Req 5.1). */
    scroll(at: Point, dx: number, dy: number): void | Promise<void>
}

/**
 * Pick the best available backend: the native CGEvent addon when compiled for
 * the current ABI, else the `cliclick` subprocess fallback, else `null`.
 *
 * The fallback rationale: the native addon may not be built (CI/headless, or
 * before `npm run build:native`), so `cliclick` lets the perceive→reason→act
 * loop still run. When neither is present we return `null` rather than throw —
 * the executor then fails input Actions closed while non-input Actions still
 * work — so the app and the test suite keep running regardless.
 */
export function selectInputBackend(): InputBackend | null {
    const native = loadNativeBackend()
    if (native) return native
    if (isCliclickAvailable()) return new CliclickInputBackend()
    return null
}
