import type { ConfigStatus, GatewayConfigInput } from '@shared/types'

/**
 * The subset of `window.glass` the settings UI needs (design: GlassBridge,
 * channels `config:get-status`, `config:save`, `credentials:required`).
 *
 * Kept as a local, non-global interface so it does not collide with the full
 * `window.glass` typing that the chat-UI wiring (task 2) installs. We read the
 * methods off `window` defensively at call time.
 */
export interface ConfigBridge {
    getConfigStatus(): Promise<ConfigStatus>
    saveConfig(cfg: GatewayConfigInput): Promise<void>
    /** Subscribe to the main-process `credentials:required` push. Returns an
     * unsubscribe function when supported. */
    onCredentialsRequired(cb: () => void): void | (() => void)
}

/** Resolve the config bridge from `window.glass`, or null if not yet wired. */
export function getConfigBridge(): ConfigBridge | null {
    const glass = (window as unknown as { glass?: Partial<ConfigBridge> }).glass
    if (glass && typeof glass.getConfigStatus === 'function' && typeof glass.saveConfig === 'function') {
        return glass as ConfigBridge
    }
    return null
}
