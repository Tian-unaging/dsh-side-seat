/**
 * 截屏：三个后端，按 A → B → C 顺序探测，用第一个可用的（5.3）。
 * 当前后端名写进状态，设置页显示。三个都不可用 -> 明确报「无法捕获屏幕」，
 * A 轴整体禁用，但 B 轴（工作区工具里截屏以外的能力）照常。
 *
 * 环境变量 DSH_SIDE_SEAT_CAPTURE=electron|ffmpeg|pwsh 可强制某一个（现场排障用）。
 */
import { platformStatus } from '../compat.js'
import { errMsg, log } from '../util.js'
import { createElectronBackend } from './electron.js'
import { createFfmpegBackend } from './ffmpeg.js'
import { createPwshBackend } from './pwsh.js'

export function createCapture() {
  const all = [createElectronBackend(), createFfmpegBackend(), createPwshBackend()]
  let active = null
  let probing = null
  let attempts = []
  let lastError = ''

  async function probe(force = false) {
    if (active && !force) return { ok: true, backend: active.id, attempts }
    if (probing) return probing
    probing = (async () => {
      attempts = []
      const platform = platformStatus()
      if (!platform.ok) {
        attempts.push({ id: 'platform', ok: false, reason: platform.reason })
        return { ok: false, backend: null, attempts, reason: platform.reason }
      }
      const forced = process.env.DSH_SIDE_SEAT_CAPTURE
      const order = forced ? all.filter((b) => b.id === forced) : all
      for (const backend of order) {
        const started = Date.now()
        try {
          const p = await backend.probe()
          if (!p.ok) { attempts.push({ id: backend.id, ok: false, reason: p.reason }); continue }
          // 真截一帧才算数（验收 3：开始后 2 秒内拿到第一帧；冷启动的 PowerShell 允许更久）
          const frame = await backend.grab({ fullWidth: 640, thumbWidth: 256 })
          if (!frame?.full?.length) throw new Error('截到了空帧')
          attempts.push({ id: backend.id, ok: true, ms: Date.now() - started })
          active = backend
          log(`截屏后端：${backend.label}（${Date.now() - started} ms）`)
          return { ok: true, backend: backend.id, attempts }
        } catch (error) {
          attempts.push({ id: backend.id, ok: false, reason: errMsg(error) })
          try { backend.dispose() } catch { /* ignore */ }
        }
      }
      const reason = '无法捕获屏幕：三个截屏后端都不可用（' + attempts.map((a) => `${a.id}: ${a.reason}`).join('；') + '）'
      return { ok: false, backend: null, attempts, reason }
    })()
    try { return await probing } finally { probing = null }
  }

  async function grab(opts = {}) {
    if (!active) {
      const p = await probe()
      if (!p.ok) throw new Error(p.reason)
    }
    try {
      const frame = await active.grab(opts)
      lastError = ''
      return { ...frame, t: Date.now(), backend: active.id }
    } catch (error) {
      lastError = errMsg(error)
      throw error
    }
  }

  function release() {
    for (const backend of all) {
      try { backend.dispose() } catch { /* ignore */ }
    }
    active = null
  }

  return {
    probe,
    grab,
    release,
    get backend() { return active ? active.id : null },
    get backendLabel() { return active ? active.label : null },
    get attempts() { return attempts },
    get lastError() { return lastError },
  }
}
