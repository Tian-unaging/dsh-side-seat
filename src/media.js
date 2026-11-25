/**
 * 子进程与 ffmpeg 定位。
 *
 * 纪律（坑 6）：
 *  - 一律 spawn(argv 数组)，绝不 shell:true；
 *  - 每个子进程登记在 children 里，插件停用 / DSH 退出 / 异常中断都能收干净；
 *  - Windows 上用 taskkill /T /F 收整棵进程树。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { SideSeatError, appendLog, dshHome, log } from './util.js'

const children = new Set()

export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* already gone */ }
}

/** 插件停用时调用：杀掉所有仍在跑的子进程。 */
export function killAllChildren() {
  for (const child of [...children]) killTree(child)
  children.clear()
}

export function track(child) {
  children.add(child)
  const drop = () => children.delete(child)
  child.once('exit', drop)
  child.once('error', drop)
  return child
}

export function liveChildCount() {
  return [...children].filter((c) => c.exitCode === null && !c.killed).length
}

/**
 * 跑一个短命进程，收集 stdout（Buffer）与 stderr（文本）。
 * extraPipes = 额外的输出管道数（fd 3、4…），返回 extra[] Buffer。
 */
export function run(cmd, args, { signal, timeoutMs = 60000, extraPipes = 0, input = null, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SideSeatError('ABORTED', '已取消')); return }
    const stdio = ['pipe', 'pipe', 'pipe']
    for (let i = 0; i < extraPipes; i++) stdio.push('pipe')
    let child
    try {
      child = track(spawn(cmd, args, { stdio, windowsHide: true }))
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const extra = Array.from({ length: extraPipes }, () => [])
    let outBytes = 0
    let err = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => { killTree(child); finish(reject, new SideSeatError('ABORTED', '已取消')) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const timer = setTimeout(() => { killTree(child); finish(reject, new SideSeatError('TIMEOUT', `${cmd} 超时（${Math.round(timeoutMs / 1000)} 秒）`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) { killTree(child); finish(reject, new SideSeatError('TOO_LARGE', '子进程输出超过上限')); return }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => { if (err.length < 200000) err += chunk.toString('utf8') })
    for (let i = 0; i < extraPipes; i++) {
      const stream = child.stdio[3 + i]
      stream?.on('data', (chunk) => extra[i].push(chunk))
      stream?.on('error', () => {})
    }
    child.once('error', (error) => finish(reject, error))
    child.once('close', (code) => finish(resolve, {
      code,
      stdout: Buffer.concat(out),
      stderr: err,
      extra: extra.map((parts) => Buffer.concat(parts)),
    }))
    if (input) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

function onPath(names) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  return null
}

function candidates(base) {
  const exe = process.platform === 'win32' ? `${base}.exe` : base
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const local = process.env.LOCALAPPDATA || ''
  return [
    // 插件自己下载的那份优先，这样「在设置里点安装」立刻生效
    join(dshHome(), 'plugins-data', 'side-seat', 'bin', exe),
    local && join(local, 'Microsoft', 'WinGet', 'Links', exe),
    join('C:\\ffmpeg\\bin', exe),
    'C:\\Program Files\\ffmpeg\\bin\\' + exe,
    home && join(home, 'scoop', 'shims', exe),
    '/usr/local/bin/' + base,
    '/usr/bin/' + base,
    '/opt/homebrew/bin/' + base,
  ].filter(Boolean)
}

const cache = new Map()
// 「没找到」不能永久缓存：用户在设置里装、或用 winget 装完之后，
// 宿主是长驻进程，永久缓存会让它一直说"没装"。命中永久缓存，未命中只缓存 5 秒。
const MISS_TTL_MS = 5000

/** 坑 2：ffmpeg 不是想当然就有的。找不到返回 null，由调用方显式降级。 */
export function findBinary(base) {
  const hit = cache.get(base)
  if (hit && (hit.value || Date.now() - hit.at < MISS_TTL_MS)) return hit.value
  const envKeys = base === 'ffmpeg'
    ? ['DSH_SIDE_SEAT_FFMPEG', 'DSH_FFMPEG_PATH', 'DSH_VIDEO_FFMPEG', 'FFMPEG_PATH']
    : ['DSH_SIDE_SEAT_FFPROBE', 'DSH_FFPROBE_PATH', 'FFPROBE_PATH']
  let found = null
  for (const key of envKeys) {
    const value = process.env[key]
    if (value && existsSync(value)) { found = value; break }
  }
  if (!found) found = onPath(process.platform === 'win32' ? [`${base}.exe`] : [base])
  if (!found) found = candidates(base).find((p) => existsSync(p)) || null
  cache.set(base, { value: found, at: Date.now() })
  if (found) log(`${base}: ${found}`)
  return found
}

export function resetBinaryCache() { cache.clear() }

export function requireFfmpeg() {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) {
    // 把查找过的路径和存在性写进日志：找不到时能一眼看出是路径算错还是没装
    try {
      const checked = candidates('ffmpeg').map((p) => `${existsSync(p) ? 'OK  ' : 'miss'} ${p}`)
      appendLog('ffmpeg.log', `ffmpeg not found. DSH_HOME=${process.env.DSH_HOME || '(unset)'} dshHome=${dshHome()}\n${checked.join('\n')}`)
    } catch { /* ignore */ }
    throw new SideSeatError(
      'NO_FFMPEG',
      '这一项需要 ffmpeg，但本机没有找到（PATH 上没有 ffmpeg）。',
      '装好 ffmpeg 后重试，或设置环境变量 DSH_SIDE_SEAT_FFMPEG 指向 ffmpeg.exe。看屏幕（target=screen）与实时陪看不需要 ffmpeg。',
    )
  }
  return ffmpeg
}

/** 跑一段 Windows PowerShell 脚本（-EncodedCommand，UTF-16LE base64）。 */
export function runPowerShell(script, opts = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], opts)
}
