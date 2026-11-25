/**
 * 回声（5.4.8）：旁座朗读时，系统音频输出会被采回来，形成自我收听。
 * 这不是优化，是正确性问题——不处理的话它会开始回答自己。两层：
 *
 *   1. 朗读期间暂停 ASR（浏览器端不送片段；host 端也拒收 self 片段）；
 *      L0 事件继续，但标记 self，不计入台词。
 *   2. 把刚朗读过的文本放进短期过滤表，丢掉与它高度重合（相似度 > 0.8）的识别结果。
 */
import { similarity } from '../util.js'

export const ECHO_SIMILARITY = 0.8
const KEEP_MS = 90 * 1000

export class EchoFilter {
  constructor() { this.spoken = []; this.selfUntil = 0 }

  /** 记录一句刚说出 / 即将朗读的话。估算朗读时长：中文约 4.5 字/秒，加 1.5 秒余量。 */
  markSpoken(text, now = Date.now()) {
    const t = String(text || '')
    this.spoken.push({ text: t, t: now })
    this.selfUntil = Math.max(this.selfUntil, now + (t.length / 4.5) * 1000 + 1500)
    this.prune(now)
  }

  /** 浏览器报告朗读开始 / 结束时更新。 */
  setSelfSpeaking(active, now = Date.now()) {
    if (active) this.selfUntil = Math.max(this.selfUntil, now + 30000)
    else this.selfUntil = Math.min(this.selfUntil, now + 800)
  }

  isSelfSpeaking(now = Date.now()) { return now < this.selfUntil }

  /** 识别结果是不是自己的回声。 */
  isEcho(text, now = Date.now()) {
    this.prune(now)
    const t = String(text || '')
    if (!t.trim()) return true
    return this.spoken.some((s) => similarity(s.text, t) > ECHO_SIMILARITY || (t.length >= 6 && s.text.includes(t)))
  }

  prune(now = Date.now()) { this.spoken = this.spoken.filter((s) => now - s.t < KEEP_MS) }

  reset() { this.spoken = []; this.selfUntil = 0 }
}
