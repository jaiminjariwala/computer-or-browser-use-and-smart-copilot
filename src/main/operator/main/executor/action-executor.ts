import type { Action, ActionResult, Observation, OperatorError } from '@op-shared/types'
import { preflightAction } from '../validate'
import type { InputBackend } from './backend'
import { selectInputBackend } from './backend'

/**
 * Action Executor (Task 9.2) — the "hands" of the agent.
 *
 * Converts an already-gate-approved, typed {@link Action} into a real macOS
 * input event (Req 5.1). It runs ONLY in the privileged main process and is
 * only ever reachable THROUGH the fail-closed
 * {@link import('../safety').SafetyController} gate + a granted Accessibility
 * permission. Nothing here re-implements the gate; the gate has already decided
 * the Action may run. The executor adds the last mechanical mile:
 *
 *   1. **Validation-before-synthesis** (Property 8). The gate validated the raw
 *      image-space Action but could not map its coordinates (mapping needs the
 *      originating {@link Observation}). {@link preflightAction} (re)validates
 *      and resolves image-space coordinates to logical display points BEFORE
 *      any OS event — a structural chokepoint (Req 5.2, 5.5, 5.6).
 *   2. **Realization** through a swappable {@link InputBackend}.
 *   3. **Record every attempt** (Property 9): success, failure, or rejection all
 *      yield a recorded {@link ActionResult} plus a fresh Observation produced
 *      before the next Reasoning_Step, so a failed/unexecutable Action never
 *      advances as though it succeeded (Req 5.3, 5.4, 5.7).
 */

/** Injectable side effects so the executor is fully unit-testable headlessly. */
export interface ActionExecutorDeps {
    /**
     * The input backend to synthesize through. When `null`, only non-input
     * Actions (`screenshot`, `wait`) can succeed; any input-synthesizing Action
     * fails closed with `no-input-backend` (Req 5.4). Defaults to
     * {@link selectInputBackend}'s result at construction when omitted.
     */
    backend?: InputBackend | null
    /** Injectable clock for the recorded `executedAt` timestamp (test seam). */
    now?: () => string
    /** Bounded sleep used to realize a `wait` Action. Defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>
    /**
     * Produce a FRESH Observation after every attempt and return its id (Req
     * 5.3, 5.7 — Property 9). Typically wired to the Perception Service. When
     * omitted, no `observationAfterId` is stamped (the loop may capture itself),
     * but the result is still recorded for the attempt.
     */
    captureObservationAfter?: () => Promise<string | undefined>
    /** Surface a typed error to the Console (`error:show` channel) on failure. */
    emitError?: (error: OperatorError) => void
}

/** Per-attempt metadata the Safety gate resolved, echoed into the ActionResult. */
export interface ExecuteMeta {
    /** The High_Risk classification the gate computed (Req 9.1). */
    highRisk?: boolean
    /** Whether explicit user Confirmation was obtained (Req 9, 10). */
    confirmed?: boolean
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Executes approved Actions against an {@link InputBackend}, recording an
 * {@link ActionResult} for every attempt. Construct once (selecting a backend)
 * and reuse; {@link execute} is called by the Safety Controller for each
 * allowed Action.
 */
export class ActionExecutor {
    private readonly backend: InputBackend | null
    private readonly now: () => string
    private readonly sleep: (ms: number) => Promise<void>
    private readonly captureObservationAfter?: () => Promise<string | undefined>
    private readonly emitError?: (error: OperatorError) => void

    constructor(deps: ActionExecutorDeps = {}) {
        this.backend = deps.backend !== undefined ? deps.backend : selectInputBackend()
        this.now = deps.now ?? (() => new Date().toISOString())
        this.sleep = deps.sleep ?? defaultSleep
        this.captureObservationAfter = deps.captureObservationAfter
        this.emitError = deps.emitError
    }

    /** The active backend, or null when none is available. */
    getBackend(): InputBackend | null {
        return this.backend
    }

    /**
     * Execute one approved Action and record its outcome. NEVER throws: every
     * path — success, a pre-synthesis rejection, a mapping/off-display failure,
     * a missing backend, or a backend error — resolves to a recorded
     * {@link ActionResult}, and a fresh Observation is produced before returning
     * (Req 5.3, 5.4, 5.7 — Property 9). A failed/unexecutable Action is recorded
     * with a non-`success` status so the loop never advances it as a success.
     *
     * @param rawAction   the gate-approved Action in ORIGINATING image space
     * @param observation the Observation the Action was derived from (for mapping)
     * @param meta        risk/confirmation metadata resolved by the gate
     */
    async execute(
        rawAction: Action,
        observation: Observation,
        meta: ExecuteMeta = {}
    ): Promise<ActionResult> {
        const executedAt = this.now()
        const highRisk = meta.highRisk ?? false

        // 1. Validate + map coordinates BEFORE any OS event (Property 8).
        const pre = preflightAction(rawAction, observation)
        if (!pre.ok) {
            // A validation-stage refusal is a reject-before-input (Req 5.5);
            // a mapping-stage refusal (off-display / incomplete Observation) is
            // a valid-but-unexecutable Action recorded as a failure (Req 5.4).
            const status: ActionResult['status'] =
                pre.stage === 'validation' ? 'rejected' : 'failure'
            const errorKind: OperatorError['kind'] =
                status === 'rejected' ? 'action-rejected' : 'action-failed'
            this.emitError?.({
                kind: errorKind,
                message: pre.detail,
                recoverable: true,
                action: 'retry'
            })
            return this.finish({ status, reason: pre.detail, highRisk, confirmed: meta.confirmed, executedAt })
        }

        // 2. Realize the mapped Action through the backend (Req 5.1).
        try {
            await this.dispatch(pre.action)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            this.emitError?.({
                kind: 'action-failed',
                message: `Action "${pre.action.kind}" failed: ${reason}`,
                recoverable: true,
                action: 'retry'
            })
            return this.finish({
                status: 'failure',
                reason,
                highRisk,
                confirmed: meta.confirmed,
                executedAt
            })
        }

        // 3. Success.
        return this.finish({ status: 'success', highRisk, confirmed: meta.confirmed, executedAt })
    }

    /**
     * Dispatch a validated-and-mapped Action to the right backend primitive.
     * `screenshot` needs no input event (Perception handles it) and `wait` is a
     * bounded timed no-op; both succeed without a backend. Every other kind
     * requires the backend — a missing backend throws, recorded as a failure.
     */
    private async dispatch(action: Action): Promise<void> {
        switch (action.kind) {
            case 'screenshot':
                // No input event; the fresh Observation produced by finish()
                // realizes the screenshot request.
                return
            case 'wait':
                await this.sleep(action.ms)
                return
            case 'mouse_move':
                await this.requireBackend().mouseMove(action.at)
                return
            case 'left_click':
                await this.requireBackend().click(action.at, 'left', 1)
                return
            case 'right_click':
                await this.requireBackend().click(action.at, 'right', 1)
                return
            case 'double_click':
                await this.requireBackend().click(action.at, 'left', 2)
                return
            case 'drag':
                await this.requireBackend().drag(action.from, action.to)
                return
            case 'type':
                await this.requireBackend().typeText(action.text)
                return
            case 'key':
                await this.requireBackend().key(action.keys)
                return
            case 'scroll':
                await this.requireBackend().scroll(action.at, action.dx, action.dy)
                return
            default: {
                // Exhaustiveness guard: an unhandled kind fails closed.
                const _never: never = action
                void _never
                throw new Error('Unhandled Action kind')
            }
        }
    }

    /** Return the backend or throw a fail-closed error if none is available. */
    private requireBackend(): InputBackend {
        if (!this.backend) {
            throw new Error(
                'no-input-backend: neither the native CGEvent addon nor cliclick is available'
            )
        }
        return this.backend
    }

    /**
     * Finalize an attempt: capture a fresh Observation (Property 9) and assemble
     * the {@link ActionResult}. The capture is best-effort — a capture failure
     * here does not turn a successful Action into a failure; it simply leaves
     * `observationAfterId` unset for the loop to handle.
     */
    private async finish(partial: {
        status: ActionResult['status']
        reason?: string
        highRisk: boolean
        confirmed?: boolean
        executedAt: string
    }): Promise<ActionResult> {
        let observationAfterId: string | undefined
        if (this.captureObservationAfter) {
            try {
                observationAfterId = await this.captureObservationAfter()
            } catch {
                observationAfterId = undefined
            }
        }
        const result: ActionResult = {
            status: partial.status,
            highRisk: partial.highRisk,
            executedAt: partial.executedAt
        }
        if (partial.reason !== undefined) result.reason = partial.reason
        if (partial.confirmed !== undefined) result.confirmed = partial.confirmed
        if (observationAfterId !== undefined) result.observationAfterId = observationAfterId
        return result
    }
}

/** Construct an {@link ActionExecutor} with the given deps. */
export function createActionExecutor(deps: ActionExecutorDeps = {}): ActionExecutor {
    return new ActionExecutor(deps)
}
