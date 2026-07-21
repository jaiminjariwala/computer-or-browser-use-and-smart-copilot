import { execFile } from 'node:child_process'
import type { MailReadResult, SelectedEmail } from '@shared/types'

/**
 * Mail connector: read the message currently SELECTED in Apple Mail.
 *
 * The OpenClaw lesson applied to a screen-first app: when a real API exists,
 * use it instead of pixels. For "help me with this email", AppleScript (JXA)
 * hands us the exact sender/subject/body — no OCR, no cropped screenshots.
 *
 * Consent + privacy: the FIRST call triggers the macOS Automation prompt
 * ("… wants to control Mail"), and the user can revoke it anytime in System
 * Settings → Privacy & Security → Automation. We read only the selection —
 * never the mailbox — and only when the user clicks the attach action. The
 * packaged app declares NSAppleEventsUsageDescription for this prompt.
 *
 * The osascript execution is seam-injected so every mapping path unit-tests
 * in plain Node.
 */

/** Body length cap: keep one email from flooding the model's context. */
const MAX_BODY_CHARS = 20_000

/**
 * JXA (JavaScript for Automation) — more robust than AppleScript string
 * concatenation because the payload comes back as one JSON document.
 */
const READ_SELECTION_SCRIPT = `(() => {
    const Mail = Application('Mail');
    if (!Mail.running()) { return JSON.stringify({ ok: false, code: 'not-running' }); }
    const selection = Mail.selection();
    if (!selection || selection.length === 0) { return JSON.stringify({ ok: false, code: 'no-selection' }); }
    const msg = selection[0];
    const str = (v) => { try { const out = v(); return out === null || out === undefined ? '' : String(out); } catch (e) { return ''; } };
    return JSON.stringify({
        ok: true,
        subject: str(() => msg.subject()),
        sender: str(() => msg.sender()),
        receivedAt: str(() => msg.dateReceived()),
        body: str(() => msg.content())
    });
})()`

/**
 * Microsoft Outlook (desktop) variant. Same JSON contract as the Mail script.
 * Outlook's `sender` comes back as a record ({ name, address }), and the body
 * is read as plain text with an HTML-content fallback. NOTE: Microsoft's "New
 * Outlook" shipped with a gutted automation dictionary — `selectedObjects`
 * may return nothing there even with a message open; the error copy points
 * users at legacy mode when that happens.
 */
const READ_OUTLOOK_SELECTION_SCRIPT = `(() => {
    const Outlook = Application('Microsoft Outlook');
    if (!Outlook.running()) { return JSON.stringify({ ok: false, code: 'not-running' }); }
    let selection = [];
    try { selection = Outlook.selectedObjects(); } catch (e) { selection = []; }
    if (!selection || selection.length === 0) { return JSON.stringify({ ok: false, code: 'no-selection' }); }
    const msg = selection[0];
    const str = (v) => { try { const out = v(); return out === null || out === undefined ? '' : String(out); } catch (e) { return ''; } };
    const senderOf = (m) => {
        try {
            const s = m.sender();
            if (s && typeof s === 'object') {
                const name = s.name ? String(s.name) : '';
                const address = s.address ? String(s.address) : '';
                if (name && address) { return name + ' <' + address + '>'; }
                return name || address;
            }
            return s === null || s === undefined ? '' : String(s);
        } catch (e) { return ''; }
    };
    const body = str(() => msg.plainTextContent()) || str(() => msg.content());
    return JSON.stringify({
        ok: true,
        subject: str(() => msg.subject()),
        sender: senderOf(msg),
        receivedAt: str(() => msg.timeReceived()),
        body: body
    });
})()`

/** Exec seam (tests inject a fake; production runs osascript). */
export type OsaExec = (args: string[]) => Promise<{ stdout: string }>

const defaultExec: OsaExec = (args) =>
    new Promise((resolve, reject) => {
        execFile(
            'osascript',
            args,
            { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr?.toString() || error.message))
                    return
                }
                resolve({ stdout: stdout.toString() })
            }
        )
    })

/** Map an osascript failure to a message a user can act on. */
export function mapMailFailure(detail: string, appLabel = 'Mail'): string {
    const text = detail.toLowerCase()
    if (/-1743|not authori[sz]ed|errAEEventNotPermitted/i.test(detail)) {
        return `Permission needed: allow this app to control ${appLabel} in System Settings → Privacy & Security → Automation, then try again.`
    }
    if (text.includes('timed out') || text.includes('timeout')) {
        return `${appLabel} took too long to answer. Make sure ${appLabel} is responsive and try again.`
    }
    if (text.includes('application isn\u2019t running') || text.includes("application isn't running") || text.includes('-600')) {
        return `${appLabel} is not open. Open ${appLabel} and select the message you want help with.`
    }
    return `Could not read the selected email from ${appLabel}. ${detail}`.trim()
}

/** Interpret the JXA payload into a typed result. */
export function decodeMailPayload(stdout: string, appLabel = 'Mail'): MailReadResult {
    let parsed: unknown
    try {
        parsed = JSON.parse(stdout.trim())
    } catch {
        return { ok: false, error: `${appLabel} returned an unreadable response.` }
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, error: `${appLabel} returned an unreadable response.` }
    }
    const p = parsed as Record<string, unknown>
    if (p.ok !== true) {
        if (p.code === 'not-running') {
            return {
                ok: false,
                error: `${appLabel} is not open. Open ${appLabel} and select the message you want help with.`
            }
        }
        if (p.code === 'no-selection') {
            return {
                ok: false,
                error:
                    appLabel === 'Outlook'
                        ? 'No email is selected in Outlook. Click the message first, then attach it. (If it still fails, "New Outlook" limits automation — View menu → toggle to legacy Outlook, or use Outlook on the web via Browser Use.)'
                        : `No email is selected in ${appLabel}. Click the message first, then attach it.`
            }
        }
        return { ok: false, error: `Could not read the selected email from ${appLabel}.` }
    }
    const body = typeof p.body === 'string' ? p.body : ''
    const email: SelectedEmail = {
        subject: typeof p.subject === 'string' && p.subject.length > 0 ? p.subject : '(no subject)',
        sender: typeof p.sender === 'string' ? p.sender : '',
        receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : '',
        body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[…email truncated]` : body
    }
    return { ok: true, email }
}

/** Which desktop mail app to read the selection from. */
export type MailSource = 'mail' | 'outlook'

const SOURCES: Record<MailSource, { script: string; label: string }> = {
    mail: { script: READ_SELECTION_SCRIPT, label: 'Mail' },
    outlook: { script: READ_OUTLOOK_SELECTION_SCRIPT, label: 'Outlook' }
}

/** Read the currently selected message in Mail or Outlook (main process only). */
export async function readSelectedMail(
    source: MailSource = 'mail',
    exec: OsaExec = defaultExec
): Promise<MailReadResult> {
    const target = SOURCES[source] ?? SOURCES.mail
    try {
        const { stdout } = await exec(['-l', 'JavaScript', '-e', target.script])
        return decodeMailPayload(stdout, target.label)
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, error: mapMailFailure(detail, target.label) }
    }
}
