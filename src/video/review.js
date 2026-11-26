/**
 * side_seat_review：带出处的鉴赏 / 观后感。
 *
 * 输出要求：每一条论断后面必须带秒数出处 [mm:ss] 或 [mm:ss–mm:ss]。
 * 没有出处的句子一律删掉（并报告删了几句）——没有出处的观后感是废话。
 * 没有听写引擎时，文章只基于画面，并明确写出「没有台词依据」。
 */
import { SideSeatError, appendLog, errMsg, fmtTime } from '../util.js'
import { pcm16ToWav } from '../audio/asr.js'
import { assertLocalFile, audioPcm, detectCuts, probeMedia, shotsFrom, windowsOf } from './index.js'
import { describeShots, grabShotFrames } from './shots.js'

const MAX_SHOTS = 40
const ASR_CHUNK_SEC = 45
const ASR_MAX_SEC = 30 * 60

const ANGLES = {
  story: '看故事：人物动机、情节结构、转折与伏笔',
  craft: '看技法：镜头语言、剪辑节奏、构图、声音设计',
  theme: '看主题：它想说什么、用什么手段说、说服力如何',
  personal: '写私人感受：哪里打动你、哪里不买账，但仍然要有出处',
}
const LENGTHS = { short: '约 300 字', medium: '约 800 字', long: '约 1500 字' }

const CITE = /[\[【]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[–\-~—]\s*\d{1,2}:\d{2}(?::\d{2})?)?[\]】]/

/** 按句末标点切句；紧跟在句号后面的出处并入前一句（「……。[01:23]」）。 */
export function sentencesOf(line) {
  const out = []
  let start = 0
  let i = 0
  while (i < line.length) {
    if ('。！？!?'.includes(line[i])) {
      let j = i + 1
      const m = /^\s*(\[[^\]\n]*\]\s*)+/.exec(line.slice(j))
      if (m) j += m[0].length
      out.push(line.slice(start, j))
      start = j
      i = j
      continue
    }
    i++
  }
  if (start < line.length) out.push(line.slice(start))
  return out
}

/** 删掉没有出处的句子；标题行与空行保留。 */
export function enforceCitations(text) {
  const out = []
  let dropped = 0
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim() || /^\s*#/.test(line)) { out.push(line); continue }
    const kept = []
    for (const s of sentencesOf(line)) {
      if (!s.trim()) continue
      if (CITE.test(s)) kept.push(s)
      else dropped++
    }
    if (kept.length) out.push(kept.join(''))
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}

/** 只把“片段编号 -> 绝对秒数”这一类偏移平移回文件时间。 */
async function transcribeFile(asr, source, duration, signal) {
  const status = asr.status()
  if (!status.ready) return { cues: [], note: status.reason || '未配置听写引擎', cloud: false }
  const cues = []
  let failed = 0
  const total = Math.min(duration, ASR_MAX_SEC)
  for (let s = 0; s < total; s += ASR_CHUNK_SEC) {
    try {
      const pcm = await audioPcm(source, { start: s, duration: Math.min(ASR_CHUNK_SEC, total - s), signal })
      if (pcm.length < 16000) continue
      const res = await asr.transcribe(pcm16ToWav(pcm, 16000), { signal })
      for (const seg of res.segments) cues.push({ t: s + (seg.start || 0), text: seg.text })
    } catch (error) {
      if (/ABORT|已取消/.test(errMsg(error))) throw error
      failed++
    }
  }
  const notes = []
  if (duration > ASR_MAX_SEC) notes.push(`只转写了前 ${fmtTime(ASR_MAX_SEC)}`)
  if (failed) notes.push(`${failed} 段转写失败`)
  return { cues, note: notes.join('；'), cloud: status.cloud }
}

export async function runReview({ vision, asr, cfg, source, angle = 'story', length = 'medium', signal }) {
  assertLocalFile(source)
  const media = await probeMedia(source, { signal })
  if (!media.hasVideo && !media.hasAudio) throw new SideSeatError('NO_STREAMS', '这个文件既没有画面也没有声音')
  const duration = media.duration
  let rows = []
  if (media.hasVideo) {
    const cuts = await detectCuts(source, { threshold: 0.35, signal })
    let shots = shotsFrom(cuts, duration, { minLen: 1, maxShots: 400 })
    if (shots.length > MAX_SHOTS) {
      const step = shots.length / MAX_SHOTS
      shots = Array.from({ length: MAX_SHOTS }, (_, i) => shots[Math.floor(i * step)])
    }
    if (!shots.length) shots = windowsOf(duration, Math.max(10, duration / 20))
    const framed = await grabShotFrames(source, shots, { width: 512, signal })
    rows = (await describeShots(vision, { model: cfg.visionModel, shots: framed, fields: ['scene', 'people', 'action'], signal })).rows
    // 空索引时靠这行定位：是没抽到帧、还是模型那步没返回可用行
    try {
      appendLog('video.log', `review shots=${shots.length} framed=${framed.filter((f) => f.jpeg).length} rows=${rows.length} missing=${rows.filter((r) => r.missing).length}`)
    } catch { /* ignore */ }
  }
  const transcript = media.hasAudio ? await transcribeFile(asr, source, duration, signal) : { cues: [], note: '文件没有音轨', cloud: false }
  const index = [
    ...rows.filter((r) => !r.missing).map((r) => ({ t: r.start, line: `[${fmtTime(r.start)}–${fmtTime(r.end)}] 画面：${[r.scene, r.people, r.action].filter(Boolean).join('；')}` })),
    ...transcript.cues.map((c) => ({ t: c.t, line: `[${fmtTime(c.t)}] 台词：${c.text}` })),
  ].sort((a, b) => a.t - b.t).map((x) => x.line)
  if (!index.length) throw new SideSeatError('NO_INDEX', '没能从这个文件里得到任何画面描述或台词，写不出有出处的文章')

  const system = [
    '你是一位克制、具体的影评人。你只依据给你的索引写作，不编造索引里没有的画面或台词。',
    '硬性要求：每一个句子都必须以出处结尾，格式 [mm:ss] 或 [mm:ss–mm:ss]，时间必须来自索引。没有出处的句子不要写。',
    '不剧透索引之外的内容；不写空洞的赞美；可以批评，但要有理由。',
    transcript.cues.length ? '' : '注意：没有台词依据，只能谈画面。',
  ].filter(Boolean).join('\n')
  const text = [
    `视频：${source}（时长 ${fmtTime(duration)}）`,
    `角度：${ANGLES[angle] || ANGLES.story}`,
    `篇幅：${LENGTHS[length] || LENGTHS.medium}`,
    '索引：',
    ...index.slice(0, 400),
  ].join('\n')
  const budget = length === 'long' ? 3000 : length === 'short' ? 900 : 1800
  const askOnce = (maxTokens) => vision.ask({ model: cfg.visionModel, system, text, maxTokens, temperature: 0.7, signal, kind: 'review' })
  let res = await askOnce(budget)
  let raw = String(res?.text || '')
  // 空返回重试一次：模型偶发只吐推理、不吐正文（复现：4 秒纯色测试片上 raw len=0）。
  // 不重试就会把「模型没说话」误报成「写出来的句子都没出处」，用户根本不知道发生了什么。
  if (!raw.trim()) {
    res = await askOnce(Math.round(budget * 1.6))
    raw = String(res?.text || '')
  }
  // 全被过滤 / 空返回时，日志里必须能看到模型到底写了什么、烧了多少 token
  try {
    appendLog('video.log', `review raw len=${raw.length} usage=${JSON.stringify(res?.usage || null)} head=${JSON.stringify(raw.slice(0, 200))}`)
  } catch { /* ignore */ }
  const { text: article, dropped } = enforceCitations(raw)
  const notes = []
  if (dropped) notes.push(`已删掉 ${dropped} 句没有出处的话`)
  if (!transcript.cues.length) notes.push(`没有台词依据：${transcript.note || '未配置听写引擎'}，本文只基于画面`)
  else if (transcript.cloud) notes.push('台词来自云端转写')
  if (transcript.note && transcript.cues.length) notes.push(transcript.note)
  const body = article || (raw.trim()
    ? '（模型写出的句子都没有自带出处，已按规则全部删掉）'
    : '模型这次没有返回内容。可以再试一次；若反复出现，换一个视觉模型，或把篇幅调小。')
  return [body, '', notes.length ? `—— ${notes.join('；')}` : ''].join('\n').trim()
}
