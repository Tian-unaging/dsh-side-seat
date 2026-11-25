/**
 * 本地变化检测（5.7）：dHash + 像素差，全部在 32x18 灰度栅格上算，几乎不花钱。
 *
 *   hamming < 3    画面基本静止 -> 丢弃
 *   hamming 3..12  轻微变化     -> 记入累计变化量
 *   hamming > 12   显著变化     -> 标记 dirty
 *
 * 这一层把绝大多数无效帧挡掉，后面的轻判断只在「每 20 秒且有变化」或
 * 「累计 dirty >= 3」时才发生。
 */
export const GRID_W = 32
export const GRID_H = 18

/** 32x18 灰度 -> 9x8 盒式平均 -> 64 位 dHash（Uint8Array(8)）。 */
export function dhash(gray) {
  const W = 9
  const H = 8
  const small = new Float64Array(W * H)
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * GRID_H / H)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * GRID_H / H))
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * GRID_W / W)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * GRID_W / W))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += gray[yy * GRID_W + xx] || 0; n++ }
      small[y * W + x] = n ? sum / n : 0
    }
  }
  const hash = new Uint8Array(8)
  for (let y = 0; y < H; y++) {
    let byte = 0
    for (let x = 0; x < 8; x++) {
      if (small[y * W + x] > small[y * W + x + 1]) byte |= 1 << x
    }
    hash[y] = byte
  }
  return hash
}

export function hamming(a, b) {
  if (!a || !b) return 64
  let d = 0
  for (let i = 0; i < 8; i++) {
    let v = a[i] ^ b[i]
    while (v) { d += v & 1; v >>= 1 }
  }
  return d
}

/** 平均绝对像素差，0..1。 */
export function pixelDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (a.length * 255)
}

export function levelOf(distance, pix) {
  // 像素差兜底：dHash 对整体亮度平移不敏感，亮度大跳（转场 / 闪白）靠像素差抓
  if (distance > 12 || pix > 0.18) return 'dirty'
  if (distance >= 3 || pix > 0.02) return 'minor'
  return 'static'
}

/**
 * 逐帧跟踪器。push(gray, t) 返回本帧的变化等级，并累计到下一次轻判断。
 */
export class ChangeTracker {
  constructor() { this.reset() }

  reset() {
    this.prevGray = null
    this.prevHash = null
    this.accum = 0
    this.dirty = 0
    this.levels = []          // 最近 10 秒的等级，用于判断「高频滚动」与「基本静止」
    this.history = []         // { t, hash } 每 10 秒抽一个，保留 10 分钟，用于 novelty
    this.lastHistoryAt = 0
  }

  push(gray, t = Date.now()) {
    const hash = dhash(gray)
    const distance = this.prevHash ? hamming(hash, this.prevHash) : 64
    const pix = this.prevGray ? pixelDiff(gray, this.prevGray) : 1
    const level = this.prevHash ? levelOf(distance, pix) : 'dirty'
    this.prevGray = gray
    this.prevHash = hash
    if (level === 'minor') this.accum += distance
    if (level === 'dirty') { this.dirty++; this.accum += distance }
    this.levels.push(level)
    if (this.levels.length > 10) this.levels.shift()
    if (t - this.lastHistoryAt >= 10000) {
      this.history.push({ t, hash })
      this.lastHistoryAt = t
      while (this.history.length && t - this.history[0].t > 10 * 60 * 1000) this.history.shift()
    }
    return { level, distance, pix, hash }
  }

  /** 轻判断后清零累计量。 */
  consume() {
    const snapshot = { accum: this.accum, dirty: this.dirty }
    this.accum = 0
    this.dirty = 0
    return snapshot
  }

  /** 最近 10 秒基本静止？ */
  isStill() {
    return this.levels.length >= 5 && this.levels.filter((l) => l === 'static').length >= this.levels.length - 1
  }

  /**
   * 高频滚动 / 密集操作：最近 6 帧里有 >= 5 帧在变、但多半只是「轻微」——
   * 像在滚动长页面或拖动，而不是剧情切镜。只用画面判断，不挂任何键鼠钩子。
   */
  isBusyScrolling() {
    const recent = this.levels.slice(-6)
    if (recent.length < 6) return false
    const moving = recent.filter((l) => l !== 'static').length
    const minor = recent.filter((l) => l === 'minor').length
    return moving >= 5 && minor >= 3
  }

  /** 和最近 10 分钟（30 秒以前）比是不是新的：0..1。 */
  novelty(hash, t = Date.now()) {
    const old = this.history.filter((h) => t - h.t > 30000)
    if (!old.length) return 0.6
    let best = 64
    for (const h of old) best = Math.min(best, hamming(hash, h.hash))
    return Math.max(0, Math.min(1, (best - 3) / 20))
  }
}
