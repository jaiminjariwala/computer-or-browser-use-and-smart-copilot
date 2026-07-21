import { describe, it, expect, vi } from 'vitest'
import {
    createTaskNotifier,
    notificationForConfirmation,
    notificationForHelp,
    notificationForState,
    notificationForStep,
    type TaskNotification
} from './notifications'
import type { ConfirmationRequest, LoopStateView, TrajectoryStepView } from '@op-shared/types'

function step(overrides: Partial<TrajectoryStepView>): TrajectoryStepView {
    return {
        index: 0,
        outcome: 'completion',
        rationale: 'Found the rate: 1 USD = 84.2 INR.',
        providerId: 'gemini',
        capturedAt: '2026-07-20T00:00:00.000Z',
        ...overrides
    }
}

function state(overrides: Partial<LoopStateView>): LoopStateView {
    return { state: 'failed', sessionId: 's1', inControl: false, stepCount: 7, stepBudget: 25, ...overrides }
}

const confirmation: ConfirmationRequest = {
    stepId: 'st-1',
    action: { kind: 'left_click', at: { x: 1, y: 2 } },
    highRisk: true,
    rationale: 'Click "Place order" to finish the purchase.'
}

describe('notification formatters', () => {
    it('formats a completion step with the summary as body', () => {
        expect(notificationForStep(step({}))).toEqual({
            title: 'Task complete',
            body: 'Found the rate: 1 USD = 84.2 INR.'
        })
    })

    it('is silent for non-completion steps', () => {
        expect(notificationForStep(step({ outcome: 'action' }))).toBeNull()
        expect(notificationForStep(step({ outcome: 'failure' }))).toBeNull()
    })

    it('notifies failed terminal state and stays silent otherwise', () => {
        expect(notificationForState(state({}))?.title).toBe('Task could not be completed')
        expect(notificationForState(state({ state: 'completed' }))).toBeNull()
        expect(notificationForState(state({ state: 'stopped' }))).toBeNull()
        expect(notificationForState(state({ state: 'perceiving' }))).toBeNull()
    })

    it('formats help and confirmation banners', () => {
        expect(notificationForHelp('Which account should I use?').body).toContain('Which account')
        const conf = notificationForConfirmation(confirmation)
        expect(conf.title).toContain('high-risk')
        expect(conf.body).toContain('Place order')
    })

    it('clips very long bodies', () => {
        const long = 'x'.repeat(500)
        const n = notificationForHelp(long)
        expect(n.body.length).toBeLessThanOrEqual(140)
        expect(n.body.endsWith('…')).toBe(true)
    })
})

describe('createTaskNotifier', () => {
    function harness(focused: boolean): {
        presented: TaskNotification[]
        notifier: ReturnType<typeof createTaskNotifier>
        focusWindow: () => void
    } {
        const presented: TaskNotification[] = []
        const focusWindow = vi.fn()
        const notifier = createTaskNotifier({
            isWindowFocused: () => focused,
            focusWindow,
            isSupported: () => true,
            present: (n) => presented.push(n)
        })
        return { presented, notifier, focusWindow }
    }

    it('presents completion banners while the window is unfocused', () => {
        const h = harness(false)
        h.notifier.onStepAppended(step({}))
        expect(h.presented).toHaveLength(1)
        expect(h.presented[0]?.title).toBe('Task complete')
    })

    it('suppresses banners while the window is focused', () => {
        const h = harness(true)
        h.notifier.onStepAppended(step({}))
        h.notifier.onStateChanged(state({}))
        h.notifier.onHelpRequired('help?')
        h.notifier.onConfirmationRequired(confirmation)
        expect(h.presented).toHaveLength(0)
    })

    it('stays silent when the platform does not support notifications', () => {
        const presented: TaskNotification[] = []
        const notifier = createTaskNotifier({
            isWindowFocused: () => false,
            focusWindow: () => undefined,
            isSupported: () => false,
            present: (n) => presented.push(n)
        })
        notifier.onHelpRequired('anyone there?')
        expect(presented).toHaveLength(0)
    })

    it('wires the click handler to focus the window', () => {
        const clicks: Array<() => void> = []
        const focusWindow = vi.fn()
        const notifier = createTaskNotifier({
            isWindowFocused: () => false,
            focusWindow,
            isSupported: () => true,
            present: (_n, onClick) => {
                clicks.push(onClick)
            }
        })
        notifier.onHelpRequired('question')
        expect(clicks).toHaveLength(1)
        clicks[0]?.()
        expect(focusWindow).toHaveBeenCalledTimes(1)
    })
})
