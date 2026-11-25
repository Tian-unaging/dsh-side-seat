/**
 * 视频索引（B 轴，P1，需 ffmpeg）。
 *
 * 这一层只做解码相关的事：时长、镜头切点、抽帧、抽音轨。理解交给 vision。
 * 陪看屏幕（A 轴）与看当前屏幕不需要 ffmpeg —— 这条分工是「开箱即可用」的关键。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { findBinary, requireFfmpeg, run } from '../media.js'
import { SideSeatError } from '../util.js'

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.m4v', '.ts', '.wmv'])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus'])

/**
 * 按文件头判断类型。DSH 的附件路径默认没有扩展名，
 * 只看后缀会把「用户刚拖进来的截图」判成不认识的文件。
 */
function sniffByMagic(path) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(16)
    readSync(fd, buf, 0, 16, 0)
    closeSync(fd)
    const head4 = buf.subarray(0, 4).toString('latin1')
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image' // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image' // JPEG
    if (head4 === 'GIF8') return 'image'
    if (head4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image'
    if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video' // mp4 / mov
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video' // mkv / webm
    if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio'
  } catch { /* 读不了就按未知处理 */ }
  return 'unknown'
}

export function kindOf(pathOrUrl) {
  const clean = String(pathOrUrl || '').split(/[?#]/)[0]
  const ext = extname(clean).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  // 没有扩展名（DSH 附件就是这种）时读文件头
  if (!ext && clean && !/^https?:/i.test(clean) && existsSync(clean)) return sniffByMagic(clean)
  return 'unknown'
}

export function assertLocalFile(path) {
  if (!path || typeof path !== 'string') throw new SideSeatError('BAD_SOURCE', '需要给出文件的绝对路径（source）')
  if (!existsSync(path)) throw new SideSeatError('NOT_FOUND', `找不到文件：${path}`)
  if (!statSync(path).isFile()) throw new SideSeatError('NOT_FILE', `不是文件：${path}`)
}

/** 时长与是否有视频 / 音频流。优先 ffprobe，没有就从 ffmpeg -i 的输出里解析。 */
export async function probeMedia(input, { signal } = {}) {
  const ffprobe = findBinary('ffprobe')
  if (ffprobe) {
    const res = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input], { signal, timeoutMs: 60000 })
    try {
      const j = JSON.parse(res.stdout.toString('utf8'))
      const streams = j.streams || []
      const video = streams.find((s) => s.codec_type === 'video')
      return {
        duration: Number(j.format?.duration) || 0,
        hasVideo: Boolean(video),
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
        width: video?.width || 0,
        height: video?.height || 0,
      }
    } catch { /* fall through to ffmpeg */ }
  }
  const ffmpeg = requireFfmpeg()
  const res = await run(ffmpeg, ['-hide_banner', '-i', input], { signal, timeoutMs: 60000 })
  const text = res.stderr
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text)
  return {
    duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
    hasVideo: /Stream #.*Video:/.test(text),
    hasAudio: /Stream #.*Audio:/.test(text),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  }
}

/** 在第 t 秒抽一帧，宽 width 的 JPEG（Buffer）。 */
export async function frameAt(input, t, { width = 640, signal } = {}) {
  const ffmpeg = requireFfmpeg()
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', input, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1']
  const res = await run(ffmpeg, args, { signal, timeoutMs: 60000 })
  if (!res.stdout.length) throw new SideSeatError('NO_FRAME', `第 ${t.toFixed(1)} 秒抽不出画面`)
  return res.stdout
}

/** 镜头切点（秒）。threshold 越大切点越少。 */
export async function detectCuts(input, { threshold = 0.3, start = 0, end = 0, signal } = {}) {
  const ffmpeg = requireFfmpeg()
  const args = ['-hide_banner', '-nostats']
  if (start > 0) args.push('-ss', String(start))
  if (end > start) args.push('-t', String(end - start))
  args.push('-i', input, '-an', '-sn', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-')
  const res = await run(ffmpeg, args, { signal, timeoutMs: 15 * 60 * 1000 })
  const cuts = []
  for (const m of res.stderr.matchAll(/pts_time:([\d.]+)/g)) cuts.push(Number(m[1]) + start)
  return cuts.filter((x, i, a) => i === 0 || x - a[i - 1] > 0.15)
}

/** 把切点变成镜头表。 */
export function shotsFrom(cuts, duration, { start = 0, end = 0, minLen = 0.5, maxShots = 200 } = {}) {
  const hi = end > start ? end : duration
  const edges = [start, ...cuts.filter((c) => c > start + minLen && c < hi - minLen), hi]
  let shots = []
  for (let i = 0; i < edges.length - 1; i++) {
    const s = edges[i]
    const e = edges[i + 1]
    if (e - s < minLen && shots.length) { shots[shots.length - 1].end = e; continue }
    shots.push({ start: s, end: e })
  }
  if (shots.length > maxShots) {
    // 合并最短的相邻镜头直到不超上限
    while (shots.length > maxShots) {
      let idx = 0
      let best = Infinity
      for (let i = 0; i < shots.length - 1; i++) {
        const len = shots[i + 1].end - shots[i].start
        if (len < best) { best = len; idx = i }
      }
      shots.splice(idx, 2, { start: shots[idx].start, end: shots[idx + 1].end })
    }
  }
  shots = shots.map((s, i) => ({ id: i + 1, start: s.start, end: s.end, mid: (s.start + s.end) / 2 }))
  return shots
}

/** 等间隔窗口（按秒 / 长视频抽样）。 */
export function windowsOf(duration, step, { start = 0, end = 0 } = {}) {
  const hi = end > start ? end : duration
  const out = []
  for (let s = start, i = 1; s < hi; s += step, i++) out.push({ id: i, start: s, end: Math.min(hi, s + step), mid: Math.min(hi, s + step / 2) })
  return out
}

/** 抽一段 16kHz 单声道 PCM（s16le Buffer）。 */
export async function audioPcm(input, { start = 0, duration = 0, signal } = {}) {
  const ffmpeg = requireFfmpeg()
  const args = ['-hide_banner', '-loglevel', 'error']
  if (start > 0) args.push('-ss', String(start))
  if (duration > 0) args.push('-t', String(duration))
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1')
  const res = await run(ffmpeg, args, { signal, timeoutMs: 15 * 60 * 1000, maxBytes: 512 * 1024 * 1024 })
  return res.stdout
}
