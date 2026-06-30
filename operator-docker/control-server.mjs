// In-container control server for the sandboxed Linux desktop (Req 24 family).
//
// Exposes a tiny HTTP API the host-side ContainerDesktopEnvironment drives:
//   GET  /health      -> { ok, width, height }
//   GET  /screenshot  -> image/png of the virtual display (:1) via scrot
//   POST /action      -> maps an Action_Space action to an xdotool command
//
// It runs INSIDE the container with DISPLAY=:1, so xdotool/scrot act on the
// Xvfb desktop the user watches over noVNC. Dependency-free (Node stdlib only).
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const PORT = Number(process.env.CONTROL_PORT || 6070)
const WIDTH = Number(process.env.WIDTH || 1280)
const HEIGHT = Number(process.env.HEIGHT || 800)
const DISPLAY = process.env.DISPLAY || ':1'
const ENV = { ...process.env, DISPLAY }

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { env: ENV, timeout: 15000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`))
            else resolve(stdout)
        })
    })
}

/** Map an Action_Space `key` chord (e.g. ["cmd","c"]) to an xdotool key expr. */
function mapKeyChord(keys) {
    const alias = {
        cmd: 'super', command: 'super', meta: 'super',
        ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
        enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape',
        space: 'space', backspace: 'BackSpace', delete: 'Delete',
        up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End'
    }
    return keys
        .map((raw) => {
            const k = String(raw).trim().toLowerCase()
            if (alias[k]) return alias[k]
            return k.length === 1 ? k : raw
        })
        .join('+')
}

async function doAction(a) {
    switch (a.kind) {
        case 'screenshot':
            return
        case 'wait':
            await new Promise((r) => setTimeout(r, Math.min(Math.max(0, a.ms | 0), 10000)))
            return
        case 'mouse_move':
            await run('xdotool', ['mousemove', String(a.at.x), String(a.at.y)])
            return
        case 'left_click':
            await run('xdotool', ['mousemove', String(a.at.x), String(a.at.y), 'click', '1'])
            return
        case 'right_click':
            await run('xdotool', ['mousemove', String(a.at.x), String(a.at.y), 'click', '3'])
            return
        case 'double_click':
            await run('xdotool', ['mousemove', String(a.at.x), String(a.at.y), 'click', '--repeat', '2', '1'])
            return
        case 'drag':
            await run('xdotool', ['mousemove', String(a.from.x), String(a.from.y), 'mousedown', '1'])
            await run('xdotool', ['mousemove', String(a.to.x), String(a.to.y), 'mouseup', '1'])
            return
        case 'type':
            await run('xdotool', ['type', '--', String(a.text)])
            return
        case 'key':
            await run('xdotool', ['key', '--', mapKeyChord(a.keys)])
            return
        case 'scroll': {
            await run('xdotool', ['mousemove', String(a.at.x), String(a.at.y)])
            const vClicks = Math.min(10, Math.max(0, Math.round(Math.abs(a.dy) / 100)))
            const vButton = a.dy > 0 ? '5' : '4'
            for (let i = 0; i < vClicks; i++) await run('xdotool', ['click', vButton])
            const hClicks = Math.min(10, Math.max(0, Math.round(Math.abs(a.dx) / 100)))
            const hButton = a.dx > 0 ? '7' : '6'
            for (let i = 0; i < hClicks; i++) await run('xdotool', ['click', hButton])
            return
        }
        default:
            throw new Error(`Unknown action kind: ${a.kind}`)
    }
}

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'content-type': type })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

const server = createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/health') {
            return send(res, 200, { ok: true, width: WIDTH, height: HEIGHT })
        }
        if (req.method === 'GET' && req.url === '/screenshot') {
            await run('scrot', ['-o', '/tmp/screen.png'])
            const png = await readFile('/tmp/screen.png')
            return send(res, 200, png, 'image/png')
        }
        if (req.method === 'POST' && req.url === '/action') {
            let raw = ''
            for await (const chunk of req) raw += chunk
            const action = JSON.parse(raw || '{}')
            await doAction(action)
            return send(res, 200, { ok: true })
        }
        return send(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
        return send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
})

server.listen(PORT, '0.0.0.0', () => {
    console.log(`control-server listening on ${PORT} (display ${DISPLAY}, ${WIDTH}x${HEIGHT})`)
})
