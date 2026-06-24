import React, { useCallback } from 'react'

/**
 * Floating pencil launcher (the always-available capture trigger).
 *
 * This renders in its own small, transparent, always-on-top window that floats
 * over every app and Space. Clicking the pencil calls `triggerCapture()` on the
 * preload bridge — the same `capture:trigger` path the in-chat button uses — so
 * the user can start a region capture from anywhere without returning to the
 * chat window. The answer then appears in the Sidebar (which the main process
 * reveals when a capture is submitted).
 *
 * The thin ring around the button is a drag region (`-webkit-app-region: drag`)
 * so the user can reposition the pencil; the button itself is `no-drag` so it
 * stays clickable.
 */

interface PencilBridge {
    triggerCapture(): Promise<void>
}

function getBridge(): PencilBridge | null {
    const glass = (window as unknown as { glass?: Partial<PencilBridge> }).glass
    if (glass && typeof glass.triggerCapture === 'function') {
        return glass as PencilBridge
    }
    return null
}

export function App(): React.JSX.Element {
    const onCapture = useCallback(() => {
        const bridge = getBridge()
        void bridge?.triggerCapture().catch(() => {
            /* errors surface in the sidebar via error:show */
        })
    }, [])

    return (
        <div className="pencil-root">
            <button
                type="button"
                className="pencil-btn"
                onClick={onCapture}
                aria-label="Capture a region of your screen"
                title="Capture a region of your screen"
            >
                <span className="pencil-emoji" role="img" aria-hidden="true">
                    ✏️
                </span>
            </button>
        </div>
    )
}
