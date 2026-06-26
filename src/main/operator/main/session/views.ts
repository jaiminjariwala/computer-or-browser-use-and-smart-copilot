import type {
    AgentSession,
    AgentSessionView,
    TrajectoryStep,
    TrajectoryStepView
} from '@op-shared/types'
import { clone } from './factories'

/**
 * Renderer-facing view mappers (Task 12.2).
 *
 * The manager owns internal {@link AgentSession}/{@link TrajectoryStep} state; the
 * renderer only ever sees these read-only projections. Everything the renderer
 * could mutate (actions, results, events, summary) is cloned on the way out so
 * the live activity log can never reach back into the manager's Trajectory
 * (Req 14.1-14.3, 18.2).
 */

/**
 * Map a stored {@link TrajectoryStep} to its renderer-facing
 * {@link TrajectoryStepView} for the live activity log (Req 14.1-14.3).
 */
export function toTrajectoryStepView(step: TrajectoryStep): TrajectoryStepView {
    const view: TrajectoryStepView = {
        index: step.index,
        outcome: step.reasoning.outcome,
        rationale: step.reasoning.rationale,
        providerId: step.reasoning.providerId,
        capturedAt: step.observation.capturedAt
    }
    if (step.action !== undefined) view.action = clone(step.action)
    if (step.result !== undefined) view.result = clone(step.result)
    if (step.events !== undefined) view.events = clone(step.events)
    return view
}

/** Map an {@link AgentSession} to its renderer-facing {@link AgentSessionView} (Req 18.2). */
export function toAgentSessionView(session: AgentSession): AgentSessionView {
    return {
        id: session.id,
        goalText: session.goal.text,
        autonomy: session.autonomy,
        stepBudget: session.stepBudget,
        status: session.status,
        environment: session.environment,
        trajectory: session.trajectory.map(toTrajectoryStepView),
        summary: clone(session.summary),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
    }
}
