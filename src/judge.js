/**
 * 轻判断 / 重判断 / 闸门（4.1.1 + 第 6 章 + 7.2 / 7.3）。
 *
 * 本文件除 runLight / runHeavy 外都是纯函数，便于单测（test/selfcheck.mjs）。
 *
 * 决策顺序：
 *   1. 硬闸门（任一成立 -> SILENT，不可被显著度推翻）
 *   2. 显著度 = 0.28 转折 + 0.22 口味 + 0.20 观点呼应 + 0.15 新鲜 + 0.10 声音 + 0.05 久未开口
 *      >= 0.50 SPEAK；>= 0.34 WAIT（60 秒后再看）；否则 SILENT
 *   3. 重判断只在「轻判断 noteworthy 且通过闸门且预估显著度 >= 0.50」时才发生；
 *      重判断给出观点呼应（冲突一票否决），最终显著度仍须 >= 0.50 才开口。
 * 每一次 SILENT 都写 { t, reason } 到 moments。
 *
 * 阈值从 0.62/0.45 下调到 0.50/0.34：陪看的门槛不该按「值得开口的场合」定，
 * 而该按「朋友会顺口接一句」定。真正的节制交给每小时预算。
 */
import { VISION_DISCIPLINE, lineViolations } from './persona.js'
import { extractJson, num01 } from './util.js'

export const SPEAK_THRESHOLD = 0.38
export const WAIT_THRESHOLD = 0.26
export const WEIGHTS = Object.freeze({ turn: 0.28, taste: 0.22, ledger: 0.20, novelty: 0.15, audio: 0.10, silence: 0.05 })
export const VISION_CAP_PER_10MIN = 30 // 轻判断每 20 秒一次 ≈ 30 次/10 分钟，原上限 20 会把后 3 分钟直接锁死
export const GAME_WARMUP_MS = 30000     // 4.1.3：连续观察 30 秒以上才判断「他在干什么」
export const ANNOYED_SILENCE_MS = 10 * 60 * 1000

/** 每小时说话预算（第 6 章）。activeMs 只算真正在看的时间（暂停不计）。 */
export function budgetRemaining({ activeMs, perHour, spoken }) {
  return Math.floor((activeMs / 3600000) * perHour) - spoken
}

/** 距离下一句「预算额度」还要多久（毫秒）；给状态条用。 */
export function msUntilNextCredit({ activeMs, perHour, spoken }) {
  if (perHour <= 0) return Infinity
  const needHours = (spoken + 1) / perHour
  return Math.max(0, needHours * 3600000 - activeMs)
}

/** 在调用任何模型之前就能判的闸门（省钱）。返回原因字符串或 null。 */
export function preGate({ bond, now, budget, visionCallsLast10Min }) {
  if (bond?.quietMode) return '免打扰'
  if ((bond?.annoyedUntil || 0) > now) return '连续两次被嫌烦，静默 10 分钟'
  if (budget <= 0) return '本小时预算用完'
  if (visionCallsLast10Min >= VISION_CAP_PER_10MIN) return '10 分钟内视觉调用已达上限'
  return null
}

/** 轻判断之后的硬闸门。 */
export function hardGate({ light, still, audio, scrolling, scene, now }) {
  if (light.lowpoint) return '低谷（广告 / 片头 / 加载 / 菜单）'
  if (still && audio?.musicOnly) return '背景音（画面基本静止且只有音乐）'
  if (light.userBusy || scrolling) return '别抢话（用户正在输入或密集滚动）'
  if (light.content === 'other') return '网页 / 文档默认不说'
  if (light.content === 'game' && (!scene?.gameSince || now - scene.gameSince < GAME_WARMUP_MS)) {
    return '游戏场景尚未建立（需连续观察 30 秒）'
  }
  if (light.unsure) return '看不清'
  return null
}

/** 显著度（画面 + 声音一起算）。ledgerEcho ∈ [-1, 1]，负值视为冲突。 */
export function salience({ turn = 0, taste = 0, ledgerEcho = 0, novelty = 0, audio = 0, silenceGain = 0 }) {
  if (ledgerEcho < -0.3) return 0 // 与观点账本冲突：一票否决
  return WEIGHTS.turn * num01(turn)
    + WEIGHTS.taste * num01(taste)
    + WEIGHTS.ledger * num01(ledgerEcho)
    + WEIGHTS.novelty * num01(novelty)
    + WEIGHTS.audio * num01(audio)
    + WEIGHTS.silence * num01(silenceGain)
}

export function decideBySalience(s) {
  if (s >= SPEAK_THRESHOLD) return 'SPEAK'
  if (s >= WAIT_THRESHOLD) return 'WAIT'
  return 'SILENT'
}

/** 距上次开口越久越愿意说一句：4 分钟封顶（原来是 45 分钟，等于几乎不给分）。 */
export function silenceGain(msSinceLastSpeak) {
  if (!Number.isFinite(msSinceLastSpeak)) return 1
  return Math.max(0, Math.min(1, msSinceLastSpeak / (4 * 60 * 1000)))
}

/* ---------------- 轻判断 ---------------- */

const LIGHT_SYSTEM = [
  '你在帮一个「陪看」程序做低成本的画面分诊。你只输出一个 JSON 对象，不输出其它任何文字。',
  VISION_DISCIPLINE,
].join('\n')

export function lightPrompt({ previous, audioText, tasteText, sceneText }) {
  return [
    '这是用户主屏的一张缩略图。你的任务只是**描述这一帧是什么内容**，不要判断「该不该开口」——那不是你这一层的事。',
    `上一次你的结论：${previous || '（无，这是第一次）'}`,
    `声音：${audioText}`,
    `用户口味：${tasteText || '（还不了解）'}`,
    `场景状态：${sceneText || '（刚开始看）'}`,
    '只输出一个 JSON 对象，不要代码围栏、不要注释、不要任何解释。字段：',
    'noteworthy：布尔。只要画面在播放视频或游戏内容就给 true；只有广告、片头、加载条、菜单、静止空白才给 false',
    'kind：剧情 / 操作 / 疑问 / 闲聊',
    'hot：0 到 1 的数',
    'content：short / long / game / other',
    '  short = 竖屏短视频流（包括在浏览器里刷抖音这类）',
    '  long = 横屏长视频或影视（包括网页里正在播放的视频）',
    '  game = 全屏游戏（有 HUD / 操作反馈）',
    '  other = 真正的网页、文档、聊天、文件管理器',
    'lowpoint：布尔，广告 / 片头 / 加载条 / 菜单',
    'userBusy：布尔，用户正在打字或密集操作',
    'turningPoint：0 到 1，剧情或操作的关键程度',
    'tasteMatch：0 到 1，与用户口味的契合',
    'see：一句话写你确实看到的；看不清就写看不清',
    'unsure：布尔',
    '示例：{"noteworthy":true,"kind":"剧情","hot":0.6,"content":"short","lowpoint":false,"userBusy":false,"turningPoint":0.5,"tasteMatch":0.4,"see":"竖屏短视频，一个人在说话","unsure":false}',
  ].join('\n')
}

export function parseLight(text) {
  const j = extractJson(text)
  if (!j || typeof j !== 'object') return null
  const content = ['short', 'long', 'game', 'other'].includes(j.content) ? j.content : 'other'
  const lowpoint = j.lowpoint === true
  const userBusy = j.userBusy === true
  const unsure = j.unsure === true || /看不清/.test(String(j.see || ''))
  // 轻判断只负责「这是什么」，不负责「该不该说」。
  // 早先直接用模型给的 noteworthy，结果它对抖音/影视几乎一律判 false，
  // 于是永远走不到决策层——这不是模型错，是分工错。
  const video = content !== 'other'
  const noteworthy = j.noteworthy === true || (video && !lowpoint && !userBusy && !unsure)
  return {
    noteworthy,
    kind: ['剧情', '操作', '疑问', '闲聊'].includes(j.kind) ? j.kind : '闲聊',
    hot: num01(j.hot),
    content,
    lowpoint,
    userBusy,
    // 视频内容给一个保守的下限：模型给 0.05 这种值时，显著度永远压不过阈值。
    // 真实输入里 ledgerEcho 恒为 0、audio 无设备时为 0，能动的只有 turn / taste / novelty / silence。
    turningPoint: video ? Math.max(0.55, num01(j.turningPoint)) : num01(j.turningPoint),
    tasteMatch: video ? Math.max(0.50, num01(j.tasteMatch)) : num01(j.tasteMatch),
    see: String(j.see || '').slice(0, 120),
    unsure,
  }
}

export async function runLight(vision, { model, thumb, context, signal }) {
  const res = await vision.ask({
    model,
    system: LIGHT_SYSTEM,
    text: lightPrompt(context),
    images: [{ bytes: thumb, name: `side-seat-light-${Date.now()}.jpg` }],
    maxTokens: 900,
    temperature: 0.2,
    signal,
    kind: 'light',
  })
  return { parsed: parseLight(res.text), raw: res.text }
}

/* ---------------- 重判断 ---------------- */

export function heavySystem(persona) {
  return [
    persona,
    '',
    VISION_DISCIPLINE,
    '',
    '现在你要决定：此刻要不要对用户说一句话。默认少说，宁可漏说。',
    '只输出一个 JSON 对象：',
    '{"decision":"SPEAK | WAIT | SILENT",',
    ' "line":"这句要说的话；SILENT 时必须为 null",',
    ' "reason":"为什么现在说 / 为什么不说（必须能被用户复核：说出你看到的依据）",',
    ' "confidence":0.0,',
    ' "kind":"story | play | question | banter",',
    ' "nextCheckSeconds":60,',
    ' "ledgerEcho":-1..1,  // 与你的观点账本呼应为正，冲突为负，无关为 0',
    ' "stance":{"topic":"…","stance":"…"} 或 null  // 只有你真的表达了一个立场时才写',
    '}',
  ].join('\n')
}

export function heavyPrompt({ light, audioText, cues, recent, tasteText, ledgerText, sharedText, contentHint }) {
  return [
    '这是用户主屏此刻接近原尺寸的一帧。',
    `轻判断的结论：${light.see}（类型 ${light.content}，${light.kind}）`,
    `内容形态的说话风格：${contentHint}`,
    `声音：${audioText}`,
    cues.length ? `最近的台词（来自听写引擎，带相对时间）：\n${cues.join('\n')}` : '台词：你听不见台词。不许引用、复述或编造任何台词。',
    `最近 5 句对话：\n${recent.length ? recent.join('\n') : '（还没有）'}`,
    `用户口味：${tasteText || '（还不了解）'}`,
    `你的观点账本：${ledgerText || '（空）'}`,
    `你们一起看过的：${sharedText || '（还没有）'}`,
    '不要重复你最近说过的意思；同一个博主连刷不要重复评价。',
  ].join('\n')
}

export const CONTENT_HINTS = {
  short: '短、快、一句话点到；允许 3-5 字反应；不要每条都评。',
  long: '可以在关键点说；有耐心等；绝不剧透，只评已经看到的位置。',
  game: '先夸再教；只在高置信的、可验证的错误时提醒；不确定目标时只描述界面。',
  other: '默认不说。',
}

export function parseHeavy(text) {
  const j = extractJson(text)
  if (!j || typeof j !== 'object') return null
  const decision = ['SPEAK', 'WAIT', 'SILENT'].includes(String(j.decision).trim()) ? String(j.decision).trim() : 'SILENT'
  let line = typeof j.line === 'string' ? j.line.trim() : null
  if (decision !== 'SPEAK') line = null
  const echo = Number(j.ledgerEcho)
  const stance = j.stance && typeof j.stance === 'object' && j.stance.topic && j.stance.stance
    ? { topic: String(j.stance.topic).slice(0, 60), stance: String(j.stance.stance).slice(0, 200) }
    : null
  return {
    decision,
    line,
    reason: String(j.reason || '').slice(0, 200),
    confidence: num01(j.confidence),
    kind: ['story', 'play', 'question', 'banter'].includes(j.kind) ? j.kind : 'banter',
    nextCheckSeconds: Math.max(20, Math.min(600, Number(j.nextCheckSeconds) || 60)),
    ledgerEcho: Number.isFinite(echo) ? Math.max(-1, Math.min(1, echo)) : 0,
    stance,
  }
}

export async function runHeavy(vision, { model, full, persona, context, signal }) {
  const res = await vision.ask({
    model,
    system: heavySystem(persona),
    text: heavyPrompt(context),
    images: [{ bytes: full, name: `side-seat-heavy-${Date.now()}.jpg` }],
    maxTokens: 400,
    temperature: 0.6,
    signal,
    kind: 'heavy',
  })
  return { parsed: parseHeavy(res.text), raw: res.text }
}

/**
 * 重判断之后的最终裁决：模型说 SPEAK 还不够，显著度与措辞也要过。
 * 返回 { decision, line, reason }。
 */
export function finalVerdict({ heavy, preSalience, recentLines, similarity }) {
  if (!heavy) return { decision: 'SILENT', line: null, reason: '重判断输出无法解析' }
  if (heavy.decision !== 'SPEAK') return { decision: heavy.decision, line: null, reason: heavy.reason || '模型决定不说' }
  if (!heavy.line) return { decision: 'SILENT', line: null, reason: 'SPEAK 却没有给出台词' }
  if (heavy.ledgerEcho < -0.3) return { decision: 'SILENT', line: null, reason: '与观点账本冲突' }
  const final = preSalience + WEIGHTS.ledger * Math.max(0, heavy.ledgerEcho)
  if (final < SPEAK_THRESHOLD) return { decision: 'WAIT', line: null, reason: `显著度 ${final.toFixed(2)} 未到 ${SPEAK_THRESHOLD}` }
  if (heavy.confidence < 0.5) return { decision: 'SILENT', line: null, reason: `置信度 ${heavy.confidence.toFixed(2)} 太低` }
  const bad = lineViolations(heavy.line)
  if (bad.length) return { decision: 'SILENT', line: null, reason: `措辞违反约束：${bad.join('、')}` }
  if (recentLines.some((l) => similarity(l, heavy.line) > 0.6)) return { decision: 'SILENT', line: null, reason: '和最近说过的话重复' }
  return { decision: 'SPEAK', line: heavy.line, reason: heavy.reason, salience: final }
}
