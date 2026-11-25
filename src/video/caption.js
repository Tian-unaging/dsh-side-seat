/**
 * side_seat_caption：按镜头 / 按秒 / 按场景出标注，导出 .srt 或 .csv。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { SideSeatError, fmtTime } from '../util.js'
import { assertLocalFile, detectCuts, probeMedia, shotsFrom, windowsOf } from './index.js'
import { describeShots, grabShotFrames, normalizeFields } from './shots.js'

const FIELD_HEAD = { scene: 'scene', people: 'people', action: 'action', props: 'props', text: 'text' }

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const x = ms % 1000
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(x, 3)}`
}

const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function runCaption({ vision, cfg, source, mode = 'shot', fields, out, signal }) {
  assertLocalFile(source)
  if (!out || typeof out !== 'string') throw new SideSeatError('BAD_OUT', 'out 必填：输出 .srt 或 .csv 的路径')
  const ext = extname(out).toLowerCase()
  if (ext !== '.srt' && ext !== '.csv') throw new SideSeatError('BAD_OUT', 'out 只能是 .srt 或 .csv')
  const media = await probeMedia(source, { signal })
  if (!media.hasVideo) throw new SideSeatError('NO_VIDEO', '这个文件没有画面，做不了按镜头的标注')
  const duration = media.duration
  let shots
  if (mode === 'second') {
    const step = Math.max(1, Math.ceil(duration / 200))
    shots = windowsOf(duration, step)
  } else {
    const threshold = mode === 'scene' ? 0.45 : 0.3
    const cuts = await detectCuts(source, { threshold, signal })
    shots = shotsFrom(cuts, duration, { minLen: mode === 'scene' ? 4 : 0.5, maxShots: 200 })
  }
  const wanted = normalizeFields(fields)
  const framed = await grabShotFrames(source, shots, { width: 640, signal })
  const described = await describeShots(vision, { model: cfg.visionModel, shots: framed, fields: wanted, signal, useOcr: wanted.includes('text') })
  mkdirSync(dirname(out), { recursive: true })
  if (ext === '.srt') {
    const body = described.rows.map((r, i) => {
      const text = wanted.map((f) => r[f]).filter(Boolean).join(' · ') || '（未描述）'
      return `${i + 1}\n${srtTime(r.start)} --> ${srtTime(r.end)}\n${text}\n`
    }).join('\n')
    writeFileSync(out, body, 'utf8')
  } else {
    const head = ['id', 'start', 'end', 'start_tc', ...wanted.map((f) => FIELD_HEAD[f])]
    const rows = described.rows.map((r) => [r.id, r.start.toFixed(2), r.end.toFixed(2), fmtTime(r.start), ...wanted.map((f) => r[f] || '')])
    writeFileSync(out, '\uFEFF' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8')
  }
  const missing = described.rows.filter((r) => r.missing).length
  const preview = described.rows.slice(0, 8).map((r) => `[${fmtTime(r.start)}–${fmtTime(r.end)}] ${wanted.map((f) => r[f]).filter(Boolean).join(' · ')}`)
  return [
    `已写出 ${described.rows.length} 条标注 -> ${out}`,
    `模式 ${mode} · 字段 ${wanted.join('/')} · 时长 ${fmtTime(duration)}${missing ? ` · ${missing} 条没有拿到描述（留空，未猜测）` : ''}`,
    '',
    ...preview,
    described.rows.length > 8 ? `…（其余 ${described.rows.length - 8} 条见文件）` : '',
  ].filter((l) => l !== undefined).join('\n')
}
