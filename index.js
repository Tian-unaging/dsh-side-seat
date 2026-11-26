/**
 * 旁座 SideSeat —— Host 半边入口。
 *
 * 不替你操作，不替你看完，只在同一边。
 *
 *   A 轴 实时陪看：插件内部循环（src/observer.js），只在它自己的会话里主动说话
 *   B 轴 被叫去看：四个 side_seat_* 工具（src/tools.js），在任何会话里都只被动响应
 *   C 轴 记得你：  四张表（src/memory.js），决定 A 轴说什么、什么时候闭嘴
 *
 * 契约（已在本机核对过的事实见 README / docs/DETAIL.md）：
 *   - apply(ctx, config) 注册普通工具对象，返回值随插件 fiber 一起回收；
 *   - 可选服务一律 ctx.get(name) 读取，缺失就降级、写进诊断，不崩；
 *   - 所有定时器、子进程、捕获句柄在停用 / 退出时收干净（契约 #10）。
 */
import { createAsr } from './src/audio/asr.js'
import { createAudioHub } from './src/audio/hub.js'
import { createBridge } from './src/bridge.js'
import { createCapture } from './src/capture/index.js'
import { platformStatus, svc, versionStatus, SUPPORTED_TEXT } from './src/compat.js'
import { Config as ConfigSchema, DEFAULTS, readConfig, schemaAvailable, writeFallbackSettings } from './src/config.js'
import { findBinary, killAllChildren, liveChildCount, resetBinaryCache } from './src/media.js'
import { createMemory } from './src/memory.js'
import { createObserver } from './src/observer.js'
import { createOverlay } from './src/overlay.js'
import { ffmpegStatus, installFfmpeg } from './src/ffmpeg-install.js'
import { personaText } from './src/persona.js'
import { createSessions } from './src/session.js'
import { createSpeaker } from './src/speak.js'
import { registerTools, TOOL_NAMES } from './src/tools.js'
import { createVision } from './src/vision.js'
import { ocrStatus } from './src/video/ocr.js'
import { appendLog, errMsg, log } from './src/util.js'

export const name = 'dsh-side-seat'
export const inject = ['tools']
export const Config = ConfigSchema

/** 旁座在新会话里的第一句。短就好，别抢戏。 */
const OPENING_LINE = '你好，我是旁座。'

export async function apply(ctx, config) {
  const version = versionStatus()
  if (version.ok === false) log(version.message)
  const getCfg = () => readConfig(config)

  const memory = await createMemory(ctx)
  const vision = createVision(ctx)
  const capture = createCapture()
  const asr = createAsr(ctx, { getCfg })
  const audio = createAudioHub({ asr, getCfg })

  let observer = null
  // 不给 onOpened 挂问候：宿主没有「助手凭空发起一轮」的接口，
  // 而 append 一条助手消息会写坏会话日志。代发一条 user 消息又会在记录里
  // 留下用户没说过的话。所以开场白由客户端渲染（见 client.js OpeningCard）。
  const sessions = createSessions(ctx, {
    memory,
    personaFor: () => personaText(getCfg(), memory.bond()),
    onUserMessage: (text) => { observer?.onUserMessage(text).catch(() => {}) },
    // 旁座在会话里说的话也镜像到弹窗，否则弹窗里只有主动发言、没有对话回复
    onAssistant: (text) => overlay.push(text, 'assistant'),
  })
  const overlay = createOverlay()
  const speaker = createSpeaker({ sessions, getCfg, onLine: (line) => overlay.push(line) })
  observer = createObserver({ getCfg, capture, vision, memory, speaker, audio })
  sessions.watch()

  /**
   * 开场白。**不能**往会话里 append assistant/message：那会写出一个「没有对应 turn/step」的事件，
   * 当场能显示，但会话日志从此 corrupt（resume 报 SessionFormatError），每次重载都只能新建会话。
   * 所以开场白交给客户端渲染：这里只告诉它「这个会话还是空的吗」。
   */
  const opening = () => {
    try {
      const session = sessions.session
      if (!session) return { sessionId: sessions.sessionId, blank: false, line: OPENING_LINE }
      const msgs = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
      const talked = msgs.some((m) => m && (m.role === 'user' || m.role === 'assistant'))
      return { sessionId: sessions.sessionId, blank: !talked, line: OPENING_LINE }
    } catch {
      return { sessionId: sessions.sessionId, blank: false, line: OPENING_LINE }
    }
  }

  // 不注册自定义 agent preset：真实 PresetDefinition 的 plugins（composition）是必填项，
  // 只给 id/title 会注册出一个「空壳 preset」——用它的会话有壳无模型无工具，界面全是死的。
  // 旁座的人格通过 systemPrompt section 注入（见 src/session.js registerPersona），
  // 会话因此可以走宿主默认 preset，开箱就是正常会话。

  const disposeTools = registerTools(ctx, { getCfg, vision, capture, observer, memory, asr })

  const diag = async () => {
    const cfg = getCfg()
    const model = await vision.checkModel(cfg.visionModel).catch((e) => ({ supported: null, reason: errMsg(e) }))
    const creds = await asr.credentials.describe().catch(() => ({ configured: false, writable: false, source: 'unknown' }))
    return {
      version,
      supported: SUPPORTED_TEXT,
      platform: platformStatus(),
      model,
      visionRoute: typeof vision.lastRoute === 'function' ? vision.lastRoute() : null,
      capture: { backend: capture.backend, label: capture.backendLabel, attempts: capture.attempts, lastError: capture.lastError },
      ffmpeg: Boolean(findBinary('ffmpeg')),
      ffprobe: Boolean(findBinary('ffprobe')),
      bridge,
      memory: memory.backend,
      persona: sessions.personaMode,
      session: { id: sessions.sessionId, lastError: sessions.lastError },
      speakPath: { last: speaker.lastPath, status: speaker.pathStatus, setting: cfg.speakPath },
      asr: { ...asr.status(cfg), credentials: creds },
      audio: audio.status(),
      ocr: ocrStatus(),
      settings: { schemaAvailable, namespace: 'side-seat' },
      tools: TOOL_NAMES,
      children: liveChildCount(),
    }
  }

  const routes = {
    'GET state': async () => ({
      state: observer.snapshot(),
      opening: opening(),
      ffmpeg: { ...ffmpegStatus(), installed: Boolean(findBinary('ffmpeg')) },
    }),
    'GET diag': async () => ({ diag: await diag() }),
    'POST observe': async ({ json }) => {
      const action = json.action
      if (action === 'start') {
        const state = await observer.start()
        // 点「开始看屏幕」就把桌面弹窗一起打开：DSH 最小化时这是唯一能看到它的地方
        if (state && state.status === 'on') overlay.open()
        return { state }
      }
      if (action === 'pause') return { state: observer.pause() }
      if (action === 'resume') return { state: observer.resume() }
      if (action === 'stop') return { state: await observer.stop() }
      throw new Error('action 只能是 start / pause / resume / stop')
    },
    'POST overlay-open': async () => ({ overlay: overlay.open() }),
    'POST overlay-close': async () => ({ overlay: overlay.close() }),
    'GET overlay': async () => ({ running: overlay.running(), dir: overlay.dir }),
    'POST ffmpeg-install': async () => {
      // 不 await：下载要一两分钟，先回状态让界面轮询进度
      installFfmpeg().catch((error) => log(`ffmpeg 安装失败：${errMsg(error)}`))
      return { ffmpeg: { ...ffmpegStatus(), installed: Boolean(findBinary('ffmpeg')) } }
    },
    'GET ffmpeg': async () => ({
      ffmpeg: { ...ffmpegStatus(), installed: Boolean(findBinary('ffmpeg')), path: findBinary('ffmpeg') },
    }),
    'POST session-open': async () => ({ session: await sessions.open() }),
    'POST feedback': async ({ json }) => ({ state: await observer.feedback(json.kind, json.lineId) }),
    'POST quiet': async ({ json }) => ({ state: await observer.setQuiet(json.on) }),
    'POST audio-report': async ({ json }) => { audio.clientReport({ ok: Boolean(json.ok), reason: json.reason }); return { audio: audio.status() } },
    'POST audio-events': async ({ json }) => { audio.clientEvents(Array.isArray(json.events) ? json.events : []); return { received: true } },
    'POST audio-segment': async ({ body, query }) => {
      audio.clientSegment(body, Number(query.t0) || Date.now())
      return { queued: true }
    },
    'POST speaking': async ({ json }) => { audio.echo.setSelfSpeaking(Boolean(json.active)); return { ok: true } },
    'POST pending-clear': async ({ json }) => { speaker.clearPending(json.id); return { ok: true } },
    'POST asr-test': async () => ({ test: await asr.test() }),
    'POST credentials-set': async ({ json }) => {
      await asr.credentials.set(typeof json.value === 'string' ? json.value : '')
      return { credentials: await asr.credentials.describe() }
    },
    'GET settings': async () => ({ settings: getCfg(), defaults: DEFAULTS, schemaAvailable }),
    'POST settings': async ({ json }) => {
      writeFallbackSettings(json.patch || {})
      vision.forgetModelCache()
      return { settings: getCfg() }
    },
    'POST memory-clear': async () => ({ cleared: await memory.clearAll() }),
    'POST capture-probe': async () => {
      resetBinaryCache()
      const res = await capture.probe(true)
      if (observer.status === 'off' || observer.status === 'error') capture.release()
      return { probe: res }
    },
  }
  const bridge = createBridge(ctx, routes)

  // 桌面弹窗里用户回的话：每 800ms 取一次，作为一条真实的用户消息送进旁座会话
  const inboxTimer = setInterval(() => {
    for (const item of overlay.drain()) {
      const said = String(item.text || '').trim()
      if (!said) continue
      // 回显用户自己那句（右侧气泡），否则弹窗里只有旁座的话，看不出"我发过什么"
      overlay.push(said, 'user')
      speaker.sayAsUser(said)
        .then((ok) => appendLog('overlay.log', `inbox ${ok ? 'delivered' : 'FAILED'}: ${said.slice(0, 60)}`))
        .catch((error) => appendLog('overlay.log', `inbox throw: ${errMsg(error)}`))
    }
  }, 800)
  if (typeof inboxTimer.unref === 'function') inboxTimer.unref()

  const onExit = () => { try { overlay.close() } catch { /* ignore */ } killAllChildren() }
  process.once('exit', onExit)

  ctx.effect(() => async () => {
    process.removeListener('exit', onExit)
    try { clearInterval(inboxTimer) } catch { /* ignore */ }
    try { overlay.close() } catch { /* ignore */ }
    try { await observer.stop() } catch { /* ignore */ }
    try { disposeTools() } catch { /* ignore */ }
    capture.release()
    audio.stop()
    killAllChildren()
    await sessions.dispose()
    await memory.close()
    log('已停用：定时器、子进程、捕获句柄均已释放')
  })

  log(`已加载（${version.message}）。工具：${TOOL_NAMES.join(', ')}`)
}
