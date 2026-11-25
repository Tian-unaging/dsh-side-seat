/**
 * 配置：设置页五个控件 + 听写引擎（高级）。
 *
 * 契约（与 dsh-plugin-template 一致）：Config 里带 `.volatile()` 的字段会让
 * Loader 自动派生 settings 命名空间，命名空间 id = cordis.patch.yml 里那一行
 * 的 `id`（本插件为 `side-seat`）。宿主在每次使用处调用 `.get()` 读当前值，
 * 改设置不用重启。
 *
 * 密钥绝不进这里：apiKey 走 DSH 凭据服务（见 src/audio/asr.js），
 * 设置里只存「已配置 / 未配置」由凭据服务现查。
 *
 * schemastery 由宿主提供；万一拿不到（非标准组合），插件仍可加载，
 * 设置改由 $DSH_HOME/plugins-data/side-seat/settings.json 兜底，并在设置页说明。
 */
import { join } from 'node:path'
import { dataDir, readJsonFile, writeJsonAtomic } from './util.js'

let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

export const DEFAULTS = Object.freeze({
  persona: '温和、话少、有点毒舌的朋友',
  personaGender: 'none',    // male | female | none —— 性格性别，只管说话方式，不管朗读音色
  voice: 'female',          // female | male | off —— 朗读音色，和上面的性格性别互相独立
  listen: true,
  mode: 'auto',             // auto | game | movie | browse | daily
  chattiness: 'normal',     // quiet | normal | chatty
  scope: 'screen',          // screen | window（P1）
  asrEngine: 'none',        // none | builtin | openai | command —— 默认「无」，音频默认不出本机
  asrBaseUrl: '',
  asrModel: '',
  asrLanguage: 'auto',      // auto | zh | en
  asrCommand: '',
  asrCloudConsent: false,   // 首次切到云端引擎时的确认结果
  visionModel: '', // 留空 = 自动探测一个声明了 image 输入的模型；也可写 providerId:modelId
  speakPath: 'overlay',     // 默认只走客户端浮层。'append' 已证实会写坏会话日志（见 FIXES），仅作排障用
})

export const ENUMS = Object.freeze({
  voice: ['female', 'male', 'off'],
  personaGender: ['male', 'female', 'none'],
  chattiness: ['quiet', 'normal', 'chatty'],
  mode: ['auto', 'game', 'movie', 'browse', 'daily'],
  scope: ['screen', 'window'],
  asrEngine: ['none', 'builtin', 'openai', 'command'],
  asrLanguage: ['auto', 'zh', 'en'],
  speakPath: ['auto', 'append', 'followup', 'overlay'],
})

/**
 * 说话模式 × 频率 → 每小时说话预算。
 *
 * 模式先决定"这场合多吵才自然"，频率再在同一模式内微调：
 *   游戏   话多 ≈ 每 30 秒一句
 *   刷视频 话多 ≈ 每 2 分钟一句
 *   观影   话多 ≈ 每 10 分钟一句
 *   日常   话多 ≈ 每 5 分钟一句
 *
 * mode='auto' 时，观察循环按轻判断的 content 自动切到对应模式。
 */
export const MODES = Object.freeze(['auto', 'game', 'movie', 'browse', 'daily'])

export const BUDGET_MATRIX = Object.freeze({
  //            安静      正常      话多
  game: Object.freeze({ quiet: 30, normal: 60, chatty: 120 }), // 2分 / 1分 / 30秒
  movie: Object.freeze({ quiet: 2, normal: 4, chatty: 6 }),    // 30分 / 15分 / 10分
  browse: Object.freeze({ quiet: 6, normal: 15, chatty: 30 }),  // 10分 / 4分 / 2分
  daily: Object.freeze({ quiet: 2, normal: 6, chatty: 12 }),    // 30分 / 10分 / 5分
})

/** 内容类型 → 模式（auto 模式下用） */
export const MODE_OF_CONTENT = Object.freeze({ short: 'browse', long: 'movie', game: 'game', other: 'daily' })

export function budgetFor(mode, chattiness) {
  const table = BUDGET_MATRIX[mode] || BUDGET_MATRIX.daily
  return table[chattiness] ?? table.normal
}

/** 兼容旧引用：不带模式时的默认（日常/正常）。 */
export const BUDGET_PER_HOUR = Object.freeze({ quiet: 2, normal: 6, chatty: 12 })

function union(values) {
  return Schema.union(values.map((v) => Schema.const(v)))
}

export const Config = Schema
  ? Schema.object({
    persona: Schema.string().role('textarea').default(DEFAULTS.persona).description('它是谁：用一句话描述性格').volatile(),
    voice: union(ENUMS.voice).default(DEFAULTS.voice).description('朗读：female / male / off（只影响它念出来的音色）').volatile(),
    personaGender: union(ENUMS.personaGender).default(DEFAULTS.personaGender).description('性格性别：male / female / none（只影响它怎么说话，不影响音色）').volatile(),
    listen: Schema.boolean().default(DEFAULTS.listen).description('听声音：能不能听见你播放的声音').volatile(),
    chattiness: union(ENUMS.chattiness).default(DEFAULTS.chattiness).description('说话频率：安静 / 正常 / 话多').volatile(),
    mode: union(ENUMS.mode).default(DEFAULTS.mode).description('说话模式：auto 自动判断 / game 游戏 / movie 观影 / browse 刷视频 / daily 日常。每种模式下三档频率的说话区间不同').volatile(),
    scope: union(ENUMS.scope).default(DEFAULTS.scope).description('观察范围：screen 整个主屏 / window 当前窗口（P1）').volatile(),
    asrEngine: union(ENUMS.asrEngine).default(DEFAULTS.asrEngine).description('听写引擎：none / builtin / openai / command').volatile(),
    asrBaseUrl: Schema.string().default('').description('OpenAI 兼容接口地址，如 https://api.example.com/v1').volatile(),
    asrModel: Schema.string().default('').description('听写模型名，如 whisper-1').volatile(),
    asrLanguage: union(ENUMS.asrLanguage).default(DEFAULTS.asrLanguage).volatile(),
    asrCommand: Schema.string().default('').description('自定义命令模板，含 {wav} 与 {out}').volatile(),
    asrCloudConsent: Schema.boolean().default(false).hidden().volatile(),
    visionModel: Schema.string().default(DEFAULTS.visionModel).description('视觉模型：留空 = 自动选一个能看图的；也可写 providerId:modelId').volatile(),
    speakPath: union(ENUMS.speakPath).default(DEFAULTS.speakPath).description('主动发言路径（现场核实后锁定）').volatile(),
  })
  : undefined

export const schemaAvailable = Boolean(Schema)

function settingsFile() {
  return join(dataDir(), 'settings.json')
}

/** 兜底设置（只在宿主没把命名空间暴露给浏览器时由设置页写入）。 */
export function readFallbackSettings() {
  const raw = readJsonFile(settingsFile(), {})
  return raw && typeof raw === 'object' ? raw : {}
}

export function writeFallbackSettings(patch) {
  const next = { ...readFallbackSettings() }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }
  writeJsonAtomic(settingsFile(), sanitize(next, true))
  return next
}

function sanitize(raw, partial = false) {
  const out = partial ? {} : { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw)) continue
    const value = raw[key]
    const def = DEFAULTS[key]
    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value
    } else if (typeof def === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof value === 'string') {
      out[key] = key === 'persona' ? value.slice(0, 200) : value.slice(0, 2000)
    }
  }
  return out
}

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get() } catch { return undefined }
  }
  return value
}

/**
 * 读取当前生效配置的一份快照。每次操作开始时调用一次，把快照传下去，
 * 不要缓存。优先级：默认值 < cordis 配置（含设置页写入）< 兜底文件 < 环境变量。
 */
export function readConfig(config) {
  const fromCordis = {}
  for (const key of Object.keys(DEFAULTS)) {
    const v = unwrap(config ? config[key] : undefined)
    if (v !== undefined) fromCordis[key] = v
  }
  const merged = sanitize({ ...fromCordis, ...readFallbackSettings() })
  if (!merged.persona.trim()) merged.persona = DEFAULTS.persona
  if (process.env.DSH_SIDE_SEAT_MODEL) merged.visionModel = process.env.DSH_SIDE_SEAT_MODEL
  if (process.env.DSH_SIDE_SEAT_SPEAK_PATH && ENUMS.speakPath.includes(process.env.DSH_SIDE_SEAT_SPEAK_PATH)) {
    merged.speakPath = process.env.DSH_SIDE_SEAT_SPEAK_PATH
  }
  merged.budgetPerHour = budgetFor(merged.mode === 'auto' ? 'daily' : merged.mode, merged.chattiness)
  return merged
}
