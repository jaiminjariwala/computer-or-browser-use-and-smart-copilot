/**
 * Control_Indicator view-model helpers (Task 16.3).
 *
 * Pure, `window`-free logic for the overlay so the show/hide behavior and the
 * label text can be unit-tested headlessly. The React {@link App} renders these.
 *
 * Requirements realized:
 *  - 7.2  an always-visible on-screen Emergency_Stop control while in control
 *  - 12.1 a persistent, visible "agent in control" indicator while acting
 *  - 12.2 remove/visibly change the indicator when the agent is no longer in control
 */

/**
 * The overlay is hidden by default; the main process reveals it strictly in
 * lockstep with "agent in control" state via `indicator:show`/`indicator:hide`
 * (Req 12.1, 12.2).
 */
export const DEFAULT_INDICATOR_VISIBLE = false

/** Human-readable status label reflecting in-control state (Req 12.1, 12.2). */
export function indicatorLabel(visible: boolean): string {
    return visible ? 'Agent in control' : 'Agent idle'
}

/**
 * Reduce a raw `indicator:show` / `indicator:hide` signal into the next boolean
 * visibility state. Kept pure so the wiring in {@link App} is trivial and the
 * lockstep behavior is testable.
 */
export function nextVisibility(signal: 'show' | 'hide'): boolean {
    return signal === 'show'
}
