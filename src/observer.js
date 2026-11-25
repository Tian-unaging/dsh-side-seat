/**
 * A 轴：实时陪看的观察循环（4.1.1 / 5.7 / 第 6 章）。
 *
 *   [捕获]   每 1 秒截一帧，只留在内存（最多最近 10 帧）
 *   [本地差] dHash + 像素差；几乎没变 -> 什么都不做
 *   [轻判断] 每 20 秒（且有变化）或累计 dirty >= 3 时，用缩略图做一次低成本判断
 *   [闸门]   硬闸门 + 显著度
 *   [重判断] 仅当 noteworthy 且通过闸门：近原尺寸一帧 + 关系记忆 + 最近 5 句
 *   [说话]   写进会话；若开了朗读，浏览器端同时念出来
 *
 * 任何一次观察失败都显式降级：截屏失败、模型无视觉、断网 -> 报错并停止发言，绝不编造画面。
 * 观察默认关闭，只有用户点「开始看屏幕」才开始；不记忆上次状态自动恢复。
 */
import { randomUUID } from 'node:crypto'
import { platformStatus } from './compat.js'
import { ChangeTracker } from './diff.js'
import { MODE_OF_CONTENT, budgetFor } from './config.js'
import {
  ANNOYED_SILENCE_MS, CONTENT_HINTS, VISION_CAP_PER_10MIN,
  budgetRemaining, decideBySalience, finalVerdict, hardGate, msUntilNextCredit,
  preGate, runHeavy, runLight, salience, silenceGain,
} from './judge.js'
import { personaText } from './persona.js'
import { Ring, appendLog, errMsg, log, similarity } from './util.js'

const TICK_MS = 1000
const LIGHT_EVERY_MS = 20000
const MAX_CAPTURE_FAILURES = 3
const MOMENT_THROTTLE_MS = 60000

const QUIET_ON = /安静看|别说话|不要说话|闭嘴|安静点|先别说/
const QUIET_OFF = /可以说话了|可以说了|继续说吧|陪我聊|恢复说话/
const ANNOYED = /有点烦|好烦|别吵|太吵了|话太多/

export function createObserver({ getCfg, capture, vision, memory, speaker, audio }) {
  const tracker = new ChangeTracker()
  const frames = new Ring(10)
  const recent = new Ring(5)
  const lines = new Ring(20)
  const visionCalls = []
  const momentLast = new Map()

  const state = {
    status: 'off',            // off | starting | on | paused | error
    reason: '',
    notes: [],                // 降级说明（窗口模式 P1、无法确认视觉能力……）
    startedAt: 0,
    activeMs: 0,
    lastTickAt: 0,
    spoken: 0,
    lastSpeakAt: 0,
    lastLightAt: 0,
    waitUntil: 0,
    light: null,
    scene: { content: null, since: 0, gameSince: 0 },
    failures: 0,
    userSpokeAt: 0,
    silentCount: 0,
    lastSharedAt: 0,
    judging: false,
  }
  let timer = null
  let abort = null

  const now = () => Date.now()

  function visionLast10() {
    const t = now()
    while (visionCalls.length && t - visionCalls[0] > 10 * 60 * 1000) visionCalls.shift()
    return visionCalls.length
  }

  async function moment(reason, stage, throttle = false) {
    state.silentCount++
    if (throttle) {
      const last = momentLast.get(reason) || 0
      if (now() - last < MOMENT_THROTTLE_MS) return
      momentLast.set(reason, now())
    }
    try { await memory.addMoment(reason, { stage }) } catch { /* memory must not break the loop */ }
  }

  /** 当前生效的模式：固定模式直接用；auto 按轻判断的内容类型切换。 */
  function effectiveMode() {
    const cfg = getCfg()
    if (cfg.mode && cfg.mode !== 'auto') return cfg.mode
    return MODE_OF_CONTENT[state.scene?.content] || 'daily'
  }

  /** 当前生效的每小时说话预算（模式 × 频率）。budgetPerHourOverride 只给测试用。 */
  function perHourNow() {
    const cfg = getCfg()
    if (Number.isFinite(cfg.budgetPerHourOverride)) return cfg.budgetPerHourOverride
    return budgetFor(effectiveMode(), cfg.chattiness)
  }

  function budget() {
    return budgetRemaining({ activeMs: state.activeMs, perHour: perHourNow(), spoken: state.spoken })
  }

  function schedule() {
    clearTimeout(timer)
    if (state.status === 'on') timer = setTimeout(() => { tick().catch((e) => log(`tick 失败：${errMsg(e)}`)) }, TICK_MS)
  }

  async function start() {
    if (state.status === 'on' || state.status === 'starting') return snapshot()
    const cfg = getCfg()
    state.notes = []
    state.reason = ''
    const platform = platformStatus()
    if (!platform.ok) return fail(platform.reason)
    state.status = 'starting'
    const model = await vision.checkModel(cfg.visionModel)
    if (model.supported === false) return fail(`${model.reason}。旁座需要能看图的模型，请在设置里换一个。`)
    if (model.supported === null) state.notes.push(`无法预先确认 ${model.model} 的视觉能力（${model.reason}）；第一次看图失败会立刻停下并报错。`)
    const probe = await capture.probe()
    if (!probe.ok) return fail(`${probe.reason}。实时陪看已禁用，工作区里的工具仍可用。`)
    if (cfg.scope === 'window') state.notes.push('「当前窗口」模式是 P1，这一版按整个主屏观察。')
    if (state.status !== 'starting') return snapshot() // 期间被停止
    abort = new AbortController()
    tracker.reset()
    frames.clear()
    Object.assign(state, {
      status: 'on', startedAt: now(), activeMs: 0, lastTickAt: now(), spoken: 0, lastLightAt: now() - LIGHT_EVERY_MS + 3000,
      waitUntil: 0, light: null, scene: { content: null, since: 0, gameSince: 0 }, failures: 0, silentCount: 0, judging: false,
    })
    await memory.updateBond({ speakBudgetPerHour: perHourNow() }).catch(() => {})
    audio.start()
    log(`开始观察（截屏后端 ${capture.backend}，模式 ${effectiveMode()}，预算 ${perHourNow()}/小时）`)
    schedule()
    return snapshot()
  }

  function fail(reason) {
    state.status = 'error'
    state.reason = reason
    stopInternals()
    log(`无法开始 / 已停止：${reason}`)
    return snapshot()
  }

  function stopInternals() {
    clearTimeout(timer)
    timer = null
    abort?.abort()
    abort = null
    frames.clear()
    tracker.reset()
    capture.release()
    audio.stop()
  }

  async function stop() {
    const minutes = state.activeMs / 60000
    state.status = 'off'
    state.reason = ''
    stopInternals()
    speaker.clearPending()
    if (minutes > 0) {
      const b = memory.bond()
      await memory.updateBond({ totalMinutes: (b.totalMinutes || 0) + minutes }).catch(() => {})
    }
    return snapshot()
  }

  function pause() {
    if (state.status !== 'on') return snapshot()
    state.status = 'paused'
    clearTimeout(timer)
    abort?.abort()
    abort = new AbortController()
    frames.clear() // 暂停期间不截屏，内存里的帧也清掉
    return snapshot()
  }

  function resume() {
    if (state.status !== 'paused') return snapshot()
    state.status = 'on'
    state.lastTickAt = now()
    tracker.reset()
    schedule()
    return snapshot()
  }

  async function tick() {
    if (state.status !== 'on') return
    const t = now()
    state.activeMs += Math.min(3000, Math.max(0, t - state.lastTickAt))
    state.lastTickAt = t
    const cfg = getCfg()
    let frame
    try {
      frame = await capture.grab({ fullWidth: vision.targetWidth(cfg.visionModel, 1280), thumbWidth: 512 })
      state.failures = 0
    } catch (error) {
      state.failures++
      if (state.failures >= MAX_CAPTURE_FAILURES) {
        fail(`截屏连续失败：${errMsg(error)}。已停止观察与发言，没有画面就不会说「我看到」。`)
        return
      }
      schedule()
      return
    }
    if (state.status !== 'on') return
    frames.push(frame)
    const change = tracker.push(frame.gray, t)
    frame.hash = change.hash
    const audioState = audio.l0.state()
    const due = !state.judging && t >= state.waitUntil && (
      (t - state.lastLightAt >= LIGHT_EVERY_MS && (tracker.accum > 0 || audioState.speakingNow))
      || tracker.dirty >= 3
    )
    if (due) {
      state.lastLightAt = t
      const consumed = tracker.consume()
      const blocked = preGate({ bond: memory.bond(), now: t, budget: budget(), visionCallsLast10Min: visionLast10() })
      if (blocked) {
        await moment(blocked, 'pre', true)
      } else {
        state.judging = true
        judge(frame, consumed).catch((e) => {
          // 断网 / 模型报错：显式降级，停止发言
          const msg = errMsg(e)
          if (/ABORT|已取消/i.test(msg)) return
          state.notes = [...state.notes.filter((n) => !n.startsWith('视觉调用失败')), `视觉调用失败：${msg}（这一轮不说话）`].slice(-5)
          moment(`视觉调用失败：${msg}`, 'error', true)
          if (/MODEL_NO_VISION|inputModalities|没有视觉/.test(msg)) fail(msg)
        }).finally(() => { state.judging = false })
      }
    }
    schedule()
  }

  function tasteText() {
    const taste = memory.taste()
    const parts = []
    if (taste.likes.length) parts.push(`喜欢 ${taste.likes.join('、')}`)
    if (taste.dislikes.length) parts.push(`不喜欢 ${taste.dislikes.join('、')}`)
    parts.push(`剧透容忍度 ${taste.spoilerTolerance}`)
    if (taste.pace) parts.push(`节奏偏好 ${taste.pace}`)
    return parts.join('；')
  }

  async function judge(frame, consumed) {
    const cfg = getCfg()
    const signal = abort?.signal
    visionCalls.push(now())
    const sceneText = state.scene.content
      ? `已连续看到「${state.scene.content}」约 ${Math.round((now() - state.scene.since) / 1000)} 秒；这一段累计变化 ${consumed.accum}，显著变化 ${consumed.dirty} 次`
      : ''
    const light = await runLight(vision, {
      model: cfg.visionModel,
      thumb: frame.thumb,
      context: {
        previous: state.light ? `${state.light.see}（${state.light.content}）` : '',
        audioText: cfg.listen ? audio.l0.describe() : '（用户关闭了听声音）',
        tasteText: tasteText(),
        sceneText,
      },
      signal,
    })
    if (state.status !== 'on') return
    const L = light.parsed
    if (!L) {
      // 解析失败必须留下原文，否则只能看到「无法解析」四个字，排不了障。
      appendLog('light.log', `parse failed: ${String(light.raw).slice(0, 400).replace(/\s+/g, ' ')}`)
      await moment('轻判断输出无法解析', 'light')
      return
    }
    const t = now()
    if (L.content !== state.scene.content) state.scene = { content: L.content, since: t, gameSince: L.content === 'game' ? t : 0 }
    state.light = { ...L, t }
    if ((L.content === 'long' || L.content === 'short' || L.content === 'game') && t - state.lastSharedAt > 5 * 60 * 1000 && L.see && !L.unsure) {
      state.lastSharedAt = t
      memory.addShared({ see: L.see, content: L.content }).catch(() => {})
    }
    if (!L.noteworthy) { await moment(`不值得说：${L.see || '（无描述）'}`, 'light'); return }
    const audioState = audio.l0.state()
    const gate = hardGate({ light: L, still: tracker.isStill(), audio: audioState, scrolling: tracker.isBusyScrolling(), scene: state.scene, now: t })
    if (gate) { await moment(gate, 'gate'); return }
    const pre = salience({
      turn: L.turningPoint,
      taste: L.tasteMatch,
      ledgerEcho: 0,
      novelty: tracker.novelty(frame.hash, t),
      audio: cfg.listen ? audio.l0.signal() : 0,
      silenceGain: silenceGain(state.lastSpeakAt ? t - state.lastSpeakAt : Infinity),
    })
    const d = decideBySalience(pre)
    if (d === 'WAIT') { state.waitUntil = t + 60000; await moment(`WAIT：显著度 ${pre.toFixed(2)}`, 'salience'); return }
    if (d === 'SILENT') { await moment(`没到该说的时候（显著度 ${pre.toFixed(2)}）`, 'salience'); return }
    if (visionLast10() >= VISION_CAP_PER_10MIN) { await moment('10 分钟内视觉调用已达上限', 'pre'); return }
    visionCalls.push(now())
    const latest = frames.last() || frame
    const b = memory.bond()
    const heavy = await runHeavy(vision, {
      model: cfg.visionModel,
      full: latest.full,
      persona: personaText(cfg, b),
      context: {
        light: L,
        audioText: cfg.listen ? audio.l0.describe() : '（用户关闭了听声音）',
        cues: cfg.listen ? audio.cueLines() : [],
        recent: recent.last(5),
        tasteText: tasteText(),
        ledgerText: memory.ledger().slice(-8).map((r) => `${r.topic}：${r.stance}`).join('；'),
        sharedText: memory.shared().slice(-5).map((s) => s.line || s.see).filter(Boolean).join('；'),
        contentHint: CONTENT_HINTS[L.content] || CONTENT_HINTS.other,
      },
      signal,
    })
    if (state.status !== 'on') return
    const verdict = finalVerdict({ heavy: heavy.parsed, preSalience: pre, recentLines: lines.items.map((l) => l.line), similarity })
    if (heavy.parsed?.stance && verdict.decision === 'SPEAK') memory.upsertStance(heavy.parsed.stance.topic, heavy.parsed.stance.stance).catch(() => {})
    if (verdict.decision === 'WAIT') {
      state.waitUntil = now() + (heavy.parsed?.nextCheckSeconds || 60) * 1000
      await moment(`WAIT：${verdict.reason}`, 'heavy')
      return
    }
    if (verdict.decision !== 'SPEAK') { await moment(verdict.reason, 'heavy'); return }
    // 说之前再过一遍会变的闸门
    const again = preGate({ bond: memory.bond(), now: now(), budget: budget(), visionCallsLast10Min: 0 })
    if (again) { await moment(again, 'final'); return }
    await speak(verdict.line, { see: L.see, content: L.content, reason: verdict.reason })
  }

  async function speak(line, meta) {
    const id = randomUUID()
    audio.echo.markSpoken(line)
    const res = await speaker.say(line)
    state.spoken++
    state.lastSpeakAt = now()
    const sharedId = await memory.addShared({ see: meta.see, line, content: meta.content, accepted: null }).catch(() => null)
    lines.push({ id, t: now(), line, path: res.path, sharedId, reason: meta.reason, feedback: null })
    recent.push(`旁座：${line}`)
    log(`SPEAK（${res.path}）：${line}`)
  }

  async function feedback(kind, lineId) {
    const b = memory.bond()
    const target = lineId ? lines.items.find((l) => l.id === lineId) : lines.last()
    if (kind === 'annoying') {
      const streak = (b.annoyedStreak || 0) + 1
      if (streak >= 2) {
        await memory.updateBond({ annoyedStreak: 0, annoyedUntil: now() + ANNOYED_SILENCE_MS })
        await moment('连续两次被嫌烦，进入 10 分钟静默', 'feedback')
      } else {
        await memory.updateBond({ annoyedStreak: streak })
      }
      if (target) { target.feedback = 'annoying'; if (target.sharedId) memory.markShared(target.sharedId, { accepted: false }).catch(() => {}) }
    } else if (kind === 'good') {
      await memory.updateBond({ annoyedStreak: 0, intimacy: Math.min(1, (b.intimacy || 0) + 0.02) })
      if (target) { target.feedback = 'good'; if (target.sharedId) memory.markShared(target.sharedId, { accepted: true }).catch(() => {}) }
    }
    return snapshot()
  }

  async function setQuiet(on) {
    await memory.updateBond({ quietMode: Boolean(on) })
    return snapshot()
  }

  /** 旁座会话里用户发了消息：立刻打断朗读；识别口令。 */
  async function onUserMessage(text) {
    state.userSpokeAt = now()
    recent.push(`你：${String(text).slice(0, 80)}`)
    if (QUIET_ON.test(text)) await setQuiet(true)
    else if (QUIET_OFF.test(text)) await setQuiet(false)
    if (ANNOYED.test(text)) await feedback('annoying')
  }

  function snapshot() {
    const cfg = getCfg()
    const b = memory.bond()
    const t = now()
    const a = audio.status()
    const pending = speaker.pending
    return {
      status: state.status,
      observing: state.status === 'on' || state.status === 'paused' || state.status === 'starting',
      reason: state.reason,
      notes: state.notes,
      startedAt: state.startedAt,
      activeMinutes: Math.floor(state.activeMs / 60000),
      activeMs: state.activeMs,
      spoken: state.spoken,
      budget: {
        perHour: perHourNow(),
        mode: effectiveMode(),
        remaining: budget(),
        nextCreditInMs: msUntilNextCredit({ activeMs: state.activeMs, perHour: perHourNow(), spoken: state.spoken }),
      },
      quietMode: Boolean(b.quietMode),
      annoyedUntil: b.annoyedUntil || 0,
      capture: { backend: capture.backend, label: capture.backendLabel, attempts: capture.attempts, lastError: capture.lastError },
      vision: { model: cfg.visionModel, callsLast10Min: visionLast10(), cap: VISION_CAP_PER_10MIN, stats: vision.stats },
      scene: state.scene.content ? { content: state.scene.content, forSec: Math.round((t - state.scene.since) / 1000), see: state.light?.see || '' } : null,
      audio: a,
      lastLine: lines.last() ? { ...lines.last() } : null,
      lines: lines.items.slice(-5).map((l) => ({ id: l.id, t: l.t, line: l.line, path: l.path, feedback: l.feedback })),
      speakPath: { last: speaker.lastPath, status: speaker.pathStatus, setting: cfg.speakPath },
      pending,
      userSpokeAt: state.userSpokeAt,
      silentCount: state.silentCount,
      voice: cfg.voice,
    }
  }

  return { start, stop, pause, resume, feedback, setQuiet, onUserMessage, snapshot, get status() { return state.status } }
}
