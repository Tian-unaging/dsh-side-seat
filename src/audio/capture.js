/**
 * 系统音频采集（5.4.1）。
 *
 *   A  客户端 getDisplayMedia 的 audio track —— 在浏览器半边（client.js）实现，
 *      每秒把 L0 摘要送过来；检测到人声且配了引擎时，再送 3–5 秒的 WAV 片段。
 *   B  ffmpeg dshow 读「立体声混音」—— 本文件实现，host 端自己算 L0。
 *   C  仅文件 —— 不抓实时音频，只在 B 轴解读视频文件时提取音轨。
 *
 * 探测顺序 A -> B，C 兜底。都不可用：实时听标记为不支持，状态条写「听不见」，
 * A 轴只用画面工作。绝不静默。
 *
 * 音频块只在内存里，识别完即丢；只有文字结果进时间轴。
 */
import { spawn } from 'node:child_process'
import { findBinary, killTree, run, track } from '../media.js'
import { errMsg, log } from '../util.js'
import { analyzePcm } from './events.js'

const RATE = 16000
const LOOPBACK_NAMES = /立体声混音|Stereo Mix|What U Hear|Wave Out Mix|混音|Loopback/i

/** 切片器：在停顿处切分 3–5 秒的人声片段，不在词中间切。浏览器端用同一套规则。 */
export class SpeechSegmenter {
  constructor(onSegment, { rate = RATE } = {}) {
    this.rate = rate
    this.onSegment = onSegment
    this.buf = []
    this.len = 0
    this.t0 = 0
    this.active = false
  }

  /** chunk: Int16Array（rate Hz，单声道），summary: analyzePcm 的结果。 */
  push(chunk, summary, t, { self = false } = {}) {
    if (self) { this.reset(); return } // 朗读期间不切片、不送识别
    const voiced = summary.kind === 'speech' || summary.kind === 'mixed'
    if (!this.active && voiced) { this.active = true; this.t0 = t; this.buf = []; this.len = 0 }
    if (!this.active) return
    this.buf.push(chunk)
    this.len += chunk.length
    const sec = this.len / this.rate
    const paused = summary.pauseMs >= 350 || summary.kind === 'silence'
    if ((sec >= 3 && paused) || sec >= 5) this.flush()
    else if (!voiced && sec < 1.5) this.reset()
  }

  flush() {
    if (this.len >= this.rate * 1.5) {
      const pcm = new Int16Array(this.len)
      let off = 0
      for (const c of this.buf) { pcm.set(c, off); off += c.length }
      try { this.onSegment(pcm, this.t0) } catch (error) { log(`片段处理失败：${errMsg(error)}`) }
    }
    this.reset()
  }

  reset() { this.active = false; this.buf = []; this.len = 0 }
}

export async function listDshowAudioDevices(ffmpeg) {
  const res = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeoutMs: 10000 }).catch((e) => ({ stderr: errMsg(e) }))
  const devices = []
  for (const line of String(res.stderr || '').split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\(audio\)/.exec(line)
    if (m) devices.push(m[1])
  }
  // 旧版 ffmpeg 的格式：先一行 "DirectShow audio devices"，后面是 "名字"
  if (!devices.length) {
    let inAudio = false
    for (const line of String(res.stderr || '').split(/\r?\n/)) {
      if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue }
      if (/DirectShow video devices/i.test(line)) { inAudio = false; continue }
      const m = /"([^"]+)"/.exec(line)
      if (inAudio && m && !/Alternative name/i.test(line)) devices.push(m[1])
    }
  }
  return devices
}

/**
 * 后端 B：ffmpeg dshow。onSummary(summary) 每秒一次；onSegment(pcm, t0) 人声片段。
 * isSelf() 返回旁座此刻是否在朗读。
 */
export function createDshowCapture({ onSummary, onSegment, isSelf }) {
  let child = null
  let device = null
  let reason = ''

  async function probe() {
    if (process.platform !== 'win32') { reason = 'dshow 只在 Windows 上可用'; return { ok: false, reason } }
    const ffmpeg = findBinary('ffmpeg')
    if (!ffmpeg) { reason = '没有 ffmpeg'; return { ok: false, reason } }
    const devices = await listDshowAudioDevices(ffmpeg)
    device = process.env.DSH_SIDE_SEAT_AUDIO_DEVICE || devices.find((d) => LOOPBACK_NAMES.test(d)) || null
    if (!device) {
      reason = '系统里没有启用「立体声混音」（Stereo Mix）类录音设备'
      return { ok: false, reason, devices }
    }
    return { ok: true, device }
  }

  function start() {
    const ffmpeg = findBinary('ffmpeg')
    if (!ffmpeg || !device) return false
    child = track(spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${device}`, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }))
    const segmenter = new SpeechSegmenter(onSegment)
    let pending = Buffer.alloc(0)
    const block = RATE * 2
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= block) {
        const piece = pending.subarray(0, block)
        pending = pending.subarray(block)
        const int16 = new Int16Array(piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.length))
        const floats = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768
        const summary = analyzePcm(floats, RATE)
        const t = Date.now()
        const self = Boolean(isSelf?.())
        onSummary({ ...summary, t, self })
        segmenter.push(int16, summary, t, { self })
      }
    })
    child.stderr.on('data', () => {})
    child.once('exit', (code) => {
      if (child) log(`dshow 音频采集退出（${code}）`)
      child = null
    })
    return true
  }

  function stop() {
    if (child) { const c = child; child = null; killTree(c) }
  }

  return {
    id: 'dshow',
    probe,
    start,
    stop,
    get running() { return Boolean(child) },
    get device() { return device },
    get reason() { return reason },
  }
}
