import { createRequire } from 'node:module'
import type { Point } from '@op-shared/types'
import type { InputBackend, MouseButton } from './backend'

/**
 * Native CGEvent backend — the primary input path.
 *
 * A native N-API addon over CoreGraphics `CGEvent` (see `native/input-synth/`),
 * loaded lazily. If it is not compiled for the current ABI, loading is a soft
 * miss (returns `null`) so {@link import('./backend').selectInputBackend} can
 * fall back to `cliclick`. Coordinates are logical display points, rounded to
 * integer pixels for the addon.
 */

/** Round a logical coordinate to the nearest integer pixel for the addon. */
function rx(value: number): number {
    return Math.round(value)
}

/**
 * The N-API surface the compiled `native/input-synth` addon exposes. Kept in
 * lockstep with `input_synth.mm`. Coordinates are logical display points.
 */
export interface NativeInputSynth {
    mouseMove(x: number, y: number): void
    mouseClick(x: number, y: number, button: number, clickCount: number): void
    mouseDrag(fromX: number, fromY: number, toX: number, toY: number): void
    typeText(text: string): void
    keyChord(keys: string[]): void
    scroll(x: number, y: number, dx: number, dy: number): void
}

/** Candidate paths where node-gyp emits the compiled addon. */
const NATIVE_ADDON_CANDIDATES = [
    '../../native/input-synth/build/Release/input_synth.node',
    '../../../native/input-synth/build/Release/input_synth.node'
]

let cachedNativeSynth: NativeInputSynth | null | undefined

/**
 * Lazily load the compiled native addon, memoizing the result. Returns `null`
 * when the addon is not built (the common case in CI/headless and before
 * `npm run build:native`), so callers can fall back gracefully. Never throws.
 */
export function loadNativeInputSynth(): NativeInputSynth | null {
    if (cachedNativeSynth !== undefined) return cachedNativeSynth
    const req = createRequire(import.meta.url)
    for (const candidate of NATIVE_ADDON_CANDIDATES) {
        try {
            const mod = req(candidate) as NativeInputSynth
            if (mod && typeof mod.mouseMove === 'function') {
                cachedNativeSynth = mod
                return mod
            }
        } catch {
            // Not built for this candidate path / ABI — try the next.
        }
    }
    cachedNativeSynth = null
    return null
}

/** An {@link InputBackend} backed by the native CGEvent addon (primary path). */
export class NativeInputBackend implements InputBackend {
    readonly kind = 'native' as const
    private readonly synth: NativeInputSynth

    constructor(synth: NativeInputSynth) {
        this.synth = synth
    }

    mouseMove(at: Point): void {
        this.synth.mouseMove(rx(at.x), rx(at.y))
    }

    click(at: Point, button: MouseButton, clickCount: number): void {
        this.synth.mouseClick(rx(at.x), rx(at.y), button === 'right' ? 1 : 0, clickCount)
    }

    drag(from: Point, to: Point): void {
        this.synth.mouseDrag(rx(from.x), rx(from.y), rx(to.x), rx(to.y))
    }

    typeText(text: string): void {
        this.synth.typeText(text)
    }

    key(keys: string[]): void {
        this.synth.keyChord(keys)
    }

    scroll(at: Point, dx: number, dy: number): void {
        this.synth.scroll(rx(at.x), rx(at.y), rx(dx), rx(dy))
    }
}

/** Load the native addon and wrap it, or return null when it is not built. */
export function loadNativeBackend(): NativeInputBackend | null {
    const synth = loadNativeInputSynth()
    return synth ? new NativeInputBackend(synth) : null
}
