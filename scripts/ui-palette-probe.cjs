/* scratch: decode the mockup PNG and report measured colors/edges (delete after use) */
const fs = require('fs')
const zlib = require('zlib')

function decodePng(file) {
  const buf = fs.readFileSync(file)
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth)
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  const lineBuf = Buffer.alloc(stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]
    raw.copy(lineBuf, 0, rp, rp + stride); rp += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? lineBuf[i - ch] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = (i >= ch && y > 0) ? out[(y - 1) * stride + i - ch] : 0
      let v = lineBuf[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c
      }
      lineBuf[i] = v & 0xff
    }
    lineBuf.copy(out, y * stride)
  }
  return { w, h, ch, px: out }
}

const img = decodePng(process.argv[2])
const get = (x, y) => {
  const i = (y * img.w + x) * img.ch
  const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2]
  const a = img.ch === 4 ? img.px[i + 3] : 255
  return [r, g, b, a]
}
const hex = (p) => '#' + p.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')
const far = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]))
console.log('decoded', img.w + 'x' + img.h, 'ch=' + img.ch, 'corner', get(0, 0), 'center', get(img.w >> 1, img.h >> 1))

// 1) find the window rect: walk inward from each side until 40 consecutive rows/cols stop changing much
function edgeScan(axis, fixed, from, to) {
  const pts = []
  for (let t = from; t !== to; t += axis === 'x' ? 1 : 1) {
    const p = axis === 'x' ? get(t, fixed) : get(fixed, t)
    pts.push([t, p])
  }
  return pts
}
function findEdges(y) {
  const out = []
  let prev = get(0, y)
  for (let x = 1; x < img.w; x++) {
    const p = get(x, y)
    if (far(p, prev) > 26) out.push([x, hex(prev), hex(p)])
    prev = p
  }
  return out
}
function findRows(x) {
  const out = []
  let prev = get(x, 0)
  for (let y = 1; y < img.h; y++) {
    const p = get(x, y)
    if (far(p, prev) > 26) out.push([y, hex(prev), hex(p)])
    prev = p
  }
  return out
}
const probeY = Math.round(img.h * 0.62)
console.log('\n== horizontal edges at y=' + probeY + ' ==')
console.log(findEdges(probeY).filter((e) => e[0] > 4).map((e) => e[0] + ':' + e[1] + '->' + e[2]).join('  '))
const probeX = Math.round(img.w * 0.62)
console.log('\n== vertical edges at x=' + probeX + ' ==')
console.log(findRows(probeX).map((e) => e[0] + ':' + e[1] + '->' + e[2]).join('  '))

// 2) region medians: most common color inside a box
function mode(x0, y0, x1, y1) {
  const m = new Map()
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const p = get(x, y); const k = hex(p)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0] + '×' + e[1]).join(' ')
}
const W = img.w, H = img.h
const regions = {
  'wallpaper-topleft': [0, 0, 40, 40],
  'page-bg': [Math.round(W * 0.45), Math.round(H * 0.02), Math.round(W * 0.70), Math.round(H * 0.05)],
  'sidebar-bg': [Math.round(W * 0.03), Math.round(H * 0.55), Math.round(W * 0.16), Math.round(H * 0.70)],
  'nav-active-pill': [Math.round(W * 0.04), Math.round(H * 0.12), Math.round(W * 0.16), Math.round(H * 0.16)],
  'bigcard-bg': [Math.round(W * 0.28), Math.round(H * 0.28), Math.round(W * 0.40), Math.round(H * 0.34)],
  'sidecard-bg': [Math.round(W * 0.80), Math.round(H * 0.26), Math.round(W * 0.92), Math.round(H * 0.30)],
  'cta-button': [Math.round(W * 0.44), Math.round(H * 0.565), Math.round(W * 0.52), Math.round(H * 0.585)],
  'subcard-bg': [Math.round(W * 0.80), Math.round(H * 0.545), Math.round(W * 0.90), Math.round(H * 0.60)],
  'bottomcard-bg': [Math.round(W * 0.28), Math.round(H * 0.70), Math.round(W * 0.38), Math.round(H * 0.74)],
  'titlebar': [Math.round(W * 0.55), Math.round(H * 0.035), Math.round(W * 0.65), Math.round(H * 0.05)]
}
console.log('\n== region modes ==')
for (const [k, v] of Object.entries(regions)) console.log(k.padEnd(18), mode(v[0], v[1], v[2], v[3]))

// 3) the four category dots on the 空间概览 card: scan a column band for saturated small blobs
console.log('\n== sample points ==')
for (const [name, fx, fy] of [
  ['donut-ring', 0.30, 0.44], ['donut-hole', 0.335, 0.44], ['bar-left', 0.42, 0.462],
  ['bar-right', 0.66, 0.462], ['dot1', 0.775, 0.285], ['dot2', 0.775, 0.335],
  ['dot3', 0.775, 0.385], ['dot4', 0.775, 0.435], ['hero-title', 0.30, 0.115],
  ['window-corner-40', 0.011, 0.011]
]) {
  const x = Math.round(W * fx), y = Math.round(H * fy)
  console.log(name.padEnd(18), x + ',' + y, hex(get(x, y)), 'a=' + get(x, y)[3])
}
