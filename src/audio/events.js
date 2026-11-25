/**
 * L0 音频事件（5.4）：纯本地 DSP，不需要模型，几乎不花钱。P0 必做。
 *
 * 输入是 1 秒一块的单声道 PCM（Float32，-1..1）。输出：
 *   rmsDb    响度
 *   zcr      过零率
 *   mod      50ms 子帧能量的变异系数——人声有约 4Hz 的音节起伏，音乐通常更平
 *   onsets   起音次数（能量突跳）
 *   kind     silence | speech | music | mixed
 *
 * 浏览器端（client.js）用同一套公式算好每秒摘要送过来；host 端只有在
 * 走 ffmpeg dshow 兜底时才自己算。两份实现保持同一公式。
 */

export function analyzePcm(samples, sampleRate) {
  const n = samples.length
  if (!n) return { rmsDb: -120, zcr: 0, mod: 0, onsets: 0, kind: 'silence', pauseMs: 1000 }
  let sum = 0
  let crossings = 0
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    sum += s * s
    if (i && (s >= 0) !== (samples[i - 1] >= 0)) crossings++
  }
  const rms = Math.sqrt(sum / n)
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120
  const zcr = crossings / n
  const frame = Math.max(1, Math.round(sampleRate * 0.05))
  const energies = []
  for (let i = 0; i + frame <= n; i += frame) {
    let e = 0
    for (let j = i; j < i + frame; j++) e += samples[j] * samples[j]
    energies.push(e / frame)
  }
  const mean = energies.reduce((a, b) => a + b, 0) / (energies.length || 1)
  const variance = energies.reduce((a, b) => a + (b - mean) ** 2, 0) / (energies.length || 1)
  const mod = mean > 0 ? Math.sqrt(variance) / mean : 0
  let onsets = 0
  let quietFrames = 0
  for (let i = 1; i < energies.length; i++) {
    if (energies[i] > energies[i - 1] * 4 && energies[i] > 1e-5) onsets++
    const db = energies[i] > 0 ? 10 * Math.log10(energies[i]) : -120
    if (db < -45) quietFrames++
  }
  return { rmsDb, zcr, mod, onsets, kind: classify({ rmsDb, zcr, mod }), pauseMs: quietFrames * 50 }
}

export function classify({ rmsDb, zcr, mod }) {
  if (rmsDb < -50) return 'silence'
  const speechy = mod > 0.7 && zcr > 0.01 && zcr < 0.2
  const musicy = mod < 0.45
  if (speechy) return 'speech'
  if (musicy) return 'music'
  return 'mixed'
}

/**
 * 每秒摘要的滑动窗口（保留 60 秒）。
 * 摘要格式：{ t, rmsDb, zcr, mod, onsets, kind, pauseMs, self }
 * self = 旁座自己正在朗读（5.4.8：事件继续，但不计入台词）。
 */
export class L0Tracker {
  constructor() { this.items = []; this.lastAt = 0; this.backend = null }

  push(summary) {
    const item = { ...summary, t: Number(summary.t) || Date.now() }
    this.items.push(item)
    this.lastAt = Date.now()
    while (this.items.length && item.t - this.items[0].t > 60000) this.items.shift()
  }

  pushMany(list) { for (const s of list || []) this.push(s) }

  /** 有没有在持续收到声音摘要（5 秒内）。 */
  get live() { return Date.now() - this.lastAt < 5000 }

  window(ms) {
    const now = Date.now()
    return this.items.filter((i) => now - i.t <= ms && !i.self)
  }

  state() {
    const w10 = this.window(10000)
    const w3 = this.window(3000)
    const pct = (list, kind) => (list.length ? list.filter((i) => i.kind === kind).length / list.length : 0)
    const speech10 = pct(w10, 'speech') + pct(w10, 'mixed') * 0.5
    const music10 = pct(w10, 'music')
    const silent10 = pct(w10, 'silence')
    const loud = w3.some((i) => i.rmsDb > -12)
    const prev = this.window(20000).filter((i) => Date.now() - i.t > 5000)
    const prevDb = prev.length ? prev.reduce((a, b) => a + b.rmsDb, 0) / prev.length : null
    const nowDb = w3.length ? w3.reduce((a, b) => a + b.rmsDb, 0) / w3.length : null
    const suddenQuiet = prevDb !== null && nowDb !== null && prevDb > -35 && nowDb < prevDb - 15
    const suddenLoud = prevDb !== null && nowDb !== null && nowDb > prevDb + 12
    let silentFor = 0
    for (let i = this.items.length - 1; i >= 0 && this.items[i].kind === 'silence'; i--) silentFor++
    return {
      live: this.live,
      speakingNow: pct(w3, 'speech') >= 0.5,
      speech10,
      music10,
      silent10,
      musicOnly: w10.length >= 5 && music10 >= 0.7 && speech10 < 0.15,
      loud,
      suddenQuiet,
      suddenLoud,
      silentForSec: silentFor,
      selfSpeaking: this.items.length ? Boolean(this.items[this.items.length - 1].self) : false,
    }
  }

  /** 给模型看的一句话；没有声音数据时如实说没有。 */
  describe() {
    if (!this.live) return '（没有收到声音数据）'
    const s = this.state()
    const parts = []
    if (s.speakingNow) parts.push('现在有人在说话')
    else if (s.musicOnly) parts.push('现在在放音乐 / BGM，没人说话')
    else if (s.silent10 > 0.7) parts.push(`基本安静${s.silentForSec >= 3 ? `，已经停了 ${s.silentForSec} 秒` : ''}`)
    else parts.push(`说话占比约 ${Math.round(s.speech10 * 100)}%，音乐约 ${Math.round(s.music10 * 100)}%`)
    if (s.loud) parts.push('这段很吵')
    if (s.suddenQuiet) parts.push('刚才突然安静了')
    if (s.suddenLoud) parts.push('刚才突然变响')
    return parts.join('；')
  }

  /** 显著度里的 audioSignal：有人说话 / 语气突变 / 突然安静 -> 1；纯音乐 0.3；静 0。 */
  signal() {
    if (!this.live) return 0
    const s = this.state()
    if (s.speakingNow || s.suddenQuiet || s.suddenLoud) return 1
    if (s.musicOnly) return 0.3
    return s.speech10 > 0.3 ? 0.6 : 0.1
  }

  reset() { this.items = []; this.lastAt = 0 }
}
