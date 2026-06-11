import type { GlassBridge } from '@shared/types'

/**
 * Global typing for the preload-injected bridge. With this declaration the
 * renderer can use `window.glass.sendMessage(...)` etc. with full type safety
 * (design: "Preload bridge"). The bridge is injected by `src/preload/index.ts`.
 */
declare global {
    interface Window {
        glass: GlassBridge
    }
}

export { }
