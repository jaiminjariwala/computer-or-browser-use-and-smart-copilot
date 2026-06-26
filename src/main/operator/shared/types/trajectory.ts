/**
 * Perception + the append-only Trajectory audit record.
 *
 * Covers what the agent sees ({@link Observation}, {@link A11yElement}), the
 * per-step reasoning it records ({@link ReasoningStep}), the ordered history of
 * (Observation, Reasoning, Action, Result) tuples ({@link TrajectoryStep},
 * {@link Trajectory}), safety events, the bounded running summary, and the
 * renderer-facing step view (Req 2, 3, 4, 14).
 */

import type { Action, ActionResult, Rect } from './action'

/** A captured representation of the current screen state (Req 2). */
export interface Observation {
    id: string
    /** base64 PNG data URL (Req 2.1). */
    screenshotDataUrl: string
    /** Image-space dimensions used for Coordinate_Mapping. */
    imageWidth: number
    imageHeight: number
    /** The display this Observation came from (Req 5.2). */
    displayId: number
    /** Logical-point bounds of the source display (Req 2.4). */
    displayBounds?: Rect
    /** Backing-store scale factor, e.g. 2 for Retina (Req 2.4). */
    scaleFactor?: number
    /** Optional accessibility-tree perception (Req 2.6). */
    a11yElements?: A11yElement[]
    /**
     * Optional readable text digest of the current page (title, URL, headings,
     * visible copy). Supplied by DOM-based environments (the browser backend) so
     * the agent can read page CONTENT from structured text instead of an image,
     * which lets it run on text models and avoids the rate limits / "no image
     * input" errors of free vision tiers.
     */
    pageText?: string
    /** false if bounds/scale unknown -> no coordinate Action may execute (Req 2.8). */
    complete: boolean
    capturedAt: string
}

/** A single accessibility-tree element attached to an Observation (Req 2.6). */
export interface A11yElement {
    role: string
    title?: string
    bounds?: Rect
}

/** One model call's recorded outcome + rationale in the Trajectory (Req 3). */
export interface ReasoningStep {
    id: string
    outcome: 'action' | 'completion' | 'help' | 'failure'
    /** Human-readable rationale (Req 3.3, 14.2). */
    rationale: string
    /** Which Model_Provider served this step; null if all providers failed (Req 21.9). */
    providerId: string | null
    createdAt: string
}

/** One (Observation, Reasoning, Action, Result) tuple in the Trajectory. */
export interface TrajectoryStep {
    /** Strictly increasing, chronological, append-only. */
    index: number
    observation: Observation
    reasoning: ReasoningStep
    /** Absent for completion/help/failure steps (Req 3.6). */
    action?: Action
    /** Present for every attempted Action (Req 5.7). */
    result?: ActionResult
    /** Emergency-stop / decline / block records (Req 7.6, 14.5). */
    events?: SafetyEvent[]
}

/** The ordered history of Trajectory steps for the current session. */
export type Trajectory = TrajectoryStep[]

/** A safety-relevant event recorded in the Trajectory (Req 7.6, 14.5). */
export interface SafetyEvent {
    type: 'emergency-stop' | 'declined' | 'blocked'
    reason: string
    at: string
}

/** The condensed, running record of older Trajectory steps (Req 4). */
export interface TrajectorySummary {
    /** Preserved goal text (Req 4.4). */
    goalText: string
    /** Running condensed progress (Req 4.1). */
    inferredProgress: string
    /** Preserved & monotonic completed sub-steps (Req 4.4). */
    completedSubSteps: string[]
    /** Highest Trajectory index folded into this summary, or null if none. */
    updatedThroughIndex: number | null
}

/** A human-readable Trajectory step for the live activity log (Req 14.1-14.3). */
export interface TrajectoryStepView {
    index: number
    outcome: ReasoningStep['outcome']
    rationale: string
    providerId: string | null
    action?: Action
    result?: ActionResult
    events?: SafetyEvent[]
    capturedAt: string
}
