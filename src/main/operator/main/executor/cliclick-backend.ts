import { spawn, spawnSync } from 'node:child_process'
import type { Action, Point } from '@op-shared/types'
import type { InputBackend, MouseButton } from './backend'

/**
 * cliclick subprocess fallback — used when the native addon is not built.
 *
 * A pragmatic fallback that shells out to the `cliclick` CLI so the
 * perceive→reason→act loop can run before/without the native path. The
 * Action→command mapping ({@link cliclickCommands}) is a PURE function so it is
 * unit-tested without spawning anything. `scroll` is not expressible in
 * `cliclick` and throws — a documented limitation covered by the native path.
 */

/** Round a logical coordinate to the nearest integer pixel for a CLI argument. */
function rx(value: number): number {
    return Math.round(value)
}

/**
 * Modifier key names `cliclick` understands for `kd:`/`ku:` (key-down/up). The
 * fallback holds these around a typed/pressed main key to realize a chord.
 */
const CLICLICK_MODIFIERS: Readonly<Record<string, string>> = {
    cmd: 'cmd',
    command: 'cmd',
    meta: 'cmd',
    super: 'cmd',
    win: 'cmd',
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    fn: 'fn'
}

/** Named non-modifier keys `cliclick` can press directly via `kp:`. */
const CLICLICK_NAMED_KEYS: Readonly<Record<string, string>> = {
    enter: 'return',
    return: 'return',
    tab: 'tab',
    space: 'space',
    esc: 'esc',
    escape: 'esc',
    delete: 'delete',
    del: 'delete',
    backspace: 'delete',
    up: 'arrow-up',
    down: 'arrow-down',
    left: 'arrow-left',
    right: 'arrow-right',
    home: 'home',
    end: 'end',
    pageup: 'page-up',
    pagedown: 'page-down'
}

/**
 * Build the ordered `cliclick` command tokens for a validated-and-mapped
 * Action — a PURE function so the fallback's Action→command realization is
 * unit-tested without spawning any process. The tokens are the arguments passed
 * to the `cliclick` binary (e.g. `['c:100,200']` for a left click).
 *
 * `screenshot` and `wait` synthesize no input event, so they map to no tokens
 * (the executor handles them without the backend). `scroll` is not expressible
 * in `cliclick` and throws — a documented fallback limitation covered by the
 * native path.
 */
export function cliclickCommands(action: Action): string[] {
    switch (action.kind) {
        case 'screenshot':
        case 'wait':
            return []
        case 'mouse_move':
            return [`m:${rx(action.at.x)},${rx(action.at.y)}`]
        case 'left_click':
            return [`c:${rx(action.at.x)},${rx(action.at.y)}`]
        case 'right_click':
            return [`rc:${rx(action.at.x)},${rx(action.at.y)}`]
        case 'double_click':
            return [`dc:${rx(action.at.x)},${rx(action.at.y)}`]
        case 'drag':
            return [
                `dd:${rx(action.from.x)},${rx(action.from.y)}`,
                `du:${rx(action.to.x)},${rx(action.to.y)}`
            ]
        case 'type':
            return [`t:${action.text}`]
        case 'key':
            return cliclickKeyChord(action.keys)
        case 'scroll':
            throw new Error('cliclick fallback does not support scroll; native backend required')
        default: {
            const _never: never = action
            void _never
            throw new Error('Unhandled Action kind')
        }
    }
}

/**
 * Realize a key chord as `cliclick` tokens: hold each recognized modifier with
 * `kd:`, press/type the main keys in the middle, then release the modifiers in
 * reverse with `ku:`. Named keys use `kp:`; a single printable character is
 * typed with `t:`.
 */
function cliclickKeyChord(keys: string[]): string[] {
    const modifiers: string[] = []
    const mains: string[] = []
    for (const raw of keys) {
        const k = raw.trim().toLowerCase()
        const mod = CLICLICK_MODIFIERS[k]
        if (mod) {
            if (!modifiers.includes(mod)) modifiers.push(mod)
        } else {
            mains.push(raw)
        }
    }

    const mainTokens: string[] = mains.map((raw) => {
        const named = CLICLICK_NAMED_KEYS[raw.trim().toLowerCase()]
        if (named) return `kp:${named}`
        // A single printable character is typed literally.
        return `t:${raw}`
    })

    if (modifiers.length === 0) return mainTokens

    const down = modifiers.map((m) => `kd:${m}`)
    const up = [...modifiers].reverse().map((m) => `ku:${m}`)
    return [...down, ...mainTokens, ...up]
}

/** Whether the `cliclick` binary is on PATH. Cached; never throws. */
let cachedCliclickAvailable: boolean | undefined
export function isCliclickAvailable(): boolean {
    if (cachedCliclickAvailable !== undefined) return cachedCliclickAvailable
    try {
        const probe = spawnSync('cliclick', ['-V'], { stdio: 'ignore' })
        cachedCliclickAvailable = probe.status === 0 || probe.error === undefined
    } catch {
        cachedCliclickAvailable = false
    }
    return cachedCliclickAvailable
}

/**
 * An {@link InputBackend} that shells out to the `cliclick` CLI — the pragmatic
 * fallback that lets the loop run before/without the native addon. Each call
 * spawns one `cliclick` invocation with the tokens from {@link cliclickCommands}
 * and rejects if the process errors or exits non-zero (recorded as a failure).
 */
export class CliclickInputBackend implements InputBackend {
    readonly kind = 'cliclick' as const

    mouseMove(at: Point): Promise<void> {
        return this.run(cliclickCommands({ kind: 'mouse_move', at }))
    }

    click(at: Point, button: MouseButton, clickCount: number): Promise<void> {
        const kind =
            clickCount >= 2 ? 'double_click' : button === 'right' ? 'right_click' : 'left_click'
        return this.run(cliclickCommands({ kind, at } as Action))
    }

    drag(from: Point, to: Point): Promise<void> {
        return this.run(cliclickCommands({ kind: 'drag', from, to }))
    }

    typeText(text: string): Promise<void> {
        return this.run(cliclickCommands({ kind: 'type', text }))
    }

    key(keys: string[]): Promise<void> {
        return this.run(cliclickCommands({ kind: 'key', keys }))
    }

    scroll(at: Point, dx: number, dy: number): Promise<void> {
        // Delegates to the pure mapper, which throws for scroll (unsupported).
        return this.run(cliclickCommands({ kind: 'scroll', at, dx, dy }))
    }

    /** Spawn one `cliclick` invocation with the given argument tokens. */
    private run(tokens: string[]): Promise<void> {
        if (tokens.length === 0) return Promise.resolve()
        return new Promise<void>((resolve, reject) => {
            const child = spawn('cliclick', tokens, { stdio: 'ignore' })
            child.on('error', reject)
            child.on('close', (code) => {
                if (code === 0) resolve()
                else reject(new Error(`cliclick exited with code ${code}`))
            })
        })
    }
}
