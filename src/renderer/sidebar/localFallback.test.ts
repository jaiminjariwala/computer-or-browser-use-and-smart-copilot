import { describe, it, expect } from 'vitest'
import type { SessionContext } from '@shared/types'
import { buildFallbackRequest } from './localFallback'

/**
 * Tests for the on-device fallback prompt builder. The key behavior: a text-only
 * question must NOT be given the screenshot-oriented prompt (which made the tiny
 * on-device model answer generically), while a screenshotted request still gets
 * the vision "next step" prompt.
 */

function ctx(partial: Partial<SessionContext>): SessionContext {
    return {
        summary: { inferredIntent: '', recentTurns: [] },
        recentTurns: [],
        ...partial
    } as SessionContext
}

describe('buildFallbackRequest', () => {
    it('uses a general assistant prompt for a text-only question', () => {
        const { images, prompt } = buildFallbackRequest(
            ctx({ recentTurns: [{ id: 't1', role: 'user', text: 'give me python code for rotting oranges' } as never] })
        )
        expect(images).toHaveLength(0)
        expect(prompt).not.toContain('Look at the screenshot')
        expect(prompt).toContain('Answer the user')
        // The user's question is carried into the prompt so the model answers it.
        expect(prompt).toContain('rotting oranges')
    })

    it('uses the screenshot prompt when a capture is present', () => {
        const { images, prompt } = buildFallbackRequest(
            ctx({ currentCapture: { dataUrl: 'data:image/png;base64,AAAA' } as never })
        )
        expect(images).toHaveLength(1)
        expect(prompt).toContain('Look at the screenshot')
    })

    it('keeps at most the two most recent images', () => {
        const { images } = buildFallbackRequest(
            ctx({
                recentTurns: [
                    { id: 'a', role: 'user', captures: [{ dataUrl: 'data:image/png;base64,1' }] } as never,
                    { id: 'b', role: 'user', captures: [{ dataUrl: 'data:image/png;base64,2' }] } as never
                ],
                currentCapture: { dataUrl: 'data:image/png;base64,3' } as never
            })
        )
        expect(images).toEqual(['data:image/png;base64,2', 'data:image/png;base64,3'])
    })
})
