import React from 'react'
import { DEFAULT_INDICATOR_VISIBLE, indicatorLabel } from './viewModel'

/**
 * Control_Indicator overlay renderer (Task 16.3).
 *
 * Renders two things inside the transparent, always-on-top overlay window (the
 * window itself is created by the Window Manager in task 3.1):
 *  - a persistent "agent in control" indicator (Req 12.1), whose visibility
 *    tracks `indicator:show`/`indicator:hide` from the main process (Req 12.2);
 *  - an always-visible on-screen Emergency_Stop control wired to
 *    `window.operator.emergencyStop()` (Req 7.2, 7.8) — the fail-closed
 *    fallback that stays usable even when the global hotkey cannot register.
 *
 * `window.operator` is read defensively (it may be partially stubbed).
 */
export function App(): React.JSX.Element {
    const [visible, setVisible] = React.useState(DEFAULT_INDICATOR_VISIBLE)

    React.useEffect(() => {
        window.operator?.onIndicatorVisibility?.((next) => setVisible(next))
    }, [])

    const handleEmergencyStop = React.useCallback(() => {
        void window.operator?.emergencyStop?.()
    }, [])

    return (
        <div id="indicator" className={`indicator${visible ? ' indicator--active' : ''}`}>
            <div className="indicator__badge" role="status" aria-live="polite">
                <span className="indicator__dot" aria-hidden="true" />
                <span className="indicator__label">{indicatorLabel(visible)}</span>
            </div>
            {/* Always visible so the user can always take back control (Req 7.2, 7.8). */}
            <button
                type="button"
                className="indicator__estop"
                onClick={handleEmergencyStop}
                aria-label="Emergency stop"
            >
                Emergency Stop
            </button>
        </div>
    )
}
