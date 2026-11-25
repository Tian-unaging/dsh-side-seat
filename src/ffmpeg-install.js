/**
 * ffmpeg 按需安装（设置页的那个按钮）。
 *
 * 为什么不随包分发：一份 Windows 版 ffmpeg 压缩包 30–180MB，而插件本体只有 ~150KB；
 * 且 ffmpeg 是 LGPL/GPL 许可，随包分发要附带许可证与源码地址。按需下载让用户显式同意这一步。
 *
 * 多个下载源依次尝试（国内 GitHub 大文件经常中途断开）：
 *   1. npmmirror 的单文件 ffmpeg（约 29MB 压缩，单可执行文件，最快）
 *   2. BtbN 的 LGPL 完整 zip（含 ffprobe，约 179MB）
 *   3. gyan.dev 的 essentials zip（约 119MB）
 * 装到 $DSH_HOME/plugins-data/side-seat/bin/，media.js 的查找顺序里排在最前。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { dshHome, appendLog, errMsg } from './util.js'
import { resetBinaryCache } from './media.js'

const SOURCES = [
  {
    id: 'npmmirror',
    kind: 'gz',
    label: 'npmmirror 单文件（约 29MB）',
    url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-win32-x64.gz',
  },
  {
    id: 'btbn',
    kind: 'zip',
    label: 'BtbN LGPL 完整包（约 179MB，含 ffprobe）',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip',
  },
  {
    id: 'gyan',
    kind: 'zip',
    label: 'gyan.dev essentials（约 119MB）',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  },
]

const state = { phase: 'idle', source: '', got: 0, total: 0, error: '', tried: [], at: 0, exe: '' }

export function ffmpegStatus() {
  return { ...state, tried: [...state.tried] }
}

function baseDir() {
  return join(dshHome(), 'plugins-data', 'side-seat')
}

function binDir() {
  return join(baseDir(), 'bin')
}

function walkFor(dir, name, out = []) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walkFor(p, name, out)
      else if (entry.name.toLowerCase() === name.toLowerCase()) out.push(p)
    }
  } catch { /* 目录不可读就跳过 */ }
  return out
}

function expand(zip, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dest, { recursive: true })
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
    ], { stdio: 'ignore', windowsHide: true })
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败，退出码 ${code}`))))
    proc.on('error', reject)
  })
}

/** 把响应流写到文件或内存；边写边更新进度。 */
async function fetchTo(res, target) {
  if (target.memory) {
    const chunks = []
    for await (const chunk of res.body) {
      state.got += chunk.length
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  await new Promise((resolve, reject) => {
    const file = createWriteStream(target.file)
    file.on('error', reject)
    file.on('finish', resolve)
    ;(async () => {
      try {
        for await (const chunk of res.body) {
          state.got += chunk.length
          if (!file.write(chunk)) await new Promise((r) => file.once('drain', r))
        }
        file.end()
      } catch (error) {
        reject(error)
      }
    })()
  })
  return null
}

async function trySource(source) {
  state.source = source.id
  state.got = 0
  state.total = 0
  state.phase = 'downloading'
  appendLog('ffmpeg.log', `try ${source.id} ${source.url}`)

  const res = await fetch(source.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  state.total = Number(res.headers.get('content-length') || 0)

  mkdirSync(binDir(), { recursive: true })

  if (source.kind === 'gz') {
    const buf = await fetchTo(res, { memory: true })
    state.phase = 'extracting'
    const exe = gunzipSync(buf)
    writeFileSync(join(binDir(), 'ffmpeg.exe'), exe)
    return { ffmpeg: join(binDir(), 'ffmpeg.exe') }
  }

  const zip = join(baseDir(), `ffmpeg-${source.id}.zip`)
  const tmp = join(baseDir(), `ffmpeg-extract-${source.id}`)
  try {
    await fetchTo(res, { file: zip })
    state.phase = 'extracting'
    await expand(zip, tmp)
    const ff = walkFor(tmp, 'ffmpeg.exe')[0]
    const fp = walkFor(tmp, 'ffprobe.exe')[0]
    if (!ff) throw new Error('压缩包里没找到 ffmpeg.exe')
    copyFileSync(ff, join(binDir(), 'ffmpeg.exe'))
    if (fp) copyFileSync(fp, join(binDir(), 'ffprobe.exe'))
    return { ffmpeg: join(binDir(), 'ffmpeg.exe') }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(zip, { force: true }) } catch { /* ignore */ }
  }
}

/** 下载 + 解压 + 落位。整个过程写进 state，界面轮询显示进度。 */
export async function installFfmpeg() {
  if (state.phase === 'downloading' || state.phase === 'extracting') return ffmpegStatus()
  if (process.platform !== 'win32') {
    state.phase = 'error'
    state.error = '自动安装目前只支持 Windows；其它系统请手动安装 ffmpeg'
    state.at = Date.now()
    return ffmpegStatus()
  }

  state.phase = 'downloading'
  state.source = ''
  state.got = 0
  state.total = 0
  state.error = ''
  state.tried = []
  state.at = Date.now()

  for (const source of SOURCES) {
    try {
      const got = await trySource(source)
      resetBinaryCache()
      state.phase = 'done'
      state.exe = got.ffmpeg
      state.error = ''
      state.at = Date.now()
      appendLog('ffmpeg.log', `installed from ${source.id}: ${state.exe}`)
      return ffmpegStatus()
    } catch (error) {
      const reason = errMsg(error)
      state.tried.push(`${source.id}: ${reason}`)
      appendLog('ffmpeg.log', `${source.id} failed: ${reason}`)
    }
  }

  state.phase = 'error'
  state.error = state.tried.join('；') || '所有下载源都失败了'
  state.at = Date.now()
  return ffmpegStatus()
}
