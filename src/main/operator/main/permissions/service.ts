/**
 * The extended two-permission service (Screen Recording + Accessibility).
 *
 * The vendored `screen.ts` handles Screen Recording alone (legacy GlassError
 * shape). Click Operator needs BOTH macOS permissions:
 *
 *   - Screen Recording (Perception) — getMediaAccessStatus('screen')
 *   - Accessibility  (input synthesis) — isTrustedAccessibilityClient(false)
 *
 * This layer wraps both behind an injectable {@link OSPermissionProbe}, reports
 * a {@link PermissionSnapshot}, and maps every status to the correct
 * fail-closed flow: not granted => block session start (Req 16.1, 17.1) and
 * execute no Action (Req 17.4). Because the OS calls sit behind the probe, the
 * whole layer is unit-testable headlessly on any platform.
 *
 * _Requirements: 16.1, 16.2, 16.3, 17.1, 17.2, 17.3, 17.4_
 */

import { systemPreferences } from 'electron'
import type { OperatorError, PermissionSnapshot, PermissionStatus } from '@op-shared/types'
import { normalizeScreenStatus } from './screen'
import { accessibilityTrustToStatus } from './accessibility'
import {
    buildPermissionInstructions,
    type PermissionInstructions,
    type PermissionKind
} from './instructions'

/**
 * The OS-facing calls this service depends on, behind an interface so tests can
 * run on any platform by injecting a fake. The default implementation
 * ({@link createElectronPermissionProbe}) is the only place that touches
 * Electron's `systemPreferences`.
 */
export interface OSPermissionProbe {
    /** Screen Recording status via `getMediaAccessStatus('screen')`. */
    getScreenRecordingStatus(): PermissionStatus
    /** Accessibility trust via `isTrustedAccessibilityClient(false)` (no prompt). */
    getAccessibilityStatus(): PermissionStatus
}

/**
 * The default OS probe backed by Electron's `systemPreferences`. Prefers the
 * no-prompt `isTrustedAccessibilityClient(false)` query where available and
 * degrades to not-granted when the API is missing (e.g. non-macOS).
 */
export function createElectronPermissionProbe(): OSPermissionProbe {
    return {
        getScreenRecordingStatus(): PermissionStatus {
            return normalizeScreenStatus(systemPreferences.getMediaAccessStatus('screen'))
        },
        getAccessibilityStatus(): PermissionStatus {
            const fn = (
                systemPreferences as unknown as {
                    isTrustedAccessibilityClient?: (prompt: boolean) => boolean
                }
            ).isTrustedAccessibilityClient
            const trusted = typeof fn === 'function' ? fn.call(systemPreferences, false) : false
            return accessibilityTrustToStatus(trusted)
        }
    }
}

/** A permission is usable only when it is exactly `granted` (fail-closed). */
export function isGranted(status: PermissionStatus): boolean {
    return status === 'granted'
}

/** The evaluated flow for a single permission's current status. */
export interface PermissionEvaluation {
    /** Which permission this refers to. */
    kind: PermissionKind
    /** The raw status reported by the OS. */
    status: PermissionStatus
    /** True only when `status === 'granted'`. */
    granted: boolean
    /** Present when not granted: the typed failure to surface to the user. */
    error?: OperatorError
    /** Present when not granted: how to grant/re-grant in System Settings. */
    instructions?: PermissionInstructions
}

/** Options influencing how a non-granted status is classified per permission. */
export interface PermissionEvaluationOptions {
    /**
     * Whether this permission was previously granted this session. When true, a
     * later non-granted status is treated as a *revocation* (Req 16.3, 17.3)
     * rather than a first-time missing permission (Req 16.1, 17.1).
     */
    previouslyGranted?: boolean
}

/** The System Settings recovery action to offer for a given permission. */
function settingsActionFor(kind: PermissionKind): OperatorError['action'] {
    return kind === 'screen-recording' ? 'open-screen-settings' : 'open-accessibility-settings'
}

/** Human-readable failure message for a permission + phase. */
function permissionMessage(kind: PermissionKind, previouslyGranted: boolean): string {
    const name = kind === 'screen-recording' ? 'Screen Recording' : 'Accessibility'
    const need =
        kind === 'screen-recording'
            ? 'capture your screen'
            : 'control your computer with synthesized input events'
    return previouslyGranted
        ? `${name} permission was turned off, so Computer or Browser Use cannot ${need}. Re-enable it in System Settings to continue.`
        : `Computer or Browser Use needs ${name} permission to ${need}. Enable it in System Settings to continue.`
}

/**
 * Map a single permission's status to its application flow (pure).
 *
 * `granted` yields an allow result; every other value yields a not-granted
 * result carrying a `permission-missing` / `permission-revoked`
 * {@link OperatorError} plus System Settings instructions. This is the single
 * status→flow mapping used by both the start gate and revocation detection.
 */
export function evaluatePermission(
    kind: PermissionKind,
    status: PermissionStatus,
    options: PermissionEvaluationOptions = {}
): PermissionEvaluation {
    if (isGranted(status)) {
        return { kind, status, granted: true }
    }

    const previouslyGranted = options.previouslyGranted ?? false
    const instructions = buildPermissionInstructions(kind, previouslyGranted)
    const error: OperatorError = {
        kind: previouslyGranted ? 'permission-revoked' : 'permission-missing',
        message: permissionMessage(kind, previouslyGranted),
        recoverable: true,
        action: settingsActionFor(kind)
    }
    return { kind, status, granted: false, error, instructions }
}

/**
 * Read both permissions from the OS and return a {@link PermissionSnapshot}.
 * The probe defaults to the Electron-backed implementation but is injectable
 * for tests. _(Req 16, 17)_
 */
export function getPermissionSnapshot(
    probe: OSPermissionProbe = createElectronPermissionProbe()
): PermissionSnapshot {
    return {
        screenRecording: probe.getScreenRecordingStatus(),
        accessibility: probe.getAccessibilityStatus()
    }
}

/**
 * The fail-closed start-gate decision derived from a {@link PermissionSnapshot}.
 *
 * A session may only start when BOTH permissions are granted: Screen Recording
 * gates Perception (Req 16.1) and Accessibility gates every Action (Req 17.1,
 * 17.4). `canCapture` / `canExecuteActions` expose the per-capability gates the
 * Safety Controller consumes, and `blockers` carries the instructions/errors to
 * surface for whatever is missing.
 */
export interface StartGateDecision {
    /** True only when both permissions are granted. */
    canStartSession: boolean
    /** Screen Recording granted → Perception may capture (Req 16.2). */
    canCapture: boolean
    /** Accessibility granted → Actions may execute (Req 17.2, 17.4). */
    canExecuteActions: boolean
    /** Non-granted permissions with their errors + instructions. */
    blockers: PermissionEvaluation[]
}

/** Per-permission options for the start gate (was each previously granted?). */
export interface StartGateOptions {
    screenPreviouslyGranted?: boolean
    accessibilityPreviouslyGranted?: boolean
}

/**
 * Evaluate the fail-closed permission start gate over a snapshot. Blocks
 * session start unless BOTH permissions are granted and returns the
 * per-capability gates + the blockers to surface. _(Req 16.1, 17.1, 17.4)_
 */
export function evaluateStartGate(
    snapshot: PermissionSnapshot,
    options: StartGateOptions = {}
): StartGateDecision {
    const screen = evaluatePermission('screen-recording', snapshot.screenRecording, {
        previouslyGranted: options.screenPreviouslyGranted
    })
    const accessibility = evaluatePermission('accessibility', snapshot.accessibility, {
        previouslyGranted: options.accessibilityPreviouslyGranted
    })

    const blockers = [screen, accessibility].filter((e) => !e.granted)

    return {
        canStartSession: screen.granted && accessibility.granted,
        canCapture: screen.granted,
        canExecuteActions: accessibility.granted,
        blockers
    }
}

/** The result of a mid-session revocation re-check for both permissions. */
export interface RevocationResult {
    /** True when Screen Recording went granted → not-granted (Req 16.3). */
    screenRevoked: boolean
    /** True when Accessibility went granted → not-granted (Req 17.3). */
    accessibilityRevoked: boolean
    /** True when any permission was revoked → the loop must pause. */
    revoked: boolean
    /** Re-grant evaluations (with re-enable instructions) for what was revoked. */
    evaluations: PermissionEvaluation[]
}

/**
 * Detect mid-session revocation by comparing a prior snapshot against a fresh
 * one. A permission counts as revoked only when it was granted before and is no
 * longer granted now; each revoked permission yields a `permission-revoked`
 * evaluation carrying re-grant instructions.
 *
 * This backs Req 16.3 (revocation detected on the next Perception attempt) and
 * Req 17.3 (revocation detected on the next Action attempt): the caller passes
 * the last-known snapshot and a freshly probed one.
 */
export function detectRevocation(
    previous: PermissionSnapshot,
    current: PermissionSnapshot
): RevocationResult {
    const screenRevoked = isGranted(previous.screenRecording) && !isGranted(current.screenRecording)
    const accessibilityRevoked =
        isGranted(previous.accessibility) && !isGranted(current.accessibility)

    const evaluations: PermissionEvaluation[] = []
    if (screenRevoked) {
        evaluations.push(
            evaluatePermission('screen-recording', current.screenRecording, {
                previouslyGranted: true
            })
        )
    }
    if (accessibilityRevoked) {
        evaluations.push(
            evaluatePermission('accessibility', current.accessibility, { previouslyGranted: true })
        )
    }

    return {
        screenRevoked,
        accessibilityRevoked,
        revoked: screenRevoked || accessibilityRevoked,
        evaluations
    }
}

/**
 * Re-check a single permission against the OS on demand (mid-session), mapping
 * its current status to the correct missing/revoked flow. Convenience wrapper
 * used on the next Perception (Req 16.3) or Action (Req 17.3) attempt.
 */
export function recheckPermission(
    kind: PermissionKind,
    options: PermissionEvaluationOptions = {},
    probe: OSPermissionProbe = createElectronPermissionProbe()
): PermissionEvaluation {
    const status =
        kind === 'screen-recording'
            ? probe.getScreenRecordingStatus()
            : probe.getAccessibilityStatus()
    return evaluatePermission(kind, status, options)
}
