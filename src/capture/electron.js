/**
 * 截屏后端 A · Electron desktopCapturer。
 *
 * 只有 Host 真跑在 Electron 主进程里时才可用。DSH Desktop 通常把 Host 作为
 * Electron 外壳的子进程启动（此时 require('electron') 拿到的是可执行文件路径
 * 字符串，或直接抛错）——那就如实报「不可用」，交给后端 B/C。
 */
import { createRequire } from 'node:module'
import { GRID_H, GRID_W } from '../diff.js'

const require = createRequire(import.meta.url)

function loadElectron() {
  try {
    const electron = require('electron')
    if (electron && typeof electron === 'object' && electron.desktopCapturer && typeof electron.desktopCapturer.getSources === 'function') {
      return electron
    }
    return null
  } catch {
    return null
  }
}

function bgraToGray(bitmap, width, height) {
  const gray = new Uint8Array(GRID_W * GRID_H)
  if (!bitmap || bitmap.length < width * height * 4) return gray
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / GRID_W))
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / GRID_H))
      const i = (sy * width + sx) * 4
      gray[y * GRID_W + x] = Math.round(0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2])
    }
  }
  return gray
}

export function createElectronBackend() {
  let electron = null
  return {
    id: 'electron',
    label: 'A · Electron desktopCapturer',
    async probe() {
      if (!process.versions.electron) return { ok: false, reason: 'Host 不在 Electron 进程内' }
      electron = loadElectron()
      if (!electron) return { ok: false, reason: 'Host 进程里拿不到 desktopCapturer（通常是 Electron 子进程 / RUN_AS_NODE）' }
      return { ok: true }
    },
    async grab({ fullWidth = 1280, thumbWidth = 512 } = {}) {
      const { desktopCapturer, screen } = electron
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: fullWidth, height: fullWidth } })
      if (!sources || !sources.length) throw new Error('desktopCapturer 没有返回任何屏幕')
      let source = sources[0]
      try {
        const primary = screen?.getPrimaryDisplay?.()
        if (primary) source = sources.find((s) => String(s.display_id) === String(primary.id)) || source
      } catch { /* keep first */ }
      const image = source.thumbnail
      if (!image || image.isEmpty()) throw new Error('截到的是空图（可能没有屏幕录制权限）')
      const size = image.getSize()
      const thumb = image.resize({ width: Math.min(thumbWidth, size.width), quality: 'good' })
      const tiny = image.resize({ width: GRID_W, height: GRID_H, quality: 'good' })
      return {
        full: image.toJPEG(80),
        thumb: thumb.toJPEG(70),
        gray: bgraToGray(tiny.toBitmap(), GRID_W, GRID_H),
        width: size.width,
        height: size.height,
      }
    },
    dispose() { electron = null },
  }
}
