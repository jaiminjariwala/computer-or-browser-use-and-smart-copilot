import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Rect } from '@shared/types'
import { isValidSelection, rectFromPoints, type Point } from './selection'

/**
 * Overlay_Window region selector (rectangle).
 *
 * The user drags a rectangle around what they want to capture (Req 4.2, 15);
 * the rectangle becomes the captured region (Req 4.3) and is submitted the
 * moment the drag ends. The shot lands as a staged thumbnail in the composer,
 * where the user types (or dictates) their question — the overlay itself has
 * no input of its own. Esc / right-click cancels.
 */

interface OverlayBridge {
    submitRegion(rect: Rect, text?: string): Promise<void>
    cancelRegion(): Promise<void>
}

function getOverlayBridge(): OverlayBridge | null {
    const glass = (window as unknown as { glass?: Partial<OverlayBridge> }).glass
    if (glass && typeof glass.submitRegion === 'function' && typeof glass.cancelRegion === 'function') {
        return glass as OverlayBridge
    }
    return null
}

export function App(): React.JSX.Element {
    const [rectDrag, setRectDrag] = useState<{ start: Point; current: Point } | null>(null)
    const [drawing, setDrawing] = useState(false)
    const [cursorPos, setCursorPos] = useState<Point | null>(null)
    const settled = useRef(false)

    const cancel = useCallback(() => {
        if (settled.current) return
        settled.current = true
        void getOverlayBridge()?.cancelRegion()
    }, [])

    const submit = useCallback((rect: Rect) => {
        if (settled.current) return
        settled.current = true
        void getOverlayBridge()?.submitRegion(rect)
    }, [])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [cancel])

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return
        const p = { x: e.clientX, y: e.clientY }
        setCursorPos(p)
        setDrawing(true)
        setRectDrag({ start: p, current: p })
    }, [])

    const onMouseMove = useCallback(
        (e: React.MouseEvent) => {
            const p = { x: e.clientX, y: e.clientY }
            setCursorPos(p)
            if (!drawing) return
            setRectDrag((d) => (d ? { start: d.start, current: p } : d))
        },
        [drawing]
    )

    const onMouseUp = useCallback(
        (e: React.MouseEvent) => {
            if (!drawing || e.button !== 0 || !rectDrag) return
            setDrawing(false)
            const rect = rectFromPoints(rectDrag.start, rectDrag.current)
            if (isValidSelection(rect)) {
                // Submit immediately: the shot stages into the composer
                // carousel, where the question gets asked.
                submit(rect)
            } else {
                setRectDrag(null)
            }
        },
        [drawing, rectDrag, submit]
    )

    const onContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault()
            cancel()
        },
        [cancel]
    )

    const liveRect = rectDrag ? rectFromPoints(rectDrag.start, rectDrag.current) : null

    return (
        <div
            className="overlay-root"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onContextMenu={onContextMenu}
            role="application"
            aria-label="Drag a rectangle around what you want to capture. Escape to cancel."
        >
            {!rectDrag && (
                <p className="overlay-hint">Esc to cancel</p>
            )}

            {cursorPos && (
                <div
                    className="overlay-cursor"
                    style={{ left: cursorPos.x, top: cursorPos.y }}
                    aria-hidden="true"
                >
                    <svg width="28" height="28" viewBox="0 0 28 28">
                        <g className="overlay-cursor__halo">
                            <line x1="14" y1="2" x2="14" y2="26" />
                            <line x1="2" y1="14" x2="26" y2="14" />
                        </g>
                        <g className="overlay-cursor__core">
                            <line x1="14" y1="2" x2="14" y2="26" />
                            <line x1="2" y1="14" x2="26" y2="14" />
                        </g>
                    </svg>
                </div>
            )}

            {liveRect && (
                <div
                    className="overlay-selection"
                    style={{
                        left: liveRect.x,
                        top: liveRect.y,
                        width: liveRect.width,
                        height: liveRect.height
                    }}
                    aria-hidden="true"
                />
            )}
        </div>
    )
}
