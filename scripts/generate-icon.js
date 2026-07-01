// Generates build/icon-1024.png — a minimal Glass app icon: a dark rounded
// square with a white pencil (matching the floating pencil), drawn as raw
// pixels and PNG-encoded with Node's zlib (no image libraries required).
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024

// ---- tiny helpers -------------------------------------------------------
function mix(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
    ]
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)
}
// Signed distance to a rounded rectangle centered at origin.
function sdRoundRect(px, py, halfW, halfH, r) {
    const qx = Math.abs(px) - (halfW - r)
    const qy = Math.abs(py) - (halfH - r)
    const ax = Math.max(qx, 0)
    const ay = Math.max(qy, 0)
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}
// Signed distance to a segment (capsule core).
function sdSegment(px, py, ax, ay, bx, by) {
    const pax = px - ax
    const pay = py - ay
    const bax = bx - ax
    const bay = by - ay
    const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay))
    const dx = pax - bax * h
    const dy = pay - bay * h
    return Math.hypot(dx, dy)
}

// ---- colors -------------------------------------------------------------
const BG = [28, 28, 30] // #1c1c1e dark square
const BODY = [247, 247, 248] // #f7f7f8 pencil body (white)
const TIP = [107, 107, 115] // #6b6b73 graphite tip (gray)

// Pencil geometry, in centered coords, rotated -45°.
const ANGLE = -Math.PI / 4
const COS = Math.cos(ANGLE)
const SIN = Math.sin(ANGLE)
const BAR_HALF_W = 66 // pencil half-thickness
const BODY_TOP = -150 // where the tip triangle meets the body (local y)
const BODY_BOTTOM = 300 // flat (eraser) end
const TIP_POINT = -330 // sharp point of the pencil

const buf = Buffer.alloc(SIZE * SIZE * 4)

for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        const dx = x - SIZE / 2
        const dy = y - SIZE / 2

        // Background rounded square with coverage AA.
        const bgD = sdRoundRect(dx, dy, 460, 460, 210)
        let aBg = smoothstep(1.5, -1.5, bgD)

        // Pencil in rotated local space.
        const lx = dx * COS - dy * SIN
        const ly = dx * SIN + dy * COS

        // Body: capsule along local-y from BODY_TOP to BODY_BOTTOM.
        const bodyD = sdSegment(lx, ly, 0, BODY_TOP, 0, BODY_BOTTOM) - BAR_HALF_W
        const aBody = smoothstep(1.5, -1.5, bodyD)

        // Tip: triangle from (0,TIP_POINT) widening to ±BAR_HALF_W at BODY_TOP.
        let aTip = 0
        if (ly >= TIP_POINT && ly <= BODY_TOP) {
            const t = (ly - TIP_POINT) / (BODY_TOP - TIP_POINT) // 0 at point → 1 at base
            const halfAtY = BAR_HALF_W * t
            aTip = smoothstep(1.5, -1.5, Math.abs(lx) - halfAtY)
        }

        // Compose: start from transparent, lay square, then pencil.
        let r = 0
        let g = 0
        let b = 0
        let a = 0

        // square
        a = aBg
        r = BG[0]
        g = BG[1]
        b = BG[2]

        // pencil body (white) over square
        if (aBody > 0) {
            const ca = aBody
            r = Math.round(r * (1 - ca) + BODY[0] * ca)
            g = Math.round(g * (1 - ca) + BODY[1] * ca)
            b = Math.round(b * (1 - ca) + BODY[2] * ca)
            a = Math.max(a, ca)
        }
        // pencil tip (gray) over square
        if (aTip > 0) {
            const ca = aTip
            r = Math.round(r * (1 - ca) + TIP[0] * ca)
            g = Math.round(g * (1 - ca) + TIP[1] * ca)
            b = Math.round(b * (1 - ca) + TIP[2] * ca)
            a = Math.max(a, ca)
        }

        const i = (y * SIZE + x) * 4
        buf[i] = r
        buf[i + 1] = g
        buf[i + 2] = b
        buf[i + 3] = Math.round(a * 255)
    }
}

// ---- PNG encode ---------------------------------------------------------
function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const body = Buffer.concat([typeBuf, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crc])
}
const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()
function crc32(b) {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
// raw scanlines with filter byte 0
const stride = SIZE * 4
const raw = Buffer.alloc((stride + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0
    buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
}
const idat = zlib.deflateSync(raw, { level: 9 })
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
])

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'icon-1024.png')
fs.writeFileSync(out, png)
console.log('Wrote', out)
