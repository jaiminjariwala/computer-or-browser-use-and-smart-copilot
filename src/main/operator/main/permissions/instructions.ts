/**
 * System Settings instructions + deep-links for the two macOS permissions the
 * operator needs (Screen Recording and Accessibility).
 *
 * macOS never lets an app flip a privacy toggle itself, so whenever a permission
 * is not granted we hand the user a heading, ordered steps, and a deep link that
 * jumps straight to the relevant Privacy & Security pane. The wording differs
 * for a first-time grant versus re-enabling after a revocation.
 */

/**
 * A user-facing payload describing how to grant (or re-grant) a permission in
 * macOS System Settings. Used by both permissions; each supplies its own
 * heading, steps, and deep link.
 */
export interface SystemSettingsInstructions {
    /** Short heading for the instructions surface. */
    title: string
    /** Ordered, human-readable steps the user should follow. */
    steps: string[]
    /** Deep link that opens the relevant System Settings pane. */
    settingsUrl: string
}

/**
 * Alias kept for the extended two-permission service. Structurally identical to
 * {@link SystemSettingsInstructions}; both names are part of the public API.
 */
export type PermissionInstructions = SystemSettingsInstructions

/** Which macOS permission an evaluation refers to. */
export type PermissionKind = 'screen-recording' | 'accessibility'

/** Deep link to the Screen Recording pane in macOS System Settings. */
export const SCREEN_RECORDING_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** Deep link to the Accessibility pane in macOS System Settings. */
export const ACCESSIBILITY_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/**
 * Build the Screen Recording System Settings instructions. The wording differs
 * for a first-time grant versus re-granting after a revocation.
 */
export function buildScreenSettingsInstructions(
    previouslyGranted: boolean
): SystemSettingsInstructions {
    if (previouslyGranted) {
        return {
            title: 'Re-enable Screen Recording for Computer or Browser Use',
            steps: [
                'Open System Settings > Privacy & Security > Screen Recording.',
                'Turn the toggle for the app (shown as "Electron" in dev) back on.',
                'If prompted, quit and reopen the app so the change takes effect.',
                'Try the capture again.'
            ],
            settingsUrl: SCREEN_RECORDING_SETTINGS_URL
        }
    }

    return {
        title: 'Allow Screen Recording for Computer or Browser Use',
        steps: [
            'Open System Settings > Privacy & Security > Screen Recording.',
            'Find the app (shown as "Electron" in dev) in the list and turn its toggle on.',
            'If prompted, quit and reopen the app so the change takes effect.',
            'Trigger the capture again once enabled.'
        ],
        settingsUrl: SCREEN_RECORDING_SETTINGS_URL
    }
}

/**
 * Build the System Settings instructions for a given permission + phase. Screen
 * Recording reuses {@link buildScreenSettingsInstructions} so the two surfaces
 * stay consistent; Accessibility supplies its own wording and deep link.
 */
export function buildPermissionInstructions(
    kind: PermissionKind,
    previouslyGranted: boolean
): PermissionInstructions {
    if (kind === 'screen-recording') {
        return buildScreenSettingsInstructions(previouslyGranted)
    }

    if (previouslyGranted) {
        return {
            title: 'Re-enable Accessibility for Computer or Browser Use',
            steps: [
                'Open System Settings > Privacy & Security > Accessibility.',
                'Turn the toggle for the app (shown as "Electron" in dev) back on.',
                'If prompted, quit and reopen the app so the change takes effect.',
                'Resume the session once Accessibility is enabled.'
            ],
            settingsUrl: ACCESSIBILITY_SETTINGS_URL
        }
    }

    return {
        title: 'Allow Accessibility for Computer or Browser Use',
        steps: [
            'Open System Settings > Privacy & Security > Accessibility.',
            'Find the app (shown as "Electron" in dev) in the list and turn its toggle on.',
            'If prompted, quit and reopen the app so the change takes effect.',
            'Start the session again once Accessibility is enabled.'
        ],
        settingsUrl: ACCESSIBILITY_SETTINGS_URL
    }
}
