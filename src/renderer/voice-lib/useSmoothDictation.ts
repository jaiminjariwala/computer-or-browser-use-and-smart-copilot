import { useCallback, useEffect, useRef } from 'react'
import { useDictation, type Dictation } from './useDictation'

/**
 * Dictation with a smooth character-by-character reveal — the stable v1 UX.
 *
 * Wraps {@link useDictation}: the latest transcript from the model is treated as
 * a "target", and the visible text catches up to it a few characters at a time
 * on a fast timer. Because the displayed text is decoupled from the model's
 * batch updates, text streams in as a smooth, continuous reveal (it speeds up
 * when behind and eases as it catches up) instead of snapping/jumping whenever a
 * new batch arrives. New dictation appends to whatever text is already present.
 *
 * The caller owns the text field; this hook reads it via `getText` and writes to
 * it via `setText`. While dictating, the field should be read-only so the reveal
 * isn't fighting manual edits.
 */

export interface SmoothDictationOptions {
    /** Current field text (used as the append base at session start). */
    getText: () => string
    /** Apply revealed text to the field. */
    setText: (text: string) => void
    /** Surface mic/transcription errors. */
    onError?: (message: string) => void
    /** Reveal tick interval in ms (default 16 ≈ 60fps). */
    revealMs?: number
}

export function useSmoothDictation(options: SmoothDictationOptions): Dictation {
    const { getText, setText, onError } = options
    const revealMs = options.revealMs ?? 16

    const getTextRef = useRef(getText)
    const setTextRef = useRef(setText)
    useEffect(() => {
        getTextRef.current = getText
        setTextRef.current = setText
    }, [getText, setText])

    const targetRef = useRef('')
    const curRef = useRef('')
    const revealRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const listeningRef = useRef(false)

    const tick = useCallback(() => {
        const target = targetRef.current
        const cur = curRef.current
        if (cur === target) {
            if (!listeningRef.current && revealRef.current !== null) {
                clearInterval(revealRef.current)
                revealRef.current = null
            }
            return
        }
        let next: string
        if (target.startsWith(cur)) {
            // Catch up faster when further behind, so it never lags noticeably.
            const step = Math.max(4, Math.ceil((target.length - cur.length) / 5))
            next = target.slice(0, Math.min(target.length, cur.length + step))
        } else {
            // Transcript was revised in a way that isn't a clean append; snap.
            next = target
        }
        curRef.current = next
        setTextRef.current(next)
    }, [])

    const ensureReveal = useCallback(() => {
        if (revealRef.current === null) {
            revealRef.current = setInterval(tick, revealMs)
        }
    }, [tick, revealMs])

    const pushTarget = useCallback(
        (t: string) => {
            targetRef.current = t
            ensureReveal()
        },
        [ensureReveal]
    )

    const dictation = useDictation({
        onText: pushTarget,
        onFinal: pushTarget,
        getBaseText: () => {
            // At session start, sync the current displayed text as the base so
            // dictation appends to it and the reveal starts from the right place.
            curRef.current = getTextRef.current()
            return curRef.current
        },
        onError
    })

    useEffect(() => {
        listeningRef.current = dictation.listening
        if (dictation.listening) ensureReveal()
    }, [dictation.listening, ensureReveal])

    useEffect(
        () => () => {
            if (revealRef.current !== null) clearInterval(revealRef.current)
        },
        []
    )

    return dictation
}
