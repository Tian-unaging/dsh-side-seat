/**
 * 共用小工具。没有任何副作用：日志写 stderr，数据目录只在被调用时创建。
 * 运行数据（设置兜底、记忆兜底）一律写在 $DSH_HOME/plugins-data/side-seat/，
 * 绝不写回包目录（包装进 node_modules 后可能只读）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export const PLUGIN_ID = 'side-seat'
export const PACKAGE_NAME = 'dsh-side-seat'
export const TOOL_PREFIX = 'side_seat_'
export const API_PREFIX = '/api/side-seat/'

/** 带稳定 code 的错误。message 面向人，hint 告诉人下一步怎么办。 */
export class SideSeatError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'SideSeatError'
    this.code = code
    this.hint = hint || ''
  }
}

export function log(...args) {
  try { console.error('[side-seat]', ...args) } catch { /* stderr gone */ }
}

export const debug = process.env.DSH_SIDE_SEAT_DEBUG
  ? (...args) => log('[debug]', ...args)
  : () => {}

export function errMsg(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error.code || error)
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const num01 = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  if (signal) {
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')) }, { once: true })
  }
})

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function dataDir() {
  const dir = join(dshHome(), 'plugins-data', PLUGIN_ID)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJsonFile(file, fallback) {  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** 追加一行排障日志到数据目录（有大小上限）。日志失败绝不影响主流程。 */
export function appendLog(name, line) {
  try {
    const file = join(dataDir(), name)
    try { if (statSync(file).size > 128 * 1024) writeFileSync(file, '') } catch { /* 首次 */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch { /* ignore */ }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 秒 -> mm:ss 或 h:mm:ss。B 轴所有出处都用这个格式，方便「点回」。 */
export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${pad2(m)}:${pad2(x)}`
}

/** 相似度 0..1：取「字符二元组 Dice」与「1 - 编辑距离 / 长度」的较大者。回声过滤与重复检测用；不依赖分词。 */
export function similarity(a, b) {
  const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 0.9 : 0
  const grams = (s) => {
    const map = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      map.set(g, (map.get(g) || 0) + 1)
    }
    return map
  }
  const gx = grams(x)
  const gy = grams(y)
  let hit = 0
  for (const [g, c] of gx) hit += Math.min(c, gy.get(g) || 0)
  const dice = (2 * hit) / (x.length - 1 + y.length - 1)
  if (x.length > 200 || y.length > 200) return dice
  // 识别结果常常只错一两个字（「得」→「的」），编辑距离比二元组更能认出这是同一句
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  const lev = 1 - prev[y.length] / Math.max(x.length, y.length)
  return Math.max(dice, lev)
}

/**
 * 从模型输出里抠出第一个 JSON 对象。容忍 ```json 围栏与前后废话；
 * 抠不出来返回 null —— 调用方必须把 null 当成「不说」，绝不猜。
 */
export function extractJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try { return JSON.parse(slice) } catch { /* 宽容重试 */ }
        // 模型常把提示词里的 // 注释也抄回来，或留下尾逗号——两者都不是合法 JSON。
        const cleaned = slice.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
        try { return JSON.parse(cleaned) } catch { return null }
      }
    }
  }
  return null
}

/** 极简 argv 切分：支持双引号与单引号，不经过 shell。 */
export function splitCommand(line) {
  const out = []
  let cur = ''
  let quote = null
  let has = false
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

/** 一个带上限的环形数组。 */
export class Ring {
  constructor(limit) { this.limit = limit; this.items = [] }
  push(item) {
    this.items.push(item)
    while (this.items.length > this.limit) this.items.shift()
    return item
  }
  last(n = 1) { return n === 1 ? this.items[this.items.length - 1] : this.items.slice(-n) }
  clear() { this.items.length = 0 }
  get size() { return this.items.length }
}
