/**
 * 声音中枢：选择采集后端、汇总 L0、排队听写、维护台词时间轴、回声过滤。
 *
 * 时间轴统一（5.4.10）：台词 cue 与画面帧都用同一个时间地址（epoch 毫秒），
 * 所以旁座能说「刚才那句台词的时候，画面正好切到窗外」。
 */
import { errMsg, log } from '../util.js'
import { pcm16ToWav, isWav } from './asr.js'
import { createDshowCapture } from './capture.js'
import { EchoFilter } from './echo.js'
import { L0Tracker } from './events.js'

const CUE_KEEP_MS = 10 * 60 * 1000

export function createAudioHub({ asr, getCfg }) {
  const l0 = new L0Tracker()
  const echo = new EchoFilter()
  let cues = []
  let mode = 'off'            // off | waiting | client | dshow | unsupported
  let clientReason = ''
  let dshowReason = ''
  let active = false
  let fallbackTimer = null
  const queue = []
  let busy = false
  const stats = { segmentsIn: 0, segmentsDropped: 0, transcribed: 0, echoDropped: 0, failures: 0, lastError: '' }

  const dshow = createDshowCapture({
    onSummary: (s) => { if (active) l0.push(s) },
    onSegment: (pcm, t0) => enqueue(pcm16ToWav(pcm, 16000), t0),
    isSelf: () => echo.isSelfSpeaking(),
  })

  async function tryDshow() {
    if (!active || mode === 'client' || mode === 'dshow') return
    const p = await dshow.probe().catch((e) => ({ ok: false, reason: errMsg(e) }))
    if (p.ok && active && mode !== 'client' && dshow.start()) {
      mode = 'dshow'
      log(`系统声音：ffmpeg dshow（${dshow.device}）`)
      return
    }
    dshowReason = p.reason || dshow.reason || '无法启动 dshow 采集'
    if (mode !== 'client') mode = 'unsupported'
  }

  function start() {
    const cfg = getCfg()
    stop()
    if (!cfg.listen) { mode = 'off'; return }
    active = true
    mode = 'waiting'
    clientReason = ''
    dshowReason = ''
    // 浏览器端 getDisplayMedia 优先；6 秒内没有收到声音摘要就试 dshow
    fallbackTimer = setTimeout(() => { if (mode === 'waiting') tryDshow() }, 6000)
  }

  function stop() {
    active = false
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null }
    dshow.stop()
    l0.reset()
    echo.reset()
    cues = []
    queue.length = 0
    mode = 'off'
  }

  /** 浏览器报告 getDisplayMedia 的结果。 */
  function clientReport({ ok, reason }) {
    if (!active) return
    if (ok) {
      mode = 'client'
      dshow.stop()
      clientReason = ''
    } else {
      clientReason = String(reason || '浏览器端拿不到系统声音')
      if (mode === 'client') mode = 'waiting'
      tryDshow()
    }
  }

  function clientEvents(list) {
    if (!active) return
    if (mode !== 'client') {
      mode = 'client'
      dshow.stop() // 浏览器端已经在送声音：不允许两路同时采
    }
    l0.pushMany((list || []).slice(0, 30).map((s) => ({ ...s, self: Boolean(s.self) || echo.isSelfSpeaking(Number(s.t) || Date.now()) })))
  }

  function enqueue(wav, t0) {
    stats.segmentsIn++
    const cfg = getCfg()
    if (!active || cfg.asrEngine === 'none' || !asr.status(cfg).ready) { stats.segmentsDropped++; return }
    if (echo.isSelfSpeaking(t0)) { stats.segmentsDropped++; return }
    if (!isWav(wav)) { stats.segmentsDropped++; return }
    if (queue.length >= 2) { queue.shift(); stats.segmentsDropped++ } // 宁丢不堆：实时场景对延迟敏感
    queue.push({ wav, t0 })
    pump()
  }

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (queue.length && active) {
        const job = queue.shift()
        try {
          const res = await asr.transcribe(job.wav)
          for (const seg of res.segments) {
            if (echo.isEcho(seg.text)) { stats.echoDropped++; continue }
            cues.push({ t0: job.t0 + (seg.start || 0) * 1000, t1: job.t0 + (seg.end || seg.start || 0) * 1000, text: seg.text, cloud: res.cloud })
            stats.transcribed++
          }
          const now = Date.now()
          cues = cues.filter((c) => now - c.t0 < CUE_KEEP_MS)
        } catch (error) {
          stats.failures++
          stats.lastError = errMsg(error)
        }
        // job.wav 出了作用域即被回收：音频只在内存里，识别完即丢
      }
    } finally {
      busy = false
    }
  }

  /** 最近的台词，带相对时间；没有引擎时返回空数组（绝不编台词）。 */
  function cueLines(now = Date.now(), windowMs = 90000) {
    if (getCfg().asrEngine === 'none') return []
    return cues
      .filter((c) => now - c.t0 <= windowMs)
      .slice(-8)
      .map((c) => `[-${Math.max(0, Math.round((now - c.t0) / 1000))}s] ${c.text}${c.cloud ? '（云端转写）' : ''}`)
  }

  function status() {
    const cfg = getCfg()
    const asrStatus = asr.status(cfg)
    const hearSound = active && l0.live
    const transcript = hearSound && asrStatus.ready
    let label
    if (!cfg.listen) label = '没开听声音 · 听不见台词'
    else if (transcript) label = '也在听'
    else if (hearSound) label = '能听到声音 · 听不见台词'
    else label = '听不见台词 · 也收不到声音'
    let reason = ''
    if (cfg.listen && !hearSound) reason = [clientReason, dshowReason].filter(Boolean).join('；') || (mode === 'waiting' ? '正在等待系统声音' : '')
    else if (hearSound && !asrStatus.ready) reason = asrStatus.reason
    return {
      mode,
      listening: active,
      hearSound,
      transcript,
      label,
      reason,
      engine: cfg.asrEngine,
      engineReady: asrStatus.ready,
      cloud: asrStatus.cloud,
      device: dshow.device,
      stats: { ...stats },
    }
  }

  return {
    l0,
    echo,
    start,
    stop,
    clientReport,
    clientEvents,
    clientSegment: (wav, t0) => enqueue(wav, t0),
    cueLines,
    status,
    get mode() { return mode },
  }
}
