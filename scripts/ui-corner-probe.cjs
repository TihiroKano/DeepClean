/* scratch: measure the captured window's top-left / top-right corner to read the actual radius */
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
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  const line = Buffer.alloc(stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    raw.copy(line, 0, rp, rp + stride); rp += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = (i >= ch && y > 0) ? out[(y - 1) * stride + i - ch] : 0
      let v = line[i]
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c }
      line[i] = v & 0xff
    }
    line.copy(out, y * stride)
  }
  return { w, h, ch, px: out }
}

const img = decodePng(process.argv[2])
const get = (x, y) => { const i = (y * img.w + x) * img.ch; return [img.px[i], img.px[i + 1], img.px[i + 2]] }
const hex = (p) => '#' + p.map((v) => v.toString(16).padStart(2, '0')).join('')
// 应用自己的蓝：侧栏/底都在这附近。用"与 #0a2250 的三通道最大差"判是不是产品像素
const APP = [10, 34, 80]
const isApp = (p) => Math.max(Math.abs(p[0] - APP[0]), Math.abs(p[1] - APP[1]), Math.abs(p[2] - APP[2])) < 46

console.log('image', img.w + 'x' + img.h)
for (const [name, rowStart] of [['top-left', 0], ['top-right', 0]]) {
  const edges = []
  for (let y = rowStart; y < rowStart + 34; y++) {
    let x = -1
    for (let i = 0; i < 200; i++) {
      const px = name === 'top-left' ? i : img.w - 1 - i
      if (isApp(get(px, y))) { x = name === 'top-left' ? px : img.w - 1 - px; break }
    }
    edges.push(`${y}:${x}`)
  }
  console.log(name, edges.join(' '))
}
// 底部两角：从下往上
for (const [name, dir] of [['bottom-left', 'l'], ['bottom-right', 'r']]) {
  const edges = []
  for (let dy = 0; dy < 34; dy++) {
    const y = img.h - 1 - dy
    let x = -1
    for (let i = 0; i < 200; i++) {
      const px = dir === 'l' ? i : img.w - 1 - i
      if (isApp(get(px, y))) { x = px; break }
    }
    edges.push(`${img.h - 1 - y}:${x}`)
  }
  console.log(name, edges.join(' '))
}
console.log('corner samples TL', hex(get(0, 0)), hex(get(11, 0)), hex(get(0, 11)), hex(get(20, 20)))
