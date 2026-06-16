import { describe, it, expect } from 'vitest'
import type {
    Rect,
    Turn,
    SessionSummary,
    Session,
    SessionContext,
    GatewayConfig,
    GlassError
} from './types'

/**
 * Placeholder test for task 1: confirms the test harness runs and that the
 * shared data models from the design can be constructed as expected. Real
 * behavioral tests arrive with their respective tasks.
 */
describe('shared types scaffold', () => {
    it('constructs the core data models', () => {
        const rect: Rect = { x: 0, y: 0, width: 100, height: 50 }

        const summary: SessionSummary = {
            inferredIntent: '',
            completedSteps: [],
            updatedThroughTurnId: null
        }

        const turn: Turn = {
            id: 't1',
            role: 'user',
            text: 'hello',
            createdAt: new Date(0).toISOString(),
            status: 'ok'
        }

        const session: Session = {
            id: 's1',
            turns: [turn],
            summary,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
        }

        const context: SessionContext = {
            summary,
            recentTurns: session.turns,
            currentCapture: { dataUrl: 'data:', thumbnailUrl: 'data:', rect }
        }

        const config: GatewayConfig = { baseURL: 'https://gw.example', model: 'm' }

        const error: GlassError = {
            kind: 'gateway-failed',
            message: 'failed',
            recoverable: true,
            action: 'retry'
        }

        expect(rect.width).toBe(100)
        expect(session.turns).toHaveLength(1)
        expect(context.recentTurns[0].role).toBe('user')
        expect(config.baseURL).toContain('https://')
        expect(error.kind).toBe('gateway-failed')
    })
})
