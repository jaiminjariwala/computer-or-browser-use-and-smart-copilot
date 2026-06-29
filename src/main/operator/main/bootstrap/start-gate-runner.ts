import { shell } from 'electron'
import type { OperatorError, StartGoalInput, StartResult } from '@op-shared/types'
import { isBlankGoal } from '../session'
import { emitError, emitPermissionChanged } from '../ipc'
import { evaluateOperatorStartGate, emptyGoalError } from '../start-gate'
import type { OperatorServices } from './services'

/**
 * Open the exact macOS System Settings pane for a permission error, so the user
 * lands right where they can grant it instead of hunting through Settings. In
 * dev the app runs under the Electron binary, so the pane may list it as
 * "Electron" rather than "Click Copilot" — that's the entry to enable.
 */
function openSettingsForError(error: OperatorError): void {
    const pane =
        error.action === 'open-accessibility-settings'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
            : error.action === 'open-screen-settings'
                ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
                : null
    if (pane) void shell.openExternal(pane)
}

/**
 * The `goal:start` handler — the design's **start gate** (design "Agent Loop
 * State Machine", `idle → perceiving`).
 *
 * A run begins ONLY on an explicit user start AND when the full precondition set
 * holds simultaneously (fail-closed):
 *
 *  - a non-empty Goal (Req 1.2),
 *  - the Emergency_Stop hotkey is registered (Req 7.7),
 *  - Screen Recording AND Accessibility are granted (Req 16.1, 17.1),
 *  - a Model_Provider / credentials are present (Req 15.7, 21.10),
 *  - the Autonomy_Level + Step_Budget are associated with the Goal (Req 1.3,
 *    1.5 — enforced by `SessionManager.createSession`), and
 *  - the Control_Indicator can be displayed (Req 12.4).
 *
 * The pure environmental precondition assembly lives in `start-gate.ts`; this
 * factory gathers the live signals, runs that gate, creates the session, and
 * only then calls `loop.start()`.
 */
export function createStartGoalHandler(
    services: OperatorServices
): (input: StartGoalInput) => Promise<StartResult> {
    const { consoleWindow, readPermissions, configStore, safety, sessionManager, loop } = services

    return async (input: StartGoalInput): Promise<StartResult> => {
        const win = consoleWindow()

        // Goal must be present (Req 1.2) — prompt to enter a Goal.
        if (isBlankGoal(input.goal)) {
            const error = emptyGoalError()
            emitError(win, error)
            return { ok: false, error }
        }

        const environment = input.environment ?? 'local'

        // Environmental start gate: hotkey (7.7), permissions (16.1/17.1),
        // credentials/provider (15.7/21.10), indicator (12.4).
        const permissions = readPermissions()
        emitPermissionChanged(win, permissions)
        // The sandboxed browser needs no macOS Screen Recording / Accessibility,
        // so the permission clause is satisfied for it (Req 22.5). The real
        // permissions are still reported to the UI above.
        const gatePermissions =
            environment === 'local'
                ? permissions
                : ({ screenRecording: 'granted', accessibility: 'granted' } as const)
        const credentialGate = await configStore.evaluateStartGate()
        const hotkeyResult = safety.getHotkeyResult()
        const gate = evaluateOperatorStartGate({
            hotkeyBlocksStart: safety.hotkeyBlocksSessionStart(),
            hotkeyError: hotkeyResult?.error,
            hotkeyAccelerator: hotkeyResult?.accelerator,
            permissions: gatePermissions,
            credentialGate,
            // The overlay is created on demand; a failure to show is caught by
            // the indicator emitter and halts the loop, so start assumes it can
            // be displayed here.
            indicatorAvailable: true
        })
        if (!gate.ok) {
            emitError(win, gate.error)
            if (
                gate.error.kind === 'credentials-missing' ||
                gate.error.kind === 'no-provider-configured'
            ) {
                win?.webContents.send('op:credentials:required')
            }
            // A missing/revoked permission → open the exact Settings pane so the
            // user can grant it in one click (Accessibility for input control,
            // Screen Recording for capture).
            if (
                gate.error.kind === 'permission-missing' ||
                gate.error.kind === 'permission-revoked'
            ) {
                openSettingsForError(gate.error)
            }
            return { ok: false, error: gate.error }
        }

        // Create the session: records the Goal and associates the Autonomy_Level
        // + Step_Budget BEFORE any Action (Req 1.1, 1.3, 1.5). Preserves any prior
        // session via the archive hook (Req 18.4).
        const created = sessionManager.createSession(input)
        if (!created.ok) {
            if (created.reason === 'empty-goal') {
                const error = emptyGoalError()
                emitError(win, error)
                return { ok: false, error }
            }
            emitError(win, created.error)
            return { ok: false, error: created.error }
        }

        // Activate the selected Execution_Environment (Req 22.2) BEFORE starting
        // — this boots the sandboxed browser when chosen. A failure to bring the
        // environment up fails closed with a surfaced error.
        try {
            await services.selectEnvironment(environment)
            // Show the live desktop in its own window for the container backend;
            // close it for the others so the Console stays uncluttered.
            if (environment === 'container-desktop') services.openDesktopView()
            else services.closeDesktopView()
        } catch (err) {
            const error = {
                kind: 'capture-failed' as const,
                message: `Could not start the ${environment} environment: ${err instanceof Error ? err.message : String(err)
                    }`,
                recoverable: true,
                action: 'retry' as const
            }
            emitError(win, error)
            return { ok: false, error }
        }

        // Every precondition holds → start the loop (idle → perceiving). The
        // promise resolves when the loop next suspends or terminates; we do not
        // await it so the IPC call returns promptly.
        void loop.start()
        return { ok: true, sessionId: created.session.id }
    }
}
