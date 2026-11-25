/**
 * 桌面弹窗的宿主半边。
 *
 * DSH 的 Host 是 Electron 的子进程（实测 desktopCapturer 不可用），插件无法创建 Electron 窗口，
 * 所以弹窗交给一个常驻的 PowerShell + WPF 窗口（overlay/overlay.ps1）。
 *
 * 双向通信走文件：
 *   lines.json   宿主 → 弹窗（显示最近若干句）
 *   inbox.jsonl  弹窗 → 宿主（用户在弹窗里回的话，宿主转成一条会话消息）
 *
 * 弹窗窗口带 WDA_EXCLUDEFROMCAPTURE，截屏 API 看不见它 —— 旁座不会把自己的弹窗看成画面内容。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendLog, dataDir, errMsg } from './util.js'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function createOverlay() {
  const dir = join(dataDir(), 'overlay')
  const linesFile = join(dir, 'lines.json')
  const inboxFile = join(dir, 'inbox.jsonl')
  const aliveFile = join(dir, 'alive.json')
  const windowFile = join(dir, 'window.json')
  const scriptPath = join(PKG_ROOT, 'overlay', 'overlay.ps1')
  let child = null
  let lines = []

  function ensureDir() {
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }

  function writeLines() {
    try {
      ensureDir()
      writeFileSync(linesFile, JSON.stringify(lines.slice(-20)), 'utf8')
    } catch (error) {
      appendLog('overlay.log', `write lines failed: ${errMsg(error)}`)
    }
  }

  /** 心跳：{ t, pid }。拿不到就当没有。 */
  function readAlive() {
    try {
      if (!existsSync(aliveFile)) return null
      const raw = readFileSync(aliveFile, 'utf8').trim()
      if (!raw) return null
      if (raw.startsWith('{')) return JSON.parse(raw)
      const t = Number(raw)
      return Number.isFinite(t) ? { t, pid: NaN } : null
    } catch {
      return null
    }
  }

  /** 弹窗自报的窗口几何；看不见时靠它判断是位置问题还是没启动。 */
  function readWindow() {
    try {
      if (!existsSync(windowFile)) return null
      return JSON.parse(readFileSync(windowFile, 'utf8'))
    } catch {
      return null
    }
  }

  /** 脚本版本号：用 mtime 当指纹，脚本一改就不复用旧窗口。 */
  function scriptVersion() {
    try {
      return String(Math.round(statSync(scriptPath).mtimeMs))
    } catch {
      return '0'
    }
  }

  function open() {
    const alive = readAlive()
    const fresh = alive && Number.isFinite(alive.t) && Date.now() - alive.t < 3000
    // 脚本一改，旧窗口里的 UI 就是旧的。用脚本 mtime 当版本号，
    // 版本不同就不复用 —— 否则改完样式点按钮还是看到老界面。
    const wantVer = scriptVersion()
    const info = readWindow()
    const upToDate = Boolean(info) && String(info.v || '') === wantVer
    if (child && !child.killed && fresh && upToDate) {
      appendLog('overlay.log', 'open: 复用已在运行的弹窗')
      return { ok: true, reused: true }
    }
    // 孤儿进程：插件重载后丢了 child 引用，但窗口还活着。
    // 只有心跳很新（说明这个 pid 确实还是弹窗）才结束它 ——
    // 心跳过期时 pid 可能已被系统复用给别的程序，误杀代价太高。
    if (alive && Number.isFinite(alive.pid)) {
      const stillLive = Number.isFinite(alive.t) && Date.now() - alive.t < 5000
      if (stillLive) {
        try {
          process.kill(alive.pid)
          appendLog('overlay.log', `open: 结束孤儿弹窗 pid=${alive.pid}`)
        } catch { /* 已经没了 */ }
      }
    }
    if (child) {
      try { child.kill() } catch { /* ignore */ }
      child = null
    }
    // 清掉所有登记在案的残留实例：多个窗口叠在一起时，用户看到的是旧界面
    try {
      const pidsFile = join(dir, 'pids.json')
      if (existsSync(pidsFile)) {
        const list = JSON.parse(readFileSync(pidsFile, 'utf8'))
        for (const pid of Array.isArray(list) ? list : [list]) {
          const n = Number(pid)
          if (!Number.isFinite(n) || n <= 0) continue
          try { process.kill(n); appendLog('overlay.log', `open: 结束残留实例 pid=${n}`) } catch { /* 已退出 */ }
        }
        try { writeFileSync(pidsFile, '[]', 'utf8') } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (!existsSync(scriptPath)) {
      appendLog('overlay.log', `script missing: ${scriptPath}`)
      return { ok: false, reason: '找不到 overlay.ps1' }
    }
    ensureDir()
    writeLines()
    try {
      try { writeFileSync(join(dir, 'expected.json'), JSON.stringify({ v: wantVer, at: Date.now() }), 'utf8') } catch { /* ignore */ }
      // WPF 需要 STA：用 Windows PowerShell（默认 STA），并隐藏控制台窗口
      child = spawn('powershell.exe', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', scriptPath, '-DataDir', dir,
      ], { stdio: 'ignore', windowsHide: true })
      const spawnedAt = Date.now()
      child.on('exit', (code) => {
        appendLog('overlay.log', `overlay exited (${code})`)
        child = null
      })
      child.on('error', (error) => {
        appendLog('overlay.log', `overlay spawn error: ${errMsg(error)}`)
        child = null
      })
      appendLog('overlay.log', `spawned pid=${child.pid} ${scriptPath}`)
      // 起来之后把实际几何记下来：看不见时能直接判断是位置问题还是没启动。
      // WPF 首次启动要编译 XAML + Add-Type，1.8 秒常常不够，所以轮询等待，别误报。
      let waited = 0
      const verify = () => {
        const info = readWindow()
        if (!info) {
          waited += 700
          if (waited <= 5600) {
            const again = setTimeout(verify, 700)
            if (typeof again.unref === 'function') again.unref()
          } else {
            appendLog('overlay.log', 'warn: 窗口已启动但 6 秒内没写出 window.json（脚本可能在启动阶段出错了）')
          }
          return
        }
        const sw = Number(info.screenW) || 0
        const sh = Number(info.screenH) || 0
        const offscreen = sw > 0 && sh > 0 &&
          (info.left >= sw || info.top >= sh || info.left + info.width <= 0 || info.top + info.height <= 0)
        appendLog('overlay.log', `window ${info.left},${info.top} ${info.width}x${info.height} on ${sw}x${sh} excluded=${info.excluded}${offscreen ? ' OFFSCREEN' : ''} latency=${Date.now() - spawnedAt}ms`)
      }
      const firstCheck = setTimeout(verify, 700)
      if (typeof firstCheck.unref === 'function') firstCheck.unref()
      return { ok: true }
    } catch (error) {
      appendLog('overlay.log', `spawn threw: ${errMsg(error)}`)
      return { ok: false, reason: errMsg(error) }
    }
  }

  function close() {
    try { if (child) child.kill() } catch { /* ignore */ }
    child = null
    return { ok: true }
  }

  function running() {
    return Boolean(child && !child.killed)
  }

  /** 旁座或用户说了一句，推到弹窗。role: 'assistant'（左）| 'user'（右）。 */
  function push(text, role = 'assistant') {
    const line = String(text || '').trim()
    if (!line) return
    const r = role === 'user' ? 'user' : 'assistant'
    lines.push({ t: Date.now(), role: r, text: line })
    if (lines.length > 20) lines = lines.slice(-20)
    writeLines()
    // 每次推送都留痕：渲染异常时能对比"推了 4 条、只画出 2 个气泡"
    appendLog('overlay.log', `push ${r} len=${line.length} total=${lines.length}: ${line.slice(0, 40)}`)
  }

  /** 取走用户在弹窗里回的话（读完即清空）。 */
  function drain() {
    try {
      if (!existsSync(inboxFile)) return []
      const raw = readFileSync(inboxFile, 'utf8')
      if (!raw.trim()) return []
      writeFileSync(inboxFile, '', 'utf8')
      return raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => { try { return JSON.parse(s) } catch { return null } })
        .filter(Boolean)
    } catch (error) {
      appendLog('overlay.log', `drain failed: ${errMsg(error)}`)
      return []
    }
  }

  function reset() {
    lines = []
    writeLines()
  }

  return { open, close, push, drain, running, reset, dir, scriptPath }
}
