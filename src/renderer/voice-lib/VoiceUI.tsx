import React, { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

/**
 * Word-by-word animated transcript reveal (fade + rise + de-blur, lightly
 * staggered). Kept in the library for experiments that want per-word animation;
 * the shipping composer uses the smooth character reveal in
 * {@link useSmoothDictation} instead, which is stable against element swaps.
 *
 * NOTE: relies on app-provided CSS classes (`glass-transcript`,
 * `glass-transcript__word`).
 */
export function AnimatedTranscript({
    text,
    placeholder
}: {
    text: string
    placeholder?: string
}): React.JSX.Element {
    const tokens = text.trim().length > 0 ? text.trim().split(/\s+/) : []
    const prevCount = useRef(0)
    const animateFrom = Math.min(prevCount.current, tokens.length)
    const containerRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        prevCount.current = tokens.length
        const el = containerRef.current
        if (el) el.scrollTop = el.scrollHeight
    })

    if (tokens.length === 0) {
        return (
            <div ref={containerRef} className="glass-transcript glass-transcript--empty">
                {placeholder}
            </div>
        )
    }

    return (
        <div ref={containerRef} className="glass-transcript" aria-live="polite">
            {tokens.map((word, i) => {
                const isNew = i >= animateFrom
                return (
                    <motion.span
                        key={i}
                        className="glass-transcript__word"
                        initial={isNew ? { opacity: 0, y: 6, filter: 'blur(4px)' } : false}
                        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                        transition={{
                            duration: 0.26,
                            ease: [0.22, 1, 0.36, 1],
                            delay: isNew ? (i - animateFrom) * 0.04 : 0
                        }}
                    >
                        {word}{' '}
                    </motion.span>
                )
            })}
        </div>
    )
}

/**
 * Voice indicator (equalizer bars). Used as the default mic glyph: animates as
 * a live waveform while recording, and rests as a static equalizer when idle.
 *
 * NOTE: relies on app-provided CSS classes (`glass-voicebars`,
 * `glass-voicebars__bar`).
 */
export function VoiceBars({ active = true }: { active?: boolean }): React.JSX.Element {
    const idleHeights = [0.5, 0.85, 0.65, 0.4]
    return (
        <span className="glass-voicebars" aria-hidden="true">
            {idleHeights.map((h, i) =>
                active ? (
                    <motion.span
                        key={i}
                        className="glass-voicebars__bar"
                        animate={{ scaleY: [0.3, 1, 0.3] }}
                        transition={{
                            duration: 0.85,
                            repeat: Infinity,
                            ease: 'easeInOut',
                            delay: i * 0.13
                        }}
                    />
                ) : (
                    <span
                        key={i}
                        className="glass-voicebars__bar"
                        style={{ transform: `scaleY(${h})` }}
                    />
                )
            )}
        </span>
    )
}
