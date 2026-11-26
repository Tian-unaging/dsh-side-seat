#!/usr/bin/env node
/**
 * 旁座自检：node test/selfcheck.mjs
 *
 * 不需要 DSH 在跑，不联网，不截屏（强制把截屏后端设成不存在的 none），
 * 数据目录隔离到系统临时目录。覆盖：
 *   - 纯逻辑：dHash / 闸门 / 显著度 / 预算 / 解析 / 措辞约束 / L0 / 回声 / 出处过滤
 *   - 假宿主上的 apply()：四个工具的名字、参数形态、返回值契约（text 必须是字符串，坑 1）
 *   - 路由与信任围栏、诚实降级、会话与人格段作用域、观察循环（假截屏）、卸载
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'side-seat-selfcheck-'))
process.env.DSH_SIDE_SEAT_CAPTURE = 'none'

let PASS = 0
let FAIL = 0
const ok = (cond, msg) => { if (cond) PASS++; else { FAIL++; console.log('FAIL:', msg) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const util = await import('../src/util.js')
const diff = await import('../src/diff.js')
const judge = await import('../src/judge.js')
const persona = await import('../src/persona.js')
const events = await import('../src/audio/events.js')
const echo = await import('../src/audio/echo.js')
const asr = await import('../src/audio/asr.js')
const review = await import('../src/video/review.js')
const compat = await import('../src/compat.js')
const config = await import('../src/config.js')
const media = await import('../src/media.js')
const memoryMod = await import('../src/memory.js')

/* ---------------- 纯逻辑 ---------------- */
ok(util.fmtTime(754) === '12:34', 'fmtTime')
ok(util.similarity('这一手换家换得漂亮', '这一手换家换的漂亮') > echo.ECHO_SIMILARITY, 'echo similarity tolerates one wrong char')
ok(util.extractJson('```json\n{"a":1}\n```')?.a === 1, 'extractJson')
const g1 = new Uint8Array(576).map((_, i) => (i * 7) % 256)
const g2 = new Uint8Array(576).map((_, i) => 255 - ((i * 13) % 256))
ok(diff.hamming(diff.dhash(g1), diff.dhash(g1)) === 0, 'dhash stable')
const tr = new diff.ChangeTracker()
tr.push(g1, 1000); tr.push(g1, 2000)
ok(tr.push(g2, 3000).level === 'dirty', 'big change is dirty')
ok(judge.budgetRemaining({ activeMs: 30 * 60000, perHour: 0.6, spoken: 0 }) === 0, 'budget: 30 min -> 0')
ok(judge.budgetRemaining({ activeMs: 120 * 60000, perHour: 0.6, spoken: 1 }) === 0, 'budget: 2h movie -> about 1 line')
ok(judge.preGate({ bond: { quietMode: true }, now: 0, budget: 1, visionCallsLast10Min: 0 }) === '免打扰', 'quiet gate')
ok(judge.preGate({ bond: {}, now: 0, budget: 1, visionCallsLast10Min: judge.VISION_CAP_PER_10MIN }) !== null, 'vision cap gate')
const L = judge.parseLight('{"noteworthy":true,"content":"game","turningPoint":0.9,"tasteMatch":0.8,"see":"地图界面"}')
ok(judge.hardGate({ light: L, still: false, audio: {}, scrolling: false, scene: { gameSince: 0 }, now: 1 }) !== null, 'game warmup gate')
ok(judge.salience({ turn: 1, taste: 1, ledgerEcho: -1 }) === 0, 'ledger conflict veto')
const H = judge.parseHeavy('{"decision":"SPEAK","line":"这一手换家换得漂亮","reason":"基地已破","confidence":0.8}')
ok(judge.finalVerdict({ heavy: H, preSalience: 0.65, recentLines: [], similarity: util.similarity }).decision === 'SPEAK', 'verdict speak')
ok(judge.finalVerdict({ heavy: { ...H, line: '哈哈哈' }, preSalience: 0.9, recentLines: [], similarity: util.similarity }).decision === 'SILENT', 'banned words silent')
ok(persona.lineViolations('作为一个AI').length > 0, 'ban 作为一个AI')
const rate = 16000
ok(events.analyzePcm(new Float32Array(rate), rate).kind === 'silence', 'L0 silence')
ok(events.analyzePcm(new Float32Array(rate).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / rate)), rate).kind === 'music', 'L0 music')
const ef = new echo.EchoFilter()
ef.markSpoken('这个回头是在等谁')
ok(ef.isEcho('这个回头是在等谁') && !ef.isEcho('今天晚饭吃什么'), 'echo filter')
ok(asr.isWav(asr.pcm16ToWav(new Int16Array(1600))), 'wav')
const rv = review.enforceCitations('开场很稳。[00:12] 这里没有出处。')
ok(rv.dropped === 1 && rv.text.includes('[00:12]'), 'citation filter')
ok(compat.compareVersions('0.2.2-rc.10', '0.2.2-rc.5') > 0, 'version compare')
ok(config.budgetFor('game', 'chatty') === 120, 'budget: game+chatty = 30s/line')
ok(config.budgetFor('movie', 'chatty') === 6, 'budget: movie+chatty = 10min/line')
ok(config.budgetFor('browse', 'normal') === 15, 'budget: browse+normal = 4min/line')
ok(config.readConfig({ mode: { get: () => 'game' }, chattiness: { get: () => 'chatty' } }).budgetPerHour === 120, 'volatile config read: mode+chattiness -> budget')

/* ---------------- ffmpeg 定位 ---------------- */
// 真机教训：ffmpeg 常常既不在 PATH 上、也不在插件自己的 bin 里，
// 而是被别的插件放到 ~/.dsh/tools/ffmpeg/bin，或者作为 @ffmpeg-installer 装在 profile 里。
// 测试期间清空 PATH 与相关环境变量，确保命中的是候选表而不是本机碰巧装了 ffmpeg。
const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const savedPath = process.env.PATH
const savedEnv = ['DSH_SIDE_SEAT_FFMPEG', 'DSH_FFMPEG_PATH', 'DSH_VIDEO_FFMPEG', 'FFMPEG_PATH']
  .map((key) => [key, process.env[key]])
process.env.PATH = ''
process.env.Path = ''
for (const [key] of savedEnv) delete process.env[key]

const toolsBin = join(process.env.DSH_HOME, 'tools', 'ffmpeg', 'bin')
mkdirSync(toolsBin, { recursive: true })
writeFileSync(join(toolsBin, exeName), '')
media.resetBinaryCache()
ok(media.findBinary('ffmpeg') === join(toolsBin, exeName), 'ffmpeg found in $DSH_HOME/tools/ffmpeg/bin')

const fakeProfile = join(process.env.DSH_HOME, 'fake-profile')
const installerPkg = process.platform === 'win32'
  ? `win32-${process.arch}`
  : `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`
const installerBin = join(fakeProfile, 'node_modules', '@ffmpeg-installer', installerPkg)
mkdirSync(installerBin, { recursive: true })
writeFileSync(join(installerBin, exeName), '')
rmSync(toolsBin, { recursive: true, force: true })   // 让上一条候选消失，验证 profile 这条真的生效
process.env.DSH_PROFILE_DIR = fakeProfile
media.resetBinaryCache()
ok(media.findBinary('ffmpeg') === join(installerBin, exeName), 'ffmpeg found in profile @ffmpeg-installer')
delete process.env.DSH_PROFILE_DIR

process.env.PATH = savedPath
if (savedPath !== undefined) process.env.Path = savedPath
for (const [key, value] of savedEnv) if (value !== undefined) process.env[key] = value
media.resetBinaryCache()

/* ---------------- bond 可写字段 ---------------- */
ok(memoryMod.validatePatch('bond', { speakBudgetPerHour: 45 }).clean.speakBudgetPerHour === 45, 'bond.speakBudgetPerHour writable')
ok(memoryMod.validatePatch('bond', { speakBudgetPerHour: '45' }).clean.speakBudgetPerHour === 45, 'bond.speakBudgetPerHour accepts numeric string')
ok(memoryMod.validatePatch('bond', { speakBudgetPerHour: 999 }).clean.speakBudgetPerHour === 240, 'bond.speakBudgetPerHour clamps to 240')
ok(memoryMod.validatePatch('bond', { speakBudgetPerHour: true }).ok === false, 'bond.speakBudgetPerHour rejects boolean')
ok(memoryMod.validatePatch('bond', { nickname: '阿旁' }).clean.nickname === '阿旁', 'bond.nickname still writable')

/* ---------------- 假宿主 ---------------- */
const registered = []
const effects = []
const routes = new Map()
const appended = []
const created = []
const fakeLlm = {
  // 真实宿主有 listProviders / listModels（0.2.2-rc.5 已核对）；
  // 视觉模型留空时旁座靠这两个自动探测能看图的模型。
  listProviders() { return [{ id: 'mock', name: 'Mock Provider' }] },
  async listModels() { return [{ provider: 'mock', id: 'mock-vision', name: 'mock-vision', inputModalities: ['text', 'image'] }] },
  async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
  stream(req) {
    const text = req.system.includes('分诊')
      ? JSON.stringify({ noteworthy: true, kind: '剧情', content: 'long', turningPoint: 1, tasteMatch: 1, see: '雨夜街头' })
      : req.system.includes('要不要对用户说一句话')
        ? JSON.stringify({ decision: 'SPEAK', line: '这个回头是在等谁', reason: '镜头停了三秒', confidence: 0.8 })
        : '中部是一个设置面板。判断：正常。'
    return (async function* () { yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } } })()
  },
}
const services = {
  llm: fakeLlm,
  attachments: { async saveImage({ name }) { return { kind: 'image-ref', name } } },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  agents: {
    async create(opts) {
      created.push(opts)
      // 真实契约：PromptSection = { name, order, text }，text 可以是函数（本机 0.2.2-rc.5 核对）。
      // 早先这里是 def.render?.()，对应的是插件早期猜错的形状。
      const agentCtx = { systemPrompt: { section(def) { agentCtx.persona = typeof def.text === 'function' ? def.text() : def.text; return () => {} } } }
      opts.setup(agentCtx)
      created.agentCtx = agentCtx
      return { agent: { followup() {} }, session: { async append(type, data, o) { appended.push({ type, o }) } }, dispose() {} }
    },
  },
}
const ctx = {
  get: (n) => services[n],
  tools: { register(def) { registered.push(def); return () => {} } },
  effect(fn) { const d = fn(); effects.push(d); return d },
  on() {},
}
const main = await import('../index.js')
await main.apply(ctx, {})
const names = registered.map((d) => d.name)
ok(names.length === 4 && names.every((n) => n.startsWith('side_seat_')), `tools ${names}`)
ok(!names.some((n) => /^(video_|reaction_|office_|session_)/.test(n)), 'no foreign prefixes')
for (const d of registered) {
  const v = await d.execute(d.name === 'side_seat_profile' ? { action: 'read' } : d.name === 'side_seat_look' ? { target: 'window' } : { source: '/nope/x.mp4', out: '/nope/x.csv' }, {})
  const blocks = d.output.render({}, v)
  ok(typeof v.text === 'string' && blocks[0].type === 'text' && typeof blocks[0].text === 'string', `${d.name}: value.text must be a string`)
}

async function call(method, path, json, headers = {}) {
  const handler = routes.get(`/api/side-seat/${path}`)
  const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0)
  const ev = {}
  const req = {
    method,
    url: `/api/side-seat/${path}`,
    headers: { host: '127.0.0.1:3080', 'x-side-seat': '1', 'content-type': 'application/json', ...headers },
    on(e, f) { ev[e] = f; if (e === 'end') setTimeout(() => { if (body.length) ev.data(body); f() }, 0) },
  }
  return new Promise((resolve) => {
    let status = 0
    handler(req, { headersSent: false, setHeader() {}, set statusCode(v) { status = v }, end(b) { resolve({ status, out: JSON.parse(String(b)) }) } })
  })
}
ok((await call('GET', 'state')).out.state.status === 'off', 'observation off by default')
ok((await call('GET', 'state', null, { host: 'evil.example' })).status === 403, 'non-loopback rejected')
const started = (await call('POST', 'observe', { action: 'start' })).out.state
ok(started.status === 'error' && /无法捕获屏幕|只支持 Windows/.test(started.reason), 'capture failure is reported, not faked')
const opened = await call('POST', 'session-open', {})
ok(Boolean(opened.out.session.sessionId), 'own session created')
// 不指定 agentPreset：真实 PresetDefinition 的 plugins 是必填，只给 id 会注册出空壳 preset，
// 用它的会话有壳无模型无工具。所以旁座走宿主默认 composition。
ok(!created[0].meta || created[0].meta.agentPreset === undefined, 'no custom preset (empty composition breaks the session)')
ok(created.agentCtx.persona?.includes('你叫旁座'), 'persona registered in agent scope only')

/* 观察循环（假截屏 + 超大预算） */
const { createObserver } = await import('../src/observer.js')
const { createSpeaker } = await import('../src/speak.js')
const { createAudioHub } = await import('../src/audio/hub.js')
const { createVision } = await import('../src/vision.js')
const { createMemory } = await import('../src/memory.js')
const { createSessions } = await import('../src/session.js')
let n = 0
const fakeCapture = {
  async probe() { return { ok: true, attempts: [] } },
  async grab() { n++; return { full: Buffer.from('x'), thumb: Buffer.from('x'), gray: new Uint8Array(576).map((_, i) => (i * (n % 2 ? 7 : 29) + n * 31) % 256), t: Date.now() } },
  release() {}, backend: 'fake', backendLabel: 'fake', attempts: [], lastError: '',
}
const getCfg = () => ({ ...config.readConfig({}), budgetPerHourOverride: 100000 })
const memory = await createMemory({ get: () => undefined })
const sessions = createSessions(ctx, { memory, personaFor: () => 'p', onUserMessage() {} })
await sessions.open()
const audio = createAudioHub({ asr: asr.createAsr(ctx, { getCfg }), getCfg })
const obs = createObserver({ getCfg, capture: fakeCapture, vision: createVision(ctx), memory, speaker: createSpeaker({ sessions, getCfg }), audio })
await obs.start()
await sleep(6500)
const snap = obs.snapshot()
// append 路径已证实会写出「没有对应 turn/step」的 assistant/message，把会话日志写坏
// （resume 时报 SessionFormatError），所以默认走 overlay，且这里必须断言「没有 append」。
ok(snap.spoken === 1 && snap.lastLine?.path === 'overlay', `observer spoke once via the overlay path (${JSON.stringify(snap.lastLine)})`)
ok(appended.length === 0, 'observer never appends assistant/message (that would corrupt the session log)')
ok(snap.audio.label.includes('听不见台词'), 'status says it cannot hear dialogue')
await obs.feedback('annoying'); await obs.feedback('annoying')
ok(memory.bond().annoyedUntil > Date.now(), 'two "annoying" -> 10 min silence')
await obs.stop()
ok(!obs.snapshot().observing, 'stopped')

/* ---------------- 视觉路由回退（真机教训） ----------------
 * 宿主里 llm-deepseek（deepseek-official）排在 llm-deepseek-account 之前，而前者的
 * DEEPSEEK_API_KEY 可能是失效的。自动探测若「取第一个能看图的模型就锁死」，整块看图
 * 能力会全废（实测：每次 look 都报 Your api key … is invalid）。 */
const routeCalls = []
const manyProviders = {
  listProviders() { return [{ id: 'stale', name: 'Stale' }, { id: 'good', name: 'Good' }] },
  async listModels(provider) { return [{ provider, id: 'vision-x', inputModalities: ['text', 'image'] }] },
  async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
  stream(req) {
    routeCalls.push(req.provider)
    if (req.provider === 'stale') {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Your api key is invalid' } } }
      })()
    }
    return (async function* () {
      yield { type: 'text-delta', text: 'ok-from-good' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const visionCtx = { get: (n) => (n === 'llm' ? manyProviders : n === 'attachments' ? services.attachments : undefined) }
const routed = createVision(visionCtx)
const viaFallback = await routed.ask({ text: '看图', images: [{ bytes: Buffer.from('jpeg'), name: 'a.jpg' }], kind: 'look' })
ok(viaFallback.text === 'ok-from-good', 'auto route falls back after an auth failure')
ok(routeCalls.join(',') === 'stale,good', `fallback order: ${routeCalls.join(',')}`)
routeCalls.length = 0
const second = await routed.ask({ text: '再看', images: [{ bytes: Buffer.from('jpeg'), name: 'b.jpg' }], kind: 'look' })
ok(second.text === 'ok-from-good' && routeCalls.join(',') === 'good', 'working route is pinned, stale one is not retried')
routeCalls.length = 0
let explicitError = null
try { await routed.ask({ model: 'stale:vision-x', text: '看一下', images: [{ bytes: Buffer.from('jpeg'), name: 'c.jpg' }] }) } catch (error) { explicitError = error }
ok(Boolean(explicitError) && routeCalls.join(',') === 'stale', 'explicit model never silently falls back')
ok(Boolean(explicitError) && explicitError.message.includes('stale:vision-x'), 'route id is named in the error message')
ok((await routed.checkModel('')).supported === true, 'checkModel: any usable candidate counts as supported')
ok(routed.lastRoute() === 'good:vision-x', 'diagnostics report the route that works')

/* ---------------- 本地文件/记忆路径的其余回归 ----------------
 * 只断言「不抛、返回字符串、不误报成功」，避免把宿主行为写成测试依赖。 */
ok(typeof memoryMod.PATCH_SCHEMA.bond.speakBudgetPerHour === 'function', 'bond patch schema exposes speakBudgetPerHour')

for (const d of effects.reverse()) if (typeof d === 'function') await d()
ok(true, 'dispose')

console.log(`\nselfcheck: ${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
