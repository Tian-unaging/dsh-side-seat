/**
 * 截屏后端 B · ffmpeg gdigrab。
 *
 * 一次进程同时产出三样：近原尺寸 JPEG（重判断）、缩略 JPEG（轻判断）、
 * 32x18 灰度栅格（本地变化检测）——走 pipe:1 / pipe:3 / pipe:4，不落盘。
 * 如果某个 ffmpeg 构建在 Windows 上不认额外管道，退回三次独立调用。
 */
import { GRID_H, GRID_W } from '../diff.js'
import { findBinary, run } from '../media.js'

export function createFfmpegBackend() {
  let ffmpeg = null
  let mode = 'pipes' // pipes | separate

  const base = () => ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '1', '-draw_mouse', '0', '-i', 'desktop']

  async function grabPipes(fullWidth, thumbWidth) {
    const filter = `[0:v]split=3[a][b][c];[a]scale='min(${fullWidth},iw)':-2[o1];[b]scale='min(${thumbWidth},iw)':-2[o2];[c]scale=${GRID_W}:${GRID_H},format=gray[o3]`
    const args = [
      ...base(), '-filter_complex', filter,
      '-map', '[o1]', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1',
      '-map', '[o2]', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:3',
      '-map', '[o3]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:4',
    ]
    const res = await run(ffmpeg, args, { timeoutMs: 8000, extraPipes: 2 })
    if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${res.code}`)
    return { full: res.stdout, thumb: res.extra[0], gray: new Uint8Array(res.extra[1]) }
  }

  async function grabSeparate(fullWidth, thumbWidth) {
    const one = async (vf, fmt) => {
      const args = [...base(), '-vf', vf, '-frames:v', '1', ...fmt, 'pipe:1']
      const res = await run(ffmpeg, args, { timeoutMs: 8000 })
      if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${res.code}`)
      return res.stdout
    }
    const jpeg = ['-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5']
    const [full, thumb, gray] = await Promise.all([
      one(`scale='min(${fullWidth},iw)':-2`, jpeg),
      one(`scale='min(${thumbWidth},iw)':-2`, jpeg),
      one(`scale=${GRID_W}:${GRID_H},format=gray`, ['-f', 'rawvideo', '-pix_fmt', 'gray']),
    ])
    return { full, thumb, gray: new Uint8Array(gray) }
  }

  return {
    id: 'ffmpeg',
    label: 'B · ffmpeg gdigrab',
    async probe() {
      if (process.platform !== 'win32') return { ok: false, reason: 'gdigrab 只在 Windows 上可用' }
      ffmpeg = findBinary('ffmpeg')
      if (!ffmpeg) return { ok: false, reason: '本机没有 ffmpeg（PATH 上找不到）' }
      return { ok: true }
    },
    async grab({ fullWidth = 1280, thumbWidth = 512 } = {}) {
      let frame
      if (mode === 'pipes') {
        try {
          frame = await grabPipes(fullWidth, thumbWidth)
          if (!frame.thumb.length || frame.gray.length !== GRID_W * GRID_H) throw new Error('额外管道没有数据')
        } catch {
          mode = 'separate'
        }
      }
      if (!frame || mode === 'separate') frame = await grabSeparate(fullWidth, thumbWidth)
      if (!frame.full.length) throw new Error('ffmpeg 没有产出画面')
      return { ...frame, width: 0, height: 0 }
    },
    dispose() {},
  }
}
