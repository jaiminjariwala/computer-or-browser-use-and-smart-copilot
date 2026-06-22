import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Rect } from '@shared/types'
import { isValidSelection, rectFromPoints, type Point } from './selection'
import { useDictation, VoiceBars } from '../voice-lib'

/**
 * Overlay_Window region selector (rectangle).
 *
 * The user drags a rectangle around what they want to capture (Req 4.2, 15);
 * the rectangle becomes the captured region (Req 4.3). After selecting, an
 * optional follow-up input appears so the user can ask a question about the
 * capture (or press Enter to send with no text). Esc / right-click cancels.
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
    const [pendingRect, setPendingRect] = useState<Rect | null>(null)
    const [followup, setFollowup] = useState('')
    const [cursorPos, setCursorPos] = useState<Point | null>(null)
    const settled = useRef(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const followupRef = useRef('')

    useEffect(() => {
        followupRef.current = followup
    }, [followup])

    const dictation = useDictation({
        onText: setFollowup,
        getBaseText: () => followupRef.current
    })

    const cancel = useCallback(() => {
        if (settled.current) return
        settled.current = true
        void getOverlayBridge()?.cancelRegion()
    }, [])

    const submit = useCallback((rect: Rect, text?: string) => {
        if (settled.current) return
        settled.current = true
        const trimmed = text?.trim()
        void getOverlayBridge()?.submitRegion(rect, trimmed && trimmed.length > 0 ? trimmed : undefined)
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

    useEffect(() => {
        if (pendingRect) inputRef.current?.focus()
    }, [pendingRect])

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (e.button !== 0 || pendingRect) return
            const p = { x: e.clientX, y: e.clientY }
            setCursorPos(p)
            setDrawing(true)
            setRectDrag({ start: p, current: p })
        },
        [pendingRect]
    )

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
                setPendingRect(rect)
            } else {
                setRectDrag(null)
            }
        },
        [drawing, rectDrag]
    )

    const onContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault()
            cancel()
        },
        [cancel]
    )

    const onFollowupKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                if (pendingRect) submit(pendingRect, followup)
            } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
            }
        },
        [pendingRect, followup, submit, cancel]
    )

    const liveRect = rectDrag ? rectFromPoints(rectDrag.start, rectDrag.current) : null

    // Anchor the follow-up input to the corner where the drag ended: horizontal
    // side follows the drag's x-direction (right edge when dragging rightward,
    // left edge when leftward); it sits below the selection when dragging down
    // and above when dragging up. Falls back to the opposite side when there's
    // no room, and is clamped to the viewport.
    const INPUT_W = 340
    const INPUT_H = 52
    const inputPos =
        pendingRect && rectDrag
            ? (() => {
                const goingRight = rectDrag.current.x >= rectDrag.start.x
                const goingDown = rectDrag.current.y >= rectDrag.start.y

                let left = goingRight
                    ? pendingRect.x + pendingRect.width - INPUT_W
                    : pendingRect.x
                left = Math.max(12, Math.min(left, window.innerWidth - INPUT_W - 12))

                let top = goingDown
                    ? pendingRect.y + pendingRect.height + 12
                    : pendingRect.y - INPUT_H - 12
                if (top + INPUT_H + 12 > window.innerHeight) {
                    top = pendingRect.y - INPUT_H - 12
                }
                if (top < 12) {
                    top = pendingRect.y + pendingRect.height + 12
                }
                top = Math.max(12, Math.min(top, window.innerHeight - INPUT_H - 12))

                return { left, top }
            })()
            : null

    return (
        <div
            className={`overlay-root${pendingRect ? ' overlay-root--input' : ''}`}
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

            {!pendingRect && cursorPos && (
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

            {pendingRect && inputPos && (
                <div
                    className="overlay-followup"
                    style={{ left: inputPos.left, top: inputPos.top }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <input
                        ref={inputRef}
                        className="overlay-followup__input"
                        type="text"
                        placeholder="Ask about this (optional), Enter to send"
                        value={followup}
                        onChange={(e) => setFollowup(e.target.value)}
                        onKeyDown={onFollowupKeyDown}
                    />
                    {dictation.supported && (
                        <button
                            type="button"
                            className={`overlay-followup__mic${dictation.listening || dictation.transcribing ? ' overlay-followup__mic--on' : ''}`}
                            onClick={dictation.toggle}
                            disabled={dictation.transcribing}
                            aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                            aria-pressed={dictation.listening}
                            title={
                                dictation.transcribing
                                    ? 'Transcribing…'
                                    : dictation.listening
                                        ? 'Stop'
                                        : 'Speak'
                            }
                        >
                            <VoiceBars active={dictation.listening} />
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
