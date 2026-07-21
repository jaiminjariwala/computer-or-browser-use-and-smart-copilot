import React, { useEffect, useRef, useState } from 'react'
import { CaretIcon, CheckIcon } from './icons'

/** One option in a {@link HeaderSelect}. */
export interface HeaderSelectOption {
    value: string
    label: string
}

/**
 * A custom header dropdown styled like the composer's model/voice pills, so the
 * operator's Environment / Autonomy controls match the rest of the UI instead
 * of rendering the native macOS `<select>` popup. Opens downward (it lives in
 * the header) and closes on selection or an outside click.
 */
export function HeaderSelect({
    value,
    options,
    onChange,
    ariaLabel,
    title
}: {
    value: string
    options: HeaderSelectOption[]
    onChange: (value: string) => void
    ariaLabel: string
    title: string
}): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const current = options.find((o) => o.value === value)

    useEffect(() => {
        if (!open) return
        const onDocPointerDown = (e: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', onDocPointerDown)
        return () => document.removeEventListener('mousedown', onDocPointerDown)
    }, [open])

    return (
        <div className="glass-hselect" ref={rootRef}>
            <button
                type="button"
                className="glass-hselect__btn"
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={title}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="glass-hselect__label">{current?.label ?? ariaLabel}</span>
                <CaretIcon open={open} />
            </button>
            {open && (
                <div className="glass-hselect__menu" role="listbox" aria-label={ariaLabel}>
                    {options.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            role="option"
                            aria-selected={o.value === value}
                            className={`glass-hselect__item${o.value === value ? ' glass-hselect__item--on' : ''}`}
                            onClick={() => {
                                onChange(o.value)
                                setOpen(false)
                            }}
                        >
                            <span className="glass-hselect__check">
                                {o.value === value ? <CheckIcon /> : null}
                            </span>
                            <span className="glass-hselect__text">{o.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
