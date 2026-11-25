/**
 * Host <-> Client 通路。
 *
 * 独立安装包不能指望 ctx.remote.<namespace> 自动出现（Typert Remote 的 Client 贡献
 * 由 Harness 构建期静态挑选）。因此旁座在 host 的 WebServer 上注册自己的
 * **精确路由** /api/side-seat/<endpoint>（比官方 /api 前缀更长 / 更精确，优先匹配），
 * 并把信任判断委托给 Connection 的 requestRejection —— 与 /api 用的是同一道围栏。
 * 拿不到 Connection 时退回本插件自己的窄规则：只认回环 Host + 自定义请求头
 * x-side-seat: 1（跨站简单请求带不了自定义头）。
 *
 * 这是 5.1「待核实」项之一：现场请按 docs/DETAIL.md 的 M0 清单确认路由注册签名。
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { svc } from './compat.js'
import { API_PREFIX, dataDir, errMsg, log } from './util.js'

const MAX_BODY = 8 * 1024 * 1024
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d+)?$/i
const LOG_MAX = 128 * 1024

/** 桥接日志：客户端点一下有没有把请求发过来，只有这里能看清。 */
export function recordBridge(line) {
  try {
    const file = join(dataDir(), 'bridge.log')
    try { if (statSync(file).size > LOG_MAX) writeFileSync(file, '') } catch { /* 首次 */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志失败不能影响请求 */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy?.() ; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(payload))
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

async function trust(ctx, req, peer) {
  const conn = svc(ctx, 'connection')
  if (conn && typeof conn.requestRejection === 'function') {
    try {
      const rejection = await conn.requestRejection(req)
      return rejection ? { ok: false, reason: rejection.reason || 'host-fence' } : { ok: true }
    } catch (error) {
      return { ok: false, reason: `trust-check-failed: ${errMsg(error)}` }
    }
  }
  if (peer) return { ok: true }
  const host = String(req.headers.host || '')
  if (!LOOPBACK.test(host)) return { ok: false, reason: 'non-loopback-host' }
  if (req.headers['x-side-seat'] !== '1') return { ok: false, reason: 'missing-header' }
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    try { if (new URL(origin).host !== host) return { ok: false, reason: 'cross-origin' } } catch { return { ok: false, reason: 'bad-origin' } }
  }
  return { ok: true }
}

/**
 * routes: { 'GET state': async ({ query }) => obj, 'POST observe': async ({ json }) => obj, ... }
 * 返回 { mode, endpoints, reason }，写进诊断。
 */
export function createBridge(ctx, routes) {
  const status = { mode: 'none', endpoints: 0, reason: '' }
  const byPath = new Map()
  for (const [key, fn] of Object.entries(routes)) {
    const [method, path] = key.split(' ')
    if (!byPath.has(path)) byPath.set(path, new Map())
    byPath.get(path).set(method, fn)
  }

  const handlerFor = (path) => async (req, res, peer) => {
    const t0 = Date.now()
    recordBridge(`→ ${req.method} ${path}`)
    try {
      const verdict = await trust(ctx, req, peer)
      if (!verdict.ok) {
        recordBridge(`✗ ${req.method} ${path} 403 ${verdict.reason}`)
        send(res, 403, { ok: false, error: 'forbidden', reason: verdict.reason })
        return
      }
      const methods = byPath.get(path)
      const fn = methods.get(req.method)
      if (!fn) { res.setHeader('Allow', [...methods.keys()].join(', ')); send(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      const url = new URL(req.url || '/', 'http://side-seat.local')
      let body = null
      let json = null
      if (req.method === 'POST') {
        body = await readBody(req)
        const type = String(req.headers['content-type'] || '')
        if (type.includes('application/json') && body.length) {
          try { json = JSON.parse(body.toString('utf8')) } catch { send(res, 400, { ok: false, error: 'bad-json' }); return }
        }
      }
      const out = await fn({ query: Object.fromEntries(url.searchParams), json: json || {}, body, req })
      recordBridge(`✓ ${req.method} ${path} 200 ${Date.now() - t0}ms`)
      send(res, 200, { ok: true, ...(out && typeof out === 'object' ? out : { value: out }) })
    } catch (error) {
      recordBridge(`✗ ${req.method} ${path} 500 ${errMsg(error)}`)
      send(res, 500, { ok: false, error: errMsg(error) })
    }
  }

  // 真实契约（@deepseek-ai/dsh-host-webserver，本机 0.2.2-rc.5 核对）：
  //   WebRoute = { kind: 'exact' | 'prefix', path, handler(req, res) }
  // 早先的三个尝试都漏了 kind，路由注册后永远匹配不上请求（/api/side-seat/* 全 404）。
  // 现在按 kind 显式注册：先 prefix（容忍尾斜杠与子路径），再 exact。
  const attemptsFor = (ws, path, handler) => [
    () => ws.register({ kind: 'prefix', path: `${API_PREFIX}${path}`, handler }),
    () => ws.register({ kind: 'exact', path: `${API_PREFIX}${path}`, handler }),
  ]

  function install(ws) {
    let ok = 0
    let lastError = ''
    for (const path of byPath.keys()) {
      const handler = handlerFor(path)
      let registered = false
      for (const attempt of attemptsFor(ws, path, handler)) {
        try {
          const disposer = attempt()
          if (typeof disposer === 'function') ctx.effect(() => disposer)
          else if (disposer && typeof disposer.dispose === 'function') ctx.effect(() => () => disposer.dispose())
          registered = true
          break
        } catch (error) {
          lastError = errMsg(error)
        }
      }
      if (registered) ok++
    }
    status.endpoints = ok
    status.mode = ok === byPath.size ? 'webserver' : ok ? 'partial' : 'none'
    status.reason = ok === byPath.size ? '' : `只注册上 ${ok}/${byPath.size} 条路由：${lastError}`
    recordBridge(`register mode=${status.mode} endpoints=${ok}/${byPath.size}${status.reason ? ' reason=' + status.reason : ''}`)
    log(`通路：${status.mode}（${ok}/${byPath.size} 条路由）`)
    return status.mode === 'webserver'
  }

  /**
   * 冷启动竞态：插件可能比 webServer 先挂载。拿不到服务就退避重试，
   * 否则路由永远注册不上，浏览器半边所有请求 404 —— 用户看到的就是「旁座无法运行」。
   * 部分注册成功时不再重试，避免重复注册抛 duplicate route。
   */
  const RETRY_MS = [300, 800, 1500, 3000, 6000, 12000]
  let retry = 0
  function tryInstall() {
    const ws = svc(ctx, 'webServer')
    if (ws && typeof ws.register === 'function') {
      const done = install(ws)
      if (done || status.endpoints > 0) return
    }
    if (retry >= RETRY_MS.length) {
      if (!status.reason) status.reason = '宿主始终没有可用的 webServer 服务：浏览器半边无法连到宿主半边'
      recordBridge(`register gave up: ${status.reason}`)
      log(status.reason)
      return
    }
    const delay = RETRY_MS[retry++]
    const timer = setTimeout(tryInstall, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  tryInstall()
  return status
}
