/**
 * 形象图去背景工具（零依赖：只用 node:zlib 解/压 PNG）。
 *
 * 算法：从图像边缘做泛洪（BFS）——把与"角落背景色"颜色相近的连通区域抠成透明；
 * 角色内部的深色（如女仆裙）不与边缘连通，不会被误伤；对抗锯齿过渡带做两级阈值羽化。
 *
 * 用法：node tools/remove-bg.mjs <png...>   （原地覆盖，输出同尺寸 RGBA PNG）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 极简 PNG 解码：支持 8-bit、非隔行、灰度/RGB/RGBA。返回 {w,h,ch,data:RGBA} */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG')
  let pos = 8
  let w = 0, h = 0, depth = 8, colorType = 6, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8) throw new Error('仅支持 8-bit 深度（实际 ' + depth + '）')
  if (interlace) throw new Error('不支持隔行 PNG')
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0
  if (!ch) throw new Error('不支持的颜色类型 ' + colorType)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) v += paeth(a, b, c)
      cur[x] = v & 0xff
    }
    for (let x = 0; x < w; x++) {
      const si = x * ch, di = (y * w + x) * 4
      out[di] = cur[si]
      out[di + 1] = ch >= 3 ? cur[si + 1] : cur[si]
      out[di + 2] = ch >= 3 ? cur[si + 2] : cur[si]
      out[di + 3] = ch === 4 ? cur[si + 3] : 255
    }
    prev = cur
  }
  return { w, h, data: out }
}

/** 编码 RGBA → PNG（filter 0 全量 + deflate）。 */
export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dist2 = (r, g, b, r2, g2, b2) => (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2

/**
 * 去背景：边缘泛洪 + 双阈值羽化。
 * @param {{w:number,h:number,data:Buffer}} img
 * @param {{t1?:number, t2?:number, protect?:Array<{x:number,y:number,w:number,h:number}>}} [opts]
 *   protect：泛洪保护区（深色道具贴边时防止被当背景吃掉），欧氏距离
 */
export function removeBackground(img, opts = {}) {
  const t1 = (opts.t1 ?? 28) ** 2
  const t2 = (opts.t2 ?? 90) ** 2
  const { w, h, data } = img
  const protectedPx = new Uint8Array(w * h)
  for (const r of opts.protect || []) {
    for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) {
        protectedPx[y * w + x] = 1
      }
    }
  }
  // 背景色 = 四角 5x5 区域的中位估计
  const samples = []
  const corners = [[0, 0], [w - 5, 0], [0, h - 5], [w - 5, h - 5]]
  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < 5; dy++) {
      for (let dx = 0; dx < 5; dx++) {
        const i = ((cy + dy) * w + (cx + dx)) * 4
        samples.push([data[i], data[i + 1], data[i + 2]])
      }
    }
  }
  const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  const bg = [med(0), med(1), med(2)]

  // 边缘泛洪：与背景相近的连通区 → 抠掉
  const total = w * h
  const state = new Uint8Array(total) // 0 未知，1 抠除，2 保留
  const queue = new Int32Array(total)
  let qh = 0, qt = 0
  const push = (idx) => { if (state[idx] === 0 && !protectedPx[idx]) { state[idx] = 1; queue[qt++] = idx } }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (qh < qt) {
    const idx = queue[qh++]
    const i = idx * 4
    if (dist2(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) >= t1) continue
    const x = idx % w, y = (idx / w) | 0
    if (x > 0) push(idx - 1)
    if (x < w - 1) push(idx + 1)
    if (y > 0) push(idx - w)
    if (y < h - 1) push(idx + w)
  }
  // 主色判定后，被泛洪到但颜色超阈值的区域改回保留
  for (let idx = 0; idx < total; idx++) {
    if (state[idx] === 1) {
      const i = idx * 4
      if (dist2(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) >= t1) state[idx] = 2
    }
  }
  // 羽化：与抠掉区相邻的保留像素，按颜色距离做半透明过渡
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (state[idx] !== 2) continue
      const i = idx * 4
      let nearRemoved = false
      if ((x > 0 && state[idx - 1] === 1) || (x < w - 1 && state[idx + 1] === 1) ||
          (y > 0 && state[idx - w] === 1) || (y < h - 1 && state[idx + w] === 1)) nearRemoved = true
      if (!nearRemoved) continue
      const d = dist2(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2])
      if (d < t2) {
        const a = Math.max(0, Math.min(1, (Math.sqrt(d) - Math.sqrt(t1)) / (Math.sqrt(t2) - Math.sqrt(t1))))
        data[i + 3] = Math.round(data[i + 3] * a)
      }
    }
  }
  // 抠除区 alpha=0
  for (let idx = 0; idx < total; idx++) {
    if (state[idx] === 1) data[idx * 4 + 3] = 0
  }
  return { bg }
}

// ── CLI ──
if (process.argv[1] && process.argv[1].endsWith('remove-bg.mjs')) {
  const files = process.argv.slice(2)
  if (!files.length) { console.error('用法: node tools/remove-bg.mjs <png...>'); process.exit(1) }
  for (const f of files) {
    const img = decodePNG(readFileSync(f))
    removeBackground(img, { t1: Number(process.env.T1) || 28, t2: Number(process.env.T2) || 90 })
    writeFileSync(f, encodePNG(img.w, img.h, img.data))
    console.log('已去底:', f, `(${img.w}x${img.h})`)
  }
}
