import React from 'react'

/**
 * Shared SVG glyphs for the sidebar UI. Pure presentational components: no
 * state, no styling beyond stroke/fill conventions (color always follows
 * `currentColor` so buttons control the tint).
 */

/** Paperclip glyph for the Add file button. */
export function PaperclipIcon(): React.JSX.Element {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
    )
}

/** Camera glyph for the in-app video recorder. */
export function VideoCameraIcon(): React.JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="6" width="13" height="12" rx="3" />
            <path d="m16 10 4.2-2.8a.5.5 0 0 1 .8.42v8.76a.5.5 0 0 1-.8.42L16 14" />
        </svg>
    )
}

/** Picture glyph for the "Files" option in the attach menu. */
export function ImageFileIcon(): React.JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        </svg>
    )
}

/** Clean upward send arrow. */
export function SendIcon(): React.JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
        </svg>
    )
}

/** Clean checkmark used for history selection. */
export function CheckIcon(): React.JSX.Element {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6L9 17l-5-5" />
        </svg>
    )
}

/** Right-angle chevron used to collapse/expand the sidebar. */
export function ChevronIcon({ open }: { open: boolean }): React.JSX.Element {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ display: 'block', transform: open ? 'none' : 'rotate(180deg)' }}
        >
            <path d="M15 6l-6 6 6 6" />
        </svg>
    )
}

/** Small caret used in the model pill to signal the accordion. */
export function CaretIcon({ open }: { open: boolean }): React.JSX.Element {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ display: 'block', transform: open ? 'rotate(180deg)' : 'none' }}
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    )
}

/** A filled square "stop" glyph for the Cancel pill. */
export function StopIcon(): React.JSX.Element {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="2.5" />
        </svg>
    )
}

/** Envelope glyph for the Mail-connector attach action. */
export function MailIcon(): React.JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
        </svg>
    )
}
