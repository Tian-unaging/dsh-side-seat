/**
 * 截屏后端 C · 常驻 Windows PowerShell 子进程（System.Drawing CopyFromScreen）。
 *
 * 一次启动、反复截：首次 Add-Type 要 1–2 秒，之后每帧几十毫秒。
 * 帧不落盘：JPEG 编码在内存流里，base64 经 stdout 回传。
 * 停用 / 退出 / 异常时用 taskkill /T /F 收整棵进程树（坑 6）。
 */
import { spawn } from 'node:child_process'
import { GRID_H, GRID_W } from '../diff.js'
import { killTree, track } from '../media.js'
import { log } from '../util.js'

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SideSeatDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][SideSeatDpi]::SetProcessDPIAware()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
function Enc($bmp, $q) {
  $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, $codec, $p)
  $b = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose(); $p.Dispose()
  return $b
}
function ScaleTo($src, $w, $h) {
  $dst = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  return $dst
}
function ScaleW($src, $w) {
  if ($w -ge $src.Width) { $w = $src.Width }
  $h = [int][Math]::Max(1, [Math]::Round($src.Height * $w / $src.Width))
  return ScaleTo $src $w $h
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'QUIT') { break }
  $parts = $line.Split(' ')
  $id = $parts[0]
  try {
    $fw = [int]$parts[1]; $tw = [int]$parts[2]
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $full = ScaleW $bmp $fw
    $thumb = ScaleW $bmp $tw
    $grid = ScaleTo $bmp ${GRID_W} ${GRID_H}
    $bytes = New-Object byte[] (${GRID_W} * ${GRID_H})
    for ($y = 0; $y -lt ${GRID_H}; $y++) {
      for ($x = 0; $x -lt ${GRID_W}; $x++) {
        $c = $grid.GetPixel($x, $y)
        $bytes[$y * ${GRID_W} + $x] = [byte][Math]::Round(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
      }
    }
    $hex = [BitConverter]::ToString($bytes).Replace('-', '')
    $out = 'OK ' + $id + ' ' + $b.Width + ' ' + $b.Height + ' ' + (Enc $full 80) + ' ' + (Enc $thumb 70) + ' ' + $hex
    $full.Dispose(); $thumb.Dispose(); $grid.Dispose(); $bmp.Dispose()
    [Console]::Out.WriteLine($out)
  } catch {
    [Console]::Out.WriteLine('ERR ' + $id + ' ' + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}
`

export function createPwshBackend() {
  let child = null
  let ready = null
  let buffer = ''
  let seq = 0
  const pending = new Map()
  let crashes = 0

  function failAll(reason) {
    for (const [, p] of pending) p.reject(new Error(reason))
    pending.clear()
  }

  function onLine(line) {
    if (line === 'READY') { ready?.resolveReady?.(); return }
    const sp = line.indexOf(' ')
    const kind = line.slice(0, sp)
    const rest = line.slice(sp + 1)
    const sp2 = rest.indexOf(' ')
    const id = sp2 < 0 ? rest : rest.slice(0, sp2)
    const job = pending.get(id)
    if (!job) return
    pending.delete(id)
    if (kind === 'ERR') { job.reject(new Error(rest.slice(sp2 + 1) || 'PowerShell 截屏失败')); return }
    const parts = rest.split(' ')
    // parts: id w h full thumb hex
    const hex = parts[5] || ''
    const gray = new Uint8Array(GRID_W * GRID_H)
    for (let i = 0; i < gray.length && i * 2 + 1 < hex.length; i++) gray[i] = parseInt(hex.substr(i * 2, 2), 16)
    job.resolve({
      width: Number(parts[1]) || 0,
      height: Number(parts[2]) || 0,
      full: Buffer.from(parts[3] || '', 'base64'),
      thumb: Buffer.from(parts[4] || '', 'base64'),
      gray,
    })
  }

  function start() {
    if (child && child.exitCode === null) return ready.promise
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    buffer = ''
    let resolveReady
    let rejectReady
    const promise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
    ready = { promise, resolveReady, rejectReady }
    const proc = track(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }))
    child = proc
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line) onLine(line)
      }
    })
    let errText = ''
    child.stderr.on('data', (c) => { if (errText.length < 4000) errText += c.toString() })
    child.stdin.on('error', () => {})
    child.once('error', (error) => { rejectReady(error); failAll(String(error.message)) })
    child.once('exit', (code) => {
      rejectReady(new Error(`PowerShell 退出（${code}）${errText ? '：' + errText.trim().slice(0, 300) : ''}`))
      if (child === proc) {
        failAll('PowerShell 截屏进程已退出')
        child = null
        crashes++
      }
    })
    const timer = setTimeout(() => rejectReady(new Error('PowerShell 启动超时（10 秒）')), 10000)
    promise.then(() => clearTimeout(timer), () => clearTimeout(timer))
    return promise
  }

  return {
    id: 'pwsh',
    label: 'C · 常驻 PowerShell',
    async probe() {
      if (process.platform !== 'win32') return { ok: false, reason: '只在 Windows 上可用' }
      crashes = 0
      try {
        await start()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error.message || error) }
      }
    },
    async grab({ fullWidth = 1280, thumbWidth = 512 } = {}) {
      if (!child) {
        if (crashes > 5) throw new Error('PowerShell 截屏进程反复退出，已放弃')
        await start()
      }
      await ready.promise
      const id = String(++seq)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('PowerShell 截屏超时'))
        }, 6000)
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v) },
          reject: (e) => { clearTimeout(timer); reject(e) },
        })
        try {
          child.stdin.write(`${id} ${Math.round(fullWidth)} ${Math.round(thumbWidth)}\n`)
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    dispose() {
      failAll('已停止')
      if (child) {
        try { child.stdin.write('QUIT\n') } catch { /* ignore */ }
        const c = child
        child = null
        killTree(c)
      }
      log('PowerShell 截屏进程已回收')
    },
  }
}
