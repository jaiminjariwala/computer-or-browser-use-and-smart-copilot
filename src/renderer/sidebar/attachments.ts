import type { TurnCapture } from '@shared/types'

/** Staged-attachment model + naming helpers for the composer carousel. */

/** Attach at most this many videos per message (keeps requests fast/reliable). */
export const MAX_STAGED_VIDEOS = 2

/** A local image or video waiting above the composer until Send. */
export interface StagedAttachment {
    id: string
    kind: 'image' | 'video'
    status: 'processing' | 'ready'
    captures: TurnCapture[]
    name: string
    /** Blob URL used only for the local playable video preview. */
    previewUrl?: string
    durationSeconds?: number
}

/**
 * A macOS-style display name for a freshly captured screenshot, e.g.
 * "Screenshot 9.02.15 PM.png". Screenshots have no real filename, so we mint
 * one from the capture time to show under each carousel card.
 */
export function makeShotName(): string {
    const time = new Date().toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    })
    return `Screenshot ${time}.png`
}

/** macOS Finder style middle-truncation, e.g. "Screens…PM.png". */
export function finderName(name = '', startChars = 7, endChars = 6): string {
    if (name.length <= startChars + endChars + 1) return name
    return name.slice(0, startChars) + '\u2026' + name.slice(name.length - endChars)
}

/**
 * Fold an attached Apple Mail message into the outgoing chat text. The block
 * travels as plain message text (transparent to the user and to the model);
 * an empty user ask defaults to a sensible request.
 */
export function formatEmailContext(
    email: { subject: string; sender: string; receivedAt: string; body: string },
    userText: string
): string {
    const ask = userText.trim().length > 0 ? userText.trim() : 'Help me with this email.'
    return [
        '[Attached email from Apple Mail]',
        `From: ${email.sender}`,
        `Subject: ${email.subject}`,
        email.receivedAt ? `Received: ${email.receivedAt}` : null,
        '',
        email.body.trim(),
        '[End of attached email]',
        '',
        ask
    ]
        .filter((line): line is string => line !== null)
        .join('\n')
}
