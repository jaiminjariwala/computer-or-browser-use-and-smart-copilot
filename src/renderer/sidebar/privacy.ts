/** Shared renderer-only detection/redaction for text that must not be retained or echoed. */

const LABELED_SECRET_PATTERN =
    /\b(api[-_ ]?key|access[-_ ]?token|auth(?:orization)?|password|passcode|secret|private key|seed phrase|recovery code)\b\s*[:=#-]?\s*[^\s,;]+/gi

const LABELED_SHORT_CODE_PATTERN =
    /\b(otp|pin|one[- ]?time (?:password|code)|verification code|security code|access code)\b\s*(?:(?:is|equals)\s+|[:=#-]\s*)?\d{4,10}\b/gi

const PROVIDER_TOKEN_PATTERN =
    /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{16,})\b/g

const SENSITIVE_MARKER_PATTERN =
    /\b(password|passcode|pin|otp|one[- ]?time (?:password|code)|verification code|security code|access code|secret|bearer|token|api[-_ ]?key|credential|private key|seed phrase|recovery code|social security|ssn|credit card|card number|cvv|bank account|routing number)\b|[?&](token|secret|password|code)=/i

/** Redact common secrets and identifiers while preserving enough prose for context. */
export function redactSensitiveText(value: string): string {
    let safe = value
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(LABELED_SECRET_PATTERN, '$1=[redacted]')
        .replace(LABELED_SHORT_CODE_PATTERN, '$1 [redacted code]')
        .replace(PROVIDER_TOKEN_PATTERN, '[redacted token]')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted identifier]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted token]')
    safe = redactPaymentCards(safe)
    return safe
}

/** True when text should not be retained as a reusable recent goal. */
export function containsSensitiveText(value: string): boolean {
    return SENSITIVE_MARKER_PATTERN.test(value) || redactSensitiveText(value).includes('[redacted')
}

function redactPaymentCards(value: string): string {
    return value.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) => {
        const digits = candidate.replace(/\D/g, '')
        return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
            ? '[redacted payment card]'
            : candidate
    })
}

function passesLuhn(digits: string): boolean {
    let sum = 0
    let doubleDigit = false
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index])
        if (doubleDigit) {
            digit *= 2
            if (digit > 9) digit -= 9
        }
        sum += digit
        doubleDigit = !doubleDigit
    }
    return sum > 0 && sum % 10 === 0
}
