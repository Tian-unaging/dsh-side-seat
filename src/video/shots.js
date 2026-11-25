/**
 * 镜头 -> 代表帧 -> 视觉描述（每批 <= 6 张，每帧严格一行）。
 * 输出格式是硬约定：镜头<id>|场景|人物|动作|道具|画面文字。解析不了的行原样保留、标出，不猜。
 */
import { fmtTime } from '../util.js'
import { frameAt } from './index.js'
import { ocrImage } from './ocr.js'

export const ALL_FIELDS = ['scene', 'people', 'action', 'props', 'text']
const FIELD_NAMES = { scene: '场景', people: '人物', action: '动作表情', props: '道具与细节', text: '画面文字' }
const BATCH = 6
const LINE = /^\s*镜头\s*(\d+)\s*[|｜]\s*(.*)$/

const SYSTEM = '你是视频分镜标注员。只描述画面中确实可见的内容，不推测剧情、不写影评。看不清就写「看不清」。严格按要求的格式逐行输出，不要输出别的。'

export function normalizeFields(fields) {
  const list = Array.isArray(fields) ? fields.filter((f) => ALL_FIELDS.includes(f)) : []
  return list.length ? list : ALL_FIELDS
}

/** 给每个镜头抽中点帧；返回 [{ ...shot, jpeg }]，抽不出的镜头标 missing。 */
export async function grabShotFrames(input, shots, { width = 640, signal } = {}) {
  const out = []
  for (const shot of shots) {
    try {
      out.push({ ...shot, jpeg: await frameAt(input, shot.mid, { width, signal }) })
    } catch {
      out.push({ ...shot, jpeg: null })
    }
  }
  return out
}

export async function describeShots(vision, { model, shots, fields, signal, useOcr = false }) {
  const wanted = normalizeFields(fields)
  const visual = wanted.filter((f) => f !== 'text' || !useOcr)
  const header = `镜头<id>|${visual.map((f) => FIELD_NAMES[f]).join('|')}`
  const results = new Map()
  const unparsed = []
  const withFrames = shots.filter((s) => s.jpeg)
  for (let i = 0; i < withFrames.length; i += BATCH) {
    const batch = withFrames.slice(i, i + BATCH)
    const ids = batch.map((s) => s.id)
    const text = [
      `以下是同一视频按时间顺序抽取的镜头代表帧，共 ${batch.length} 张，编号依次为 ${ids.join('、')}（对应时间 ${batch.map((s) => fmtTime(s.mid)).join('、')}）。`,
      `请为每一张严格输出一行，格式：${header}`,
      '每段不超过 20 个字。不要输出其他内容。',
    ].join('\n')
    const res = await vision.ask({
      model,
      system: SYSTEM,
      text,
      images: batch.map((s) => ({ bytes: s.jpeg, name: `shot-${s.id}.jpg` })),
      maxTokens: 120 * batch.length + 100,
      temperature: 0.2,
      signal,
      kind: 'caption',
    })
    const absorb = (raw) => {
      let gained = 0
      for (const src of String(raw).split(/\r?\n/)) {
        let line = src.trim()
        if (!line || /^```/.test(line)) continue
        // 去掉项目符号、行内代码、表格竖线，模型常常不严格照格式写
        line = line
          .replace(/^[-*•]\s*/, '')
          .replace(/^`+|`+$/g, '')
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .trim()
        const m = LINE.exec(line)
        if (!m) { unparsed.push(line); continue }
        const parts = m[2].split(/[|｜]/).map((p) => p.replace(/^`+|`+$/g, '').trim())
        const row = {}
        visual.forEach((f, idx) => { row[f] = parts[idx] || '' })
        if (!results.has(Number(m[1]))) { results.set(Number(m[1]), row); gained++ }
      }
      return gained
    }

    if (!absorb(res.text)) {
      // 一行都没解析出来时重试一次，把格式要求钉死
      try {
        const again = await vision.ask({
          model,
          system: SYSTEM,
          text: `${text}\n\n只输出 ${batch.length} 行，每行严格为：${header}\n除了这些行，不要输出任何字符。`,
          images: batch.map((s) => ({ bytes: s.jpeg, name: `shot-${s.id}.jpg` })),
          maxTokens: 120 * batch.length + 100,
          temperature: 0,
          signal,
          kind: 'caption',
        })
        absorb(again.text)
      } catch { /* 保留 missing，不编造 */ }
    }
  }
  if (useOcr && wanted.includes('text')) {
    for (const s of withFrames) {
      const lines = await ocrImage(s.jpeg, { signal })
      const row = results.get(s.id) || {}
      row.text = lines === null ? '（OCR 不可用）' : lines.join(' / ').slice(0, 200)
      results.set(s.id, row)
    }
  }
  const rows = shots.map((s) => ({ id: s.id, start: s.start, end: s.end, mid: s.mid, ...(results.get(s.id) || {}), missing: !results.has(s.id) }))
  return { rows, fields: wanted, unparsed: unparsed.slice(0, 20) }
}
