// 纯 Node 生成 256x256 PNG 并包装为 ICO（无第三方依赖）
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

const SIZE = 256
const buf = Buffer.alloc(SIZE * SIZE * 4, 0)

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
}

// 圆角矩形蓝色底
const RADIUS = 56
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, RADIUS), SIZE - 1 - RADIUS)
    const cy = Math.min(Math.max(y, RADIUS), SIZE - 1 - RADIUS)
    const d = Math.hypot(x - cx, y - cy)
    if (d <= RADIUS) setPx(x, y, 0x4f, 0x8c, 0xff, 255)
  }
}

// 白色圆环（钟面）
const C = 128, RING_R = 86, STROKE = 8
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - C, y - C)
    if (Math.abs(d - RING_R) < STROKE) setPx(x, y, 255, 255, 255, 255)
  }
}

// 指针（点到线段距离）
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (distToSeg(x, y, C, C, C, 80) < 8) setPx(x, y, 255, 255, 255, 255)      // 时针向上
    if (distToSeg(x, y, C, C, 168, 142) < 8) setPx(x, y, 255, 255, 255, 255)   // 分针向右下
  }
}

/* ---------- PNG 编码 ---------- */
function crc32(b) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ table[(c ^ b[i]) & 0xff]
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
// 每行前加 filter 字节 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

/* ---------- ICO 包装（PNG payload） ---------- */
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0; entry[1] = 0 // 256
entry[2] = 0; entry[3] = 0
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12)
const ico = Buffer.concat([header, entry, png])

const out = path.join(__dirname, 'icon.ico')
fs.writeFileSync(out, ico)
console.log('ICON_OK', out, ico.length)
