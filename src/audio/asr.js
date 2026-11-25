/**
 * 听写引擎（5.4.3）：可插拔，三选一，外加「无」——「无」是合法状态，不是错误。
 *
 *   none      只做 L0 音频事件；状态条写「听不见台词」；任何输出里都不出现台词
 *   builtin   DSH 自带的 STT 服务（探测到才可用）
 *   openai    OpenAI 兼容 /audio/transcriptions：baseURL + apiKey + model + language
 *   command   一行命令模板，含 {wav} 与 {out}（whisper.cpp / faster-whisper / 讯飞、阿里等）
 *
 * 隐私（5.4.6）：默认「无」；云端引擎需要用户首次确认；只上传检测到人声的 3–5 秒片段。
 * 密钥（5.4.5）：走 DSH 凭据服务，不进 settings、不进 cordis.patch.yml、不进日志。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { svc } from '../compat.js'
import { run, runPowerShell } from '../media.js'
import { SideSeatError, errMsg, splitCommand } from '../util.js'

export const CREDENTIAL_REF = 'SIDE_SEAT_ASR_API_KEY'

/* ---------------- WAV ---------------- */

export function pcm16ToWav(pcm, sampleRate = 16000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

export function isWav(buf) {
  return Buffer.isBuffer(buf) && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/** 解析 SRT / VTT / JSON / 纯文本 -> [{ start, end, text }]（秒）。 */
export function parseTranscript(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw) return []
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const j = JSON.parse(raw)
      const list = Array.isArray(j) ? j : Array.isArray(j.segments) ? j.segments : j.text ? [{ start: 0, end: 0, text: j.text }] : []
      return list.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() })).filter((s) => s.text)
    } catch { /* fall through */ }
  }
  const ts = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/
  if (ts.test(raw)) {
    const toSec = (s) => {
      const parts = s.trim().replace(',', '.').split(':').map(Number)
      return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
    }
    const out = []
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/)
      const idx = lines.findIndex((l) => ts.test(l))
      if (idx < 0) continue
      const [a, b] = lines[idx].split('-->')
      const textLines = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim()
      if (textLines) out.push({ start: toSec(a), end: toSec(b.split(/\s/).filter(Boolean)[0] || b), text: textLines })
    }
    return out
  }
  return [{ start: 0, end: 0, text: raw.replace(/\s+/g, ' ') }]
}

/* ---------------- 凭据 ---------------- */

async function credentialRefOf() {
  try {
    const mod = await import('@deepseek-ai/dsh-credentials')
    if (typeof mod.credentialRef === 'function') return mod.credentialRef(CREDENTIAL_REF)
  } catch { /* optional */ }
  return CREDENTIAL_REF
}

export function createCredentials(ctx) {
  const service = () => svc(ctx, 'credentials')
  return {
    /** 每次真正发请求时现解析，不跨操作缓存明文。 */
    async resolve() {
      const c = service()
      if (c && typeof c.resolve === 'function') {
        for (const ref of [await credentialRefOf(), CREDENTIAL_REF]) {
          try {
            const v = await c.resolve(ref)
            const value = typeof v === 'string' ? v : v?.value
            if (value) return String(value)
          } catch { /* try next shape */ }
        }
      }
      return process.env[CREDENTIAL_REF] || ''
    },
    async describe() {
      const c = service()
      if (c && typeof c.describe === 'function') {
        try {
          const d = await c.describe([CREDENTIAL_REF])
          const item = Array.isArray(d) ? d[0] : d?.[CREDENTIAL_REF] ?? d
          if (item && typeof item === 'object' && 'configured' in item) {
            return { configured: Boolean(item.configured), writable: item.writable !== false, source: item.source || 'credentials' }
          }
        } catch { /* fall through */ }
      }
      const value = await this.resolve()
      return { configured: Boolean(value), writable: Boolean(c && typeof c.set === 'function'), source: process.env[CREDENTIAL_REF] ? 'env' : c ? 'credentials' : 'none' }
    },
    async set(value) {
      const c = service()
      if (!c || typeof c.set !== 'function') {
        throw new SideSeatError('CREDENTIALS_READONLY', '宿主侧凭据服务不可写', `可以在 $DSH_HOME/.credentials.yaml 里写 ${CREDENTIAL_REF}，或设环境变量 ${CREDENTIAL_REF} 后重启`)
      }
      const ref = await credentialRefOf()
      if (value) await c.set(ref, String(value))
      else if (typeof c.unset === 'function') await c.unset(ref)
      return true
    },
  }
}

/* ---------------- 引擎 ---------------- */

function classifyError(error) {
  const msg = errMsg(error)
  const code = error?.cause?.code || error?.code || ''
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|getaddrinfo|fetch failed/i.test(`${code} ${msg}`)) return `地址错：连不上接口（${msg}）`
  if (/ENOENT/.test(`${code} ${msg}`)) return `命令不存在：${msg}`
  return msg
}

export function createAsr(ctx, { getCfg }) {
  const creds = createCredentials(ctx)

  function builtinService() {
    for (const name of ['stt', 'speechToText', 'transcription', 'asr']) {
      const s = svc(ctx, name)
      if (s && typeof s.transcribe === 'function') return s
    }
    return null
  }

  function status(cfg = getCfg()) {
    const engine = cfg.asrEngine
    if (engine === 'none') return { engine, ready: false, cloud: false, reason: '未配置听写引擎：只能听到声音事件，听不见台词' }
    if (engine === 'builtin') {
      return builtinService()
        ? { engine, ready: true, cloud: false, reason: '' }
        : { engine, ready: false, cloud: false, reason: '没有探测到 DSH 内置听写服务；可改用「自定义命令」接本地 whisper.cpp / faster-whisper' }
    }
    if (engine === 'openai') {
      if (!cfg.asrBaseUrl || !cfg.asrModel) return { engine, ready: false, cloud: true, reason: 'OpenAI 兼容引擎需要填写接口地址与模型名' }
      if (!cfg.asrCloudConsent) return { engine, ready: false, cloud: true, reason: '云端听写尚未确认：首次切换需要在设置页确认上传' }
      return { engine, ready: true, cloud: true, reason: '' }
    }
    if (engine === 'command') {
      if (!/\{wav\}/.test(cfg.asrCommand)) return { engine, ready: false, cloud: false, reason: '命令模板里需要包含 {wav}' }
      return { engine, ready: true, cloud: false, reason: '' }
    }
    return { engine, ready: false, cloud: false, reason: '未知引擎' }
  }

  async function viaOpenAI(cfg, wav, signal) {
    let url = cfg.asrBaseUrl.trim().replace(/\/+$/, '')
    if (!/\/audio\/transcriptions$/.test(url)) url += '/audio/transcriptions'
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'side-seat.wav')
    form.append('model', cfg.asrModel)
    form.append('response_format', 'json')
    if (cfg.asrLanguage !== 'auto') form.append('language', cfg.asrLanguage)
    const key = await creds.resolve()
    const headers = key ? { Authorization: `Bearer ${key}` } : {}
    let res
    try {
      res = await fetch(url, { method: 'POST', body: form, headers, signal })
    } catch (error) {
      throw new SideSeatError('ASR_NETWORK', classifyError(error))
    }
    const body = await res.text()
    if (res.status === 401 || res.status === 403) throw new SideSeatError('ASR_AUTH', `密钥错：接口返回 ${res.status}`)
    if (res.status === 404) throw new SideSeatError('ASR_URL', `地址错：${url} 返回 404`)
    if (!res.ok) throw new SideSeatError('ASR_HTTP', `接口返回 ${res.status}：${body.slice(0, 200)}`)
    return parseTranscript(body)
  }

  async function viaCommand(cfg, wav, signal) {
    const id = randomUUID()
    const wavPath = join(tmpdir(), `side-seat-${id}.wav`)
    const outPath = join(tmpdir(), `side-seat-${id}.txt`)
    // 音频只在这一行命令的生命周期里短暂落在临时目录，结束即删
    writeFileSync(wavPath, wav)
    try {
      const argv = splitCommand(cfg.asrCommand).map((a) => a.replaceAll('{wav}', wavPath).replaceAll('{out}', outPath))
      if (!argv.length) throw new SideSeatError('ASR_COMMAND', '命令模板是空的')
      let res
      try {
        res = await run(argv[0], argv.slice(1), { signal, timeoutMs: 120000 })
      } catch (error) {
        throw new SideSeatError('ASR_COMMAND', classifyError(error))
      }
      if (res.code !== 0) throw new SideSeatError('ASR_COMMAND', `命令退出码 ${res.code}：${res.stderr.trim().slice(-300)}`)
      const candidates = [outPath, `${outPath}.srt`, `${outPath}.txt`, outPath.replace(/\.txt$/, '.srt')]
      for (const p of candidates) {
        if (existsSync(p)) {
          const text = readFileSync(p, 'utf8')
          return parseTranscript(text)
        }
      }
      return parseTranscript(res.stdout.toString('utf8'))
    } finally {
      for (const p of [wavPath, outPath, `${outPath}.srt`, `${outPath}.txt`, outPath.replace(/\.txt$/, '.srt')]) {
        try { rmSync(p, { force: true }) } catch { /* ignore */ }
      }
    }
  }

  async function viaBuiltin(cfg, wav, signal) {
    const s = builtinService()
    if (!s) throw new SideSeatError('ASR_BUILTIN', '没有探测到 DSH 内置听写服务')
    const res = await s.transcribe({ audio: new Uint8Array(wav), mediaType: 'audio/wav', language: cfg.asrLanguage === 'auto' ? undefined : cfg.asrLanguage, signal })
    if (typeof res === 'string') return parseTranscript(res)
    if (Array.isArray(res?.segments)) return res.segments.map((x) => ({ start: x.start || 0, end: x.end || 0, text: String(x.text || '').trim() })).filter((x) => x.text)
    return parseTranscript(res?.text || '')
  }

  /** 转写一段 WAV。返回 { segments, cloud, engine }；引擎为「无」时抛 NO_ENGINE。 */
  async function transcribe(wav, { signal, cfg = getCfg(), allowUnconsented = false } = {}) {
    const st = status(cfg)
    if (cfg.asrEngine === 'none') throw new SideSeatError('NO_ENGINE', st.reason)
    if (!st.ready && !(allowUnconsented && cfg.asrEngine === 'openai' && cfg.asrBaseUrl && cfg.asrModel)) {
      throw new SideSeatError('ASR_NOT_READY', st.reason)
    }
    let segments
    if (cfg.asrEngine === 'openai') segments = await viaOpenAI(cfg, wav, signal)
    else if (cfg.asrEngine === 'command') segments = await viaCommand(cfg, wav, signal)
    else segments = await viaBuiltin(cfg, wav, signal)
    return { segments: dropSuspect(segments, wav), cloud: st.cloud, engine: cfg.asrEngine }
  }

  /** 「试一下」：现场合成一段样例语音，跑一遍，给出第一句或明确的失败原因。 */
  async function test(cfg = getCfg()) {
    if (cfg.asrEngine === 'none') return { ok: false, reason: '当前引擎是「无」：选一个引擎再试' }
    let sample
    try {
      sample = await makeSampleWav()
    } catch (error) {
      return { ok: false, reason: `无法生成样例音频：${errMsg(error)}` }
    }
    try {
      const res = await transcribe(sample, { cfg, allowUnconsented: true })
      const first = res.segments.map((s) => s.text).find(Boolean)
      if (!first) return { ok: false, reason: '引擎跑通了，但没有识别出任何文字（样例是一句中文）' }
      return { ok: true, text: first, cloud: res.cloud }
    } catch (error) {
      return { ok: false, reason: errMsg(error) }
    }
  }

  return { status, transcribe, test, credentials: creds }
}

/**
 * 识别器在纯音乐上会编一句话再给它很长的时间段。丢掉：只剩标点的句子、
 * 以及超过 8 秒且每秒不足 0.8 个字的句子。
 */
export function dropSuspect(segments) {
  return (segments || []).filter((s) => {
    const text = String(s.text || '').trim()
    if (!text.replace(/[\s\p{P}\p{S}]/gu, '')) return false
    const dur = (s.end || 0) - (s.start || 0)
    if (dur > 8 && text.replace(/\s/g, '').length / dur < 0.8) return false
    return true
  })
}

/** 用 Windows 自带语音合成现场生成样例音频（不随包分发任何录音）。 */
export async function makeSampleWav() {
  if (process.platform !== 'win32') throw new Error('样例音频需要 Windows 语音合成（System.Speech）')
  const id = randomUUID()
  const path = join(tmpdir(), `side-seat-sample-${id}.wav`)
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name); $text = '你好，我是旁座，这是一段听写测试。' } else { $text = 'Hello, this is a side seat dictation test.' }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${path.replace(/'/g, "''")}', $fmt)
$s.Speak($text)
$s.Dispose()
`
  try {
    const res = await runPowerShell(script, { timeoutMs: 30000 })
    if (!existsSync(path)) throw new Error(res.stderr.trim().slice(0, 200) || '没有生成文件')
    return readFileSync(path)
  } finally {
    try { rmSync(path, { force: true }) } catch { /* ignore */ }
  }
}
