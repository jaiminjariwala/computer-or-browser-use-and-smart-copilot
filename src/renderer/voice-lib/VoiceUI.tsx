import React from 'react'

/**
 * Voice indicator (equalizer bars). Used as the mic glyph everywhere: animates
 * as a live waveform while recording (pure CSS keyframes — no animation
 * library), and rests as a static equalizer when idle.
 *
 * NOTE: relies on app-provided CSS classes (`glass-voicebars`,
 * `glass-voicebars--active`, `glass-voicebars__bar`).
 */
export function VoiceBars({ active = true }: { active?: boolean }): React.JSX.Element {
    const idleHeights = [0.5, 0.85, 0.65, 0.4]
    return (
        <span
            className={`glass-voicebars${active ? ' glass-voicebars--active' : ''}`}
            aria-hidden="true"
        >
            {idleHeights.map((h, i) => (
                <span
                    key={i}
                    className="glass-voicebars__bar"
                    style={active ? undefined : { transform: `scaleY(${h})` }}
                />
            ))}
        </span>
    )
}
