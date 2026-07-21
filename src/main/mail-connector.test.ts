import { describe, it, expect, vi } from 'vitest'
import { decodeMailPayload, mapMailFailure, readSelectedMail, type OsaExec } from './mail-connector'

const OK_PAYLOAD = JSON.stringify({
    ok: true,
    subject: 'Rent increase notice',
    sender: 'Landlord <landlord@example.com>',
    receivedAt: 'Mon Jul 20 2026 09:12:00 GMT-0700 (PDT)',
    body: 'Hi, your rent will increase by 8% starting September.'
})

describe('decodeMailPayload', () => {
    it('decodes a successful selection payload', () => {
        const result = decodeMailPayload(OK_PAYLOAD)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.email.subject).toBe('Rent increase notice')
        expect(result.email.sender).toContain('landlord@example.com')
        expect(result.email.body).toContain('8%')
    })

    it('maps not-running and no-selection codes to friendly guidance', () => {
        const notRunning = decodeMailPayload(JSON.stringify({ ok: false, code: 'not-running' }))
        expect(notRunning.ok).toBe(false)
        if (!notRunning.ok) expect(notRunning.error).toContain('Mail is not open')

        const noSelection = decodeMailPayload(JSON.stringify({ ok: false, code: 'no-selection' }))
        expect(noSelection.ok).toBe(false)
        if (!noSelection.ok) expect(noSelection.error).toContain('No email is selected')
    })

    it('degrades garbage output to a readable error', () => {
        const result = decodeMailPayload('execution error: whatever')
        expect(result.ok).toBe(false)
    })

    it('defaults a missing subject and truncates huge bodies', () => {
        const result = decodeMailPayload(
            JSON.stringify({ ok: true, subject: '', sender: 's', receivedAt: '', body: 'x'.repeat(30000) })
        )
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.email.subject).toBe('(no subject)')
        expect(result.email.body.length).toBeLessThan(21000)
        expect(result.email.body).toContain('[…email truncated]')
    })
})

describe('mapMailFailure', () => {
    it('maps the macOS automation-denied error to permission guidance', () => {
        expect(mapMailFailure('execution error: Not authorized to send Apple events to Mail. (-1743)')).toContain(
            'Privacy & Security'
        )
    })

    it('maps a dead Mail process and timeouts', () => {
        expect(mapMailFailure("Mail got an error: Application isn't running. (-600)")).toContain('Mail is not open')
        expect(mapMailFailure('osascript timed out')).toContain('too long')
    })
})

describe('readSelectedMail', () => {
    it('returns the decoded email through the exec seam (Apple Mail)', async () => {
        const exec: OsaExec = vi.fn(async () => ({ stdout: OK_PAYLOAD }))
        const result = await readSelectedMail('mail', exec)
        expect(result.ok).toBe(true)
        expect(exec).toHaveBeenCalledWith(['-l', 'JavaScript', '-e', expect.stringContaining("Application('Mail')")])
    })

    it('routes the outlook source to the Outlook script', async () => {
        const exec: OsaExec = vi.fn(async () => ({ stdout: OK_PAYLOAD }))
        const result = await readSelectedMail('outlook', exec)
        expect(result.ok).toBe(true)
        expect(exec).toHaveBeenCalledWith([
            '-l',
            'JavaScript',
            '-e',
            expect.stringContaining("Application('Microsoft Outlook')")
        ])
    })

    it('labels Outlook errors as Outlook (with New Outlook guidance)', async () => {
        const exec: OsaExec = async () => ({
            stdout: JSON.stringify({ ok: false, code: 'no-selection' })
        })
        const result = await readSelectedMail('outlook', exec)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toContain('Outlook')
            expect(result.error).toContain('legacy')
        }
    })

    it('maps a rejected exec (permission denied) to a friendly error', async () => {
        const exec: OsaExec = async () => {
            throw new Error('Not authorized to send Apple events to Mail. (-1743)')
        }
        const result = await readSelectedMail('mail', exec)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toContain('Automation')
    })
})
