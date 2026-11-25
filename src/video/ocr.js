/**
 * OCR（Windows 自带 Windows.Media.Ocr，内建、不下载模型）。
 * 用于 caption 的 text 字段，以及「网页 / 文档」类画面优先读字（4.1.2）。
 * 不可用时直接说不可用，不装作有。
 *
 * 注：WinRT OCR 只接受文件 / 流，这里把一帧 JPEG 短暂写进临时目录，读完即删。
 */
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPowerShell } from '../media.js'
import { errMsg } from '../util.js'

let available = null
let reason = ''

function script(path) {
  const p = path.replace(/'/g, "''")
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${p}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine -eq $null) { throw 'no OCR language pack' }
$res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $res.Lines) { [Console]::Out.WriteLine($line.Text) }
$stream.Dispose()
`
}

export function ocrStatus() { return { available, reason } }

/** jpeg Buffer -> 文本行数组；不可用返回 null。 */
export async function ocrImage(jpeg, { signal } = {}) {
  if (process.platform !== 'win32') { available = false; reason = '只在 Windows 上可用'; return null }
  if (available === false) return null
  const path = join(tmpdir(), `side-seat-ocr-${randomUUID()}.jpg`)
  writeFileSync(path, jpeg)
  try {
    const res = await runPowerShell(script(path), { signal, timeoutMs: 30000 })
    if (res.code !== 0) {
      available = false
      reason = res.stderr.trim().split('\n').pop() || `PowerShell 退出码 ${res.code}`
      return null
    }
    available = true
    return res.stdout.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } catch (error) {
    available = false
    reason = errMsg(error)
    return null
  } finally {
    try { rmSync(path, { force: true }) } catch { /* ignore */ }
  }
}
