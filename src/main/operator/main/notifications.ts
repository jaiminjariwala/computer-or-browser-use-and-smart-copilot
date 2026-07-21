import { Notification } from 'electron'
import type { ConfirmationRequest, LoopStateView, TrajectoryStepView } from '@op-shared/types'

/**
 * macOS Notification Center pings for long-running operator tasks.
 *
 * Browser/computer-use tasks run for minutes while the user works elsewhere;
 * without a ping, a finished (or stuck-waiting) task just sits silently in the
 * window. The notifier surfaces the four moments that matter:
 *
 *  - task completed (with the model's summary),
 *  - task failed,
 *  - the agent asked the user a question (help),
 *  - the agent needs a confirmation before a risky action.
 *
 * Notifications fire ONLY while the console window is unfocused — a user
 * watching the run does not need a banner for what they can see. Clicking a
 * notification focuses the console.
 *
 * The Electron `Notification` surface is injected so the logic is unit-testable
 * in a plain Node environment (where the `electron` import has no bindings).
 */

/** A rendered notification: what the user sees in Notification Center. */
export interface TaskNotification {
    title: string
    body: string
}

/** Truncate body copy so banners stay scannable. */
function clip(text: string, max = 140): string {
    const t = text.trim().replace(/\s+/g, ' ')
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Completion steps carry the model's summary as their rationale. */
export function notificationForStep(step: TrajectoryStepView): TaskNotification | null {
    if (step.outcome !== 'completion') return null
    return {
        title: 'Task complete',
        body: clip(step.rationale || 'The agent finished your task.')
    }
}

/** Terminal `failed` state → one honest banner. `stopped` is user-initiated: silent. */
export function notificationForState(view: LoopStateView): TaskNotification | null {
    if (view.state !== 'failed') return null
    return {
        title: 'Task could not be completed',
        body: `The agent stopped after ${view.stepCount} step${view.stepCount === 1 ? '' : 's'}. Open the app for details.`
    }
}

/** The agent asked the user a question (help outcome). */
export function notificationForHelp(question: string): TaskNotification {
    return {
        title: 'The agent needs your input',
        body: clip(question || 'Open the app to answer the agent’s question.')
    }
}

/** The agent is waiting on a confirmation before a (possibly risky) action. */
export function notificationForConfirmation(req: ConfirmationRequest): TaskNotification {
    return {
        title: req.highRisk ? 'Confirmation needed (high-risk action)' : 'Confirmation needed',
        body: clip(req.rationale || 'The agent is waiting for your approval to continue.')
    }
}

export interface TaskNotifierDeps {
    /** True when the console window is focused (banner suppressed). */
    isWindowFocused: () => boolean
    /** Bring the console to the front (notification click). */
    focusWindow: () => void
    /** Presentation seam; defaults to Electron's Notification. */
    present?: (n: TaskNotification, onClick: () => void) => void
    /** Support probe seam; defaults to Electron's Notification.isSupported. */
    isSupported?: () => boolean
}

export interface TaskNotifier {
    onStepAppended(step: TrajectoryStepView): void
    onStateChanged(view: LoopStateView): void
    onHelpRequired(question: string): void
    onConfirmationRequired(req: ConfirmationRequest): void
}

/** Default presenter: a real Notification Center banner. */
function presentWithElectron(n: TaskNotification, onClick: () => void): void {
    const banner = new Notification({ title: n.title, body: n.body, silent: false })
    banner.on('click', onClick)
    banner.show()
}

/**
 * Fire-and-forget banner for one-off events (e.g. a scheduled run starting).
 * Best-effort and guarded: silently a no-op where notifications are
 * unsupported (tests, headless CI).
 */
export function presentNotification(n: TaskNotification): void {
    try {
        if (typeof Notification !== 'function' || !Notification.isSupported()) return
        new Notification({ title: n.title, body: n.body, silent: false }).show()
    } catch {
        // best-effort
    }
}

function electronSupported(): boolean {
    return typeof Notification === 'function' && Notification.isSupported()
}

/** Create the notifier used by the loop emitters in the main process. */
export function createTaskNotifier(deps: TaskNotifierDeps): TaskNotifier {
    const present = deps.present ?? presentWithElectron
    const isSupported = deps.isSupported ?? electronSupported

    const deliver = (n: TaskNotification | null): void => {
        if (!n) return
        // A user looking at the window needs no banner for what they can see.
        if (deps.isWindowFocused()) return
        try {
            if (!isSupported()) return
            present(n, deps.focusWindow)
        } catch {
            // Notifications are best-effort; never let them break the loop.
        }
    }

    return {
        onStepAppended: (step) => deliver(notificationForStep(step)),
        onStateChanged: (view) => deliver(notificationForState(view)),
        onHelpRequired: (question) => deliver(notificationForHelp(question)),
        onConfirmationRequired: (req) => deliver(notificationForConfirmation(req))
    }
}
