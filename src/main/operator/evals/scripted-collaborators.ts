import { isDeepStrictEqual } from 'node:util'
import {
    isAction,
    type Action,
    type ActionResult,
    type Observation,
    type ReasoningContext,
    type RoutedOutcome
} from '@op-shared/types'
import type {
    LoopExecuteMeta,
    LoopExecutor,
    LoopPerception,
    LoopReasoning,
    LoopSafetyGate
} from '../main/loop'
import type { PerceptionResult } from '../main/perception'
import type {
    BlockReason,
    ExternalGateInputs,
    GateBlocked,
    GateDecision
} from '../main/safety'
import type { ScriptedActionResult, ScriptedSafetyMode } from './types'

export class DeterministicClock {
    private currentMs: number

    constructor(startMs: number) {
        this.currentMs = startMs
    }

    now = (): string => new Date(this.currentMs).toISOString()

    advance(ms: number): void {
        this.currentMs += ms
    }

    get value(): number {
        return this.currentMs
    }
}

export class DeterministicIdGenerator {
    private count = 0

    next = (prefix = 'eval'): string => {
        this.count += 1
        return `${prefix}-${String(this.count).padStart(4, '0')}`
    }

    generate = (): string => this.next()
}

export class ScriptedPerception implements LoopPerception {
    captures = 0

    constructor(
        private readonly clock: DeterministicClock,
        private readonly ids: DeterministicIdGenerator,
        private readonly durationMs = 40
    ) { }

    async capture(): Promise<PerceptionResult> {
        this.captures += 1
        this.clock.advance(this.durationMs)
        const observation: Observation = {
            id: this.ids.next('observation'),
            screenshotDataUrl: 'data:image/png;base64,',
            imageWidth: 1280,
            imageHeight: 720,
            displayId: 1,
            displayBounds: { x: 0, y: 0, width: 1280, height: 720 },
            scaleFactor: 1,
            pageText: `Deterministic evaluation observation ${this.captures}`,
            complete: true,
            capturedAt: this.clock.now()
        }
        return { ok: true, observation }
    }
}

export class ScriptedReasoning implements LoopReasoning {
    calls = 0
    readonly contexts: ReasoningContext[] = []
    readonly returnedOutcomes: RoutedOutcome[] = []

    constructor(
        private readonly script: readonly RoutedOutcome[],
        private readonly clock: DeterministicClock,
        private readonly durationMs = 120
    ) { }

    async reason(context: ReasoningContext): Promise<RoutedOutcome> {
        this.contexts.push(structuredClone(context))
        const scriptedOutcome = this.script[this.calls]
        this.calls += 1
        this.clock.advance(this.durationMs)
        const outcome: RoutedOutcome = scriptedOutcome
            ? structuredClone(scriptedOutcome)
            : {
                kind: 'failure',
                reason: 'eval-script-exhausted: no reasoning outcome was configured',
                providerId: null
            }
        this.returnedOutcomes.push(structuredClone(outcome))
        return outcome
    }
}

export class ScriptedSafetyGate implements LoopSafetyGate {
    evaluations = 0
    private stopped = false
    private inControl = false

    constructor(
        private readonly mode: ScriptedSafetyMode,
        private readonly clock: DeterministicClock
    ) { }

    evaluate(rawAction: unknown, external: ExternalGateInputs): GateDecision {
        this.evaluations += 1
        if (!isAction(rawAction)) {
            return this.blocked('invalid-action', 'Scripted evaluation received an invalid Action', true)
        }
        if (this.stopped) {
            return this.blocked('emergency-stop-active', 'Scripted emergency stop is active', true)
        }
        if (!this.inControl) {
            return this.blocked('indicator-not-displayed', 'Control indicator is not active', true)
        }
        if (this.mode === 'block-permission') {
            return this.blocked(
                'screen-recording-not-granted',
                'Evaluation simulated a missing screen-recording permission',
                false
            )
        }
        if (this.mode === 'require-confirmation') {
            if (external.confirmation === 'declined') {
                return this.blocked(
                    'confirmation-declined',
                    'Evaluation confirmation was declined',
                    true
                )
            }
            if (external.confirmation !== 'approved') {
                return this.blocked(
                    'confirmation-required',
                    'Evaluation action requires explicit confirmation',
                    true
                )
            }
            return { allow: true, action: rawAction, highRisk: true }
        }
        return { allow: true, action: rawAction, highRisk: false }
    }

    isStopped(): boolean {
        return this.stopped
    }

    setInControl(value: boolean): void {
        this.inControl = value
    }

    stop(): void {
        this.stopped = true
    }

    private blocked(
        reason: BlockReason,
        detail: string,
        highRisk: boolean
    ): GateBlocked {
        return {
            allow: false,
            reason,
            detail,
            highRisk,
            event: {
                type: reason === 'confirmation-declined' ? 'declined' : 'blocked',
                reason: detail,
                at: this.clock.now()
            }
        }
    }
}

export class ScriptedExecutor implements LoopExecutor {
    calls = 0
    goalSatisfied = false
    readonly actions: Action[] = []
    readonly outcomes: ActionResult[] = []

    constructor(
        private readonly results: readonly ScriptedActionResult[],
        private readonly clock: DeterministicClock,
        private readonly defaultDurationMs = 80
    ) {
        if (results.some((result) => result.goalState !== undefined && !result.expectedAction)) {
            throw new Error('Every scripted goal transition requires an expected action')
        }
    }

    async execute(
        action: Action,
        _observation: Observation,
        meta: LoopExecuteMeta = {}
    ): Promise<ActionResult> {
        this.actions.push(structuredClone(action))
        const plan = this.results[this.calls]
        this.calls += 1
        if (!plan) {
            throw new Error(`No scripted executor result for call ${this.calls}`)
        }
        this.clock.advance(plan.durationMs ?? this.defaultDurationMs)
        const outcome: ActionResult = {
            status: plan.status,
            ...(plan.reason ? { reason: plan.reason } : {}),
            ...(plan.mode ? { mode: plan.mode } : {}),
            highRisk: meta.highRisk ?? false,
            confirmed: meta.confirmed ?? false,
            executedAt: this.clock.now()
        }
        this.outcomes.push(structuredClone(outcome))
        if (plan.goalState !== undefined) {
            if (!plan.expectedAction) {
                throw new Error(`Scripted goal transition ${this.calls} has no expected action`)
            }
            if (
                outcome.status === 'success' &&
                isDeepStrictEqual(action, plan.expectedAction)
            ) {
                this.goalSatisfied = plan.goalState === 'satisfied'
            }
        }
        return outcome
    }
}
