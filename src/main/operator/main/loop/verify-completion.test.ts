import { describe, it, expect } from 'vitest'
import { verifyCompletionEvidence } from './verify-completion'

const SURFACE =
    'Browser tabs: 1; active tab: 1\n' +
    '* 1: Closer - The Chainsmokers - YouTube — https://www.youtube.com/watch?v=PT2_F-1esPk\n' +
    'Title: Closer - The Chainsmokers - YouTube\n' +
    'URL: https://www.youtube.com/watch?v=PT2_F-1esPk'

describe('verifyCompletionEvidence', () => {
    it('accepts a verbatim quote that appears in the observation', () => {
        const verdict = verifyCompletionEvidence('Closer - The Chainsmokers - YouTube', {
            pageText: SURFACE
        })
        expect(verdict).toEqual({ verified: true })
    })

    it('matches case- and whitespace-insensitively', () => {
        const verdict = verifyCompletionEvidence('closer  -  the CHAINSMOKERS - youtube', {
            pageText: SURFACE
        })
        expect(verdict.verified).toBe(true)
    })

    it('accepts a URL quote', () => {
        const verdict = verifyCompletionEvidence('youtube.com/watch?v=PT2_F-1esPk', {
            pageText: SURFACE
        })
        expect(verdict.verified).toBe(true)
    })

    it('rejects a claim with no evidence when the observation is checkable', () => {
        const verdict = verifyCompletionEvidence(undefined, { pageText: SURFACE })
        expect(verdict.verified).toBe(false)
        expect(verdict.reason).toMatch(/no evidence/i)
    })

    it('rejects evidence that does not appear in the observation', () => {
        const verdict = verifyCompletionEvidence('Now playing: Shape of You', {
            pageText: SURFACE
        })
        expect(verdict.verified).toBe(false)
        expect(verdict.reason).toMatch(/does not appear/i)
    })

    it('fails open when the observation has no text surface (screenshot-only)', () => {
        expect(verifyCompletionEvidence(undefined, { pageText: undefined }).verified).toBe(true)
        expect(verifyCompletionEvidence(undefined, undefined).verified).toBe(true)
        expect(verifyCompletionEvidence('anything', { pageText: 'tiny' }).verified).toBe(true)
    })
})
