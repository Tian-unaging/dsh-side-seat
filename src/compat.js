/**
 * 兼容性：平台、Harness 版本、可选服务的探测。
 *
 * 原则（坑 9）：版本不匹配给可读提示，不崩；服务缺失走降级，不崩。
 * 所有可选服务都用 ctx.get(name) 读取 —— 不是属性读取：未 inject 的可选服务
 * 用属性读会拿到 undefined。
 */
import { createRequire } from 'node:module'

export const SUPPORTED_RANGE = Object.freeze({ min: '0.2.2-rc.5', maxExclusive: '0.3.0' })
export const SUPPORTED_TEXT = `>=${SUPPORTED_RANGE.min} <${SUPPORTED_RANGE.maxExclusive}`

const require = createRequire(import.meta.url)

/** 读可选服务；拿不到返回 null。 */
export function svc(ctx, name) {
  try {
    const value = ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    return value ?? null
  } catch {
    return null
  }
}

export function isWindows() {
  return process.platform === 'win32'
}

export function platformStatus() {
  if (isWindows()) return { ok: true, reason: '' }
  return {
    ok: false,
    reason: `第一版只支持 Windows + DSH Desktop，当前系统是 ${process.platform}，实时陪看（A 轴）已禁用；工作区工具仍可用。`,
  }
}

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** semver 比较（含预发布段）。 */
export function compareVersions(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return NaN
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  const n = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < n; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** 尽力读出宿主版本：工具包版本与 Harness 发行版本同号。 */
export function detectHarnessVersion() {
  if (process.env.DSH_VERSION) return process.env.DSH_VERSION
  const candidates = [
    '@deepseek-ai/dsh-tools/package.json',
    '@deepseek-ai/dsh/package.json',
    '@deepseek-ai/dsh-tools',
  ]
  for (const id of candidates) {
    try {
      if (id.endsWith('package.json')) {
        const pkg = require(id)
        if (pkg && pkg.version) return pkg.version
      } else {
        const entry = require.resolve(id)
        const idx = entry.lastIndexOf('dsh-tools')
        if (idx > 0) {
          const pkg = require(`${entry.slice(0, idx)}dsh-tools/package.json`)
          if (pkg && pkg.version) return pkg.version
        }
      }
    } catch { /* not resolvable from here */ }
  }
  return null
}

export function versionStatus() {
  const version = detectHarnessVersion()
  if (!version) {
    return { version: null, ok: null, message: `无法确认 DeepSeek Harness 版本；本插件按 ${SUPPORTED_TEXT} 开发与核对。` }
  }
  const low = compareVersions(version, SUPPORTED_RANGE.min)
  const high = compareVersions(version, SUPPORTED_RANGE.maxExclusive)
  if (Number.isNaN(low) || Number.isNaN(high)) {
    return { version, ok: null, message: `无法解析 Harness 版本 ${version}；支持范围 ${SUPPORTED_TEXT}。` }
  }
  if (low >= 0 && high < 0) return { version, ok: true, message: `Harness ${version}（支持范围 ${SUPPORTED_TEXT}）` }
  return {
    version,
    ok: false,
    message: `Harness ${version} 不在旁座声明支持的范围 ${SUPPORTED_TEXT} 内。插件会尽量运行，但请先按 docs/DETAIL.md 的 M0 清单逐条复核。`,
  }
}
