/**
 * 旁座自己的会话（5.1 / 5.8 / 契约 #11 #12）。
 *
 *  - 只在用户点了侧边栏入口后才创建 / 复用自己的会话；从不劫持当前会话。
 *  - 用 ctx.agents.create({ sessionId, meta: { agentPreset: 'side-seat' }, setup }) 创建；
 *    setup 里在 **这个 agent 的作用域** 注册人格段，其它会话不受影响。
 *  - 不改会话的 provider / model。
 *  - 监听本会话的用户消息：打断朗读、识别「安静看」等口令。
 */
import { randomUUID } from 'node:crypto'
import { svc } from './compat.js'
import { SideSeatError, appendLog, errMsg, log } from './util.js'

export const AGENT_PRESET = 'side-seat'

/**
 * 取一个可用的模型选择。
 *
 * 不给模型的话，这个会话任何一轮都会失败：
 *   has no provider/model: set AgentOptions.provider and AgentOptions.model
 * 所以创建和恢复都必须带上。
 *
 * 优先用「当前任何活着的会话正在用的模型」——那正是用户此刻在用的那个；
 * 拿不到再退回 llm 服务里第一个可用模型。
 */
function pickModel(agentsService) {
  try {
    for (const agent of agentsService?.list?.() ?? []) {
      const session = agent?.session
      if (!session) continue
      const ctxInfo = typeof session.requestContext === 'function' ? session.requestContext() : null
      if (ctxInfo?.provider && ctxInfo?.model) return { provider: ctxInfo.provider, model: ctxInfo.model }
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : null
      if (header?.config?.provider && header?.config?.model) {
        return { provider: header.config.provider, model: header.config.model }
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 取一个可用的工作目录：优先复用当前任何活着的会话的 cwd。
 * 会话不带 cwd 时，界面会要求用户先选工作区——旁座会话不该问这个。
 */
function pickCwd(agentsService) {
  try {
    for (const agent of agentsService?.list?.() ?? []) {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch { /* ignore */ }
  return undefined
}

function textOf(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  if (content.content) return textOf(content.content)
  return ''
}

export function createSessions(ctx, { memory, personaFor, onUserMessage, onOpened, onAssistant }) {
  let sessionId = null
  let handle = null
  let personaMode = 'untested'
  let lastError = ''

  const agents = () => svc(ctx, 'agents')

  function registerPersona(agentCtx) {
    const sp = agentCtx?.systemPrompt || svc(agentCtx, 'systemPrompt')
    if (!sp || typeof sp.section !== 'function') { personaMode = 'unavailable'; return }
    const render = () => personaFor()
    // 真实契约：PromptSection = { name, order, text }，text 可以是字符串或 (context) => string。
    // 没有 render / content 字段 —— 早先三种写法都传不对，人格段注不进去。
    const attempts = [
      () => sp.section({ name: 'side-seat/persona', order: 950, text: render, interpolate: false }),
      () => sp.section('side-seat/persona', 950, render),
    ]
    for (const attempt of attempts) {
      try {
        const disposer = attempt()
        personaMode = 'section'
        if (typeof disposer === 'function' && typeof agentCtx.effect === 'function') {
          try { agentCtx.effect(() => disposer) } catch { /* the section is already an effect */ }
        }
        return
      } catch (error) {
        lastError = errMsg(error)
      }
    }
    personaMode = 'failed'
  }

  function normalize(h) {
    if (!h) return null
    const agent = h.agent || h
    const session = h.session || agent.session || null
    return { raw: h, agent, session }
  }

  async function tryResume(a, id, model) {
    try {
      const live = typeof a.get === 'function' ? a.get(id) : null
      if (live) return live
    } catch { /* fall through */ }
    if (typeof a.resume !== 'function') return null
    // 真实契约：ResumeAgentOptions = { resumeSessionId, agentOptions?, signal?, setup? }
    // （早先写成 sessionId，字段名不对，resume 每次都失败 → 会话越堆越多）
    for (const call of [
      () => a.resume({ resumeSessionId: id, ...(model ? { agentOptions: model } : {}), setup: registerPersona }),
      () => a.resume(id, { setup: registerPersona }),
    ]) {
      try {
        const h = await call()
        if (h) { appendLog('session.log', `resume ok ${id}`); return h }
      } catch (error) {
        lastError = errMsg(error)
        appendLog('session.log', `resume failed ${id}: ${lastError}`)
      }
    }
    appendLog('session.log', `resume gave up ${id}`)
    return null
  }

  /** 打开（或新建）旁座会话。只在用户点击入口时调用。 */
  async function open() {
    const a = agents()
    if (!a || typeof a.create !== 'function') {
      throw new SideSeatError('NO_AGENTS', '宿主没有 agents 服务，无法创建旁座会话', '请按 docs/DETAIL.md 的 M0 清单核对 ctx.agents 的签名')
    }
    const model = await resolveAgentModel(a)
    if (!model) appendLog('session.log', 'no model resolved — session turns will fail')
    if (handle && sessionId) {
      await ensureAttached(sessionId)
      await notifyOpened(false)
      return { sessionId, reused: true }
    }
    const saved = memory.meta('sessionId')
    if (saved) {
      const h = await tryResume(a, saved, model)
      if (h) {
        handle = normalize(h)
        sessionId = saved
        await ensureAttached(sessionId)
        await notifyOpened(false)
        return { sessionId, reused: true }
      }
    }
    const id = randomUUID()
    // 不指定 agentPreset：走宿主默认 composition，会话开箱可用。
    // 自定义 preset 需要完整的 plugins 声明，缺了就会得到一个「有壳没引擎」的会话。
    // 带上 cwd：否则界面会先要求用户选工作区，旁座会话不该问这个。
    const cwd = pickCwd(a)
    const h = await a.create({
      sessionId: id,
      ...(cwd ? { meta: { cwd } } : {}),
      ...(model ? { agentOptions: model } : {}),
      setup: registerPersona,
    })
    appendLog('session.log', `created ${id} cwd=${cwd || '(none)'} model=${model ? `${model.provider}:${model.model}` : '(none)'}`)
    handle = normalize(h)
    sessionId = id
    await memory.setMeta('sessionId', id)
    log(`旁座会话：${id}`)
    await ensureAttached(id)
    await notifyOpened(true)
    return { sessionId, reused: false }
  }

  function watch() {
    try {
      const seen = new Set()
      ctx.on('session/event', (session, event) => {
        try {
          const sid = session?.id ?? session?.sessionId ?? session
          if (!sessionId || String(sid) !== String(sessionId)) return
          const type = String(event?.type || '')
          // 诊断：把本会话出现过的事件类型各记一次，弹窗镜像不生效时靠它定位
          if (type && !seen.has(type)) {
            seen.add(type)
            if (seen.size <= 24) appendLog('session.log', `evt ${type}`)
          }
          const data = event?.data || {}
          // 旁座在会话里说的话，镜像到桌面弹窗 —— 用户在弹窗里回话后，回复也是这条路径。
          if (type === 'assistant/message') {
            const said = textOf(data.message?.content || data.content)
            if (said) { try { onAssistant?.(said) } catch { /* ignore */ } }
            return
          }
          const isUser = type === 'user/message' || type === 'user/prompt'
            || (type.endsWith('/message') && (data.role === 'user' || data.message?.role === 'user') && (data.source?.kind || data.message?.source?.kind) === 'user')
          if (!isUser) return
          const text = textOf(data.content || data.message?.content || data)
          if (text && !text.startsWith('【旁座内部提示')) onUserMessage(text)
        } catch { /* never break the host event loop */ }
      })
    } catch (error) {
      log(`无法监听会话事件：${errMsg(error)}`)
    }
  }

  /**
   * 把会话挂进工作区。只设 meta.cwd 不够：界面仍会要求「选择一个工作区开始」。
   * 真实契约：ctx.workspaceRegistry.resolveByPath(path) / list()，Workspace.attachSession(id)。
   */
  async function attachWorkspace(cwd, id) {
    if (!cwd) { appendLog('session.log', `attach skipped ${id}: no cwd`); return }
    try {
      const registry = svc(ctx, 'workspaceRegistry')
      if (!registry) { appendLog('session.log', `attach skipped ${id}: no workspaceRegistry`); return }
      let ws = null
      try { ws = await registry.resolveByPath?.(cwd) } catch { ws = null }
      if (!ws) ws = (registry.list?.() ?? []).find((w) => w.path === cwd) || null
      if (ws && typeof ws.attachSession === 'function') {
        await ws.attachSession(id)
        appendLog('session.log', `attached ${id} -> workspace ${ws.id}`)
      } else {
        appendLog('session.log', `attach ${id}: no workspace owns ${cwd}`)
      }
    } catch (error) {
      appendLog('session.log', `attach failed ${id}: ${errMsg(error)}`)
    }
  }

  /** 模型选择：先看活着的会话，再退回 llm 服务里的第一个模型。 */
  async function resolveAgentModel(a) {
    const direct = pickModel(a)
    if (direct) return direct
    try {
      const service = svc(ctx, 'llm')
      if (!service || typeof service.listProviders !== 'function') return null
      for (const provider of service.listProviders() || []) {
        try {
          const models = await service.listModels(provider.id)
          const list = models || []
          const hit = list.find((m) => Array.isArray(m.inputModalities) && m.inputModalities.includes('image')) || list[0]
          if (hit) return { provider: provider.id, model: hit.id }
        } catch { /* next provider */ }
      }
    } catch { /* ignore */ }
    return null
  }

  /** 丢掉当前会话（被楔住时用）：下次 open() 会新建一个。 */
  async function reset() {
    try { await dispose() } catch { /* ignore */ }
    handle = null
    sessionId = null
    try { await memory.setMeta('sessionId', null) } catch { /* ignore */ }
    appendLog('session.log', 'reset: 会话已丢弃，下次将新建')
  }

  /** 会话被打开（新建或复用）时确保它挂在工作区里；失败不影响会话本身。 */
  async function ensureAttached(id) {
    let cwd = null
    try { cwd = handle?.session?.header?.cwd || pickCwd(agents()) || null } catch { /* ignore */ }
    await attachWorkspace(cwd, id)
  }

  /** 会话被打开（新建或复用）时通知上层；失败不影响会话本身。 */
  async function notifyOpened(isNew) {
    try { await onOpened?.({ sessionId, isNew, session: handle?.session }) } catch { /* ignore */ }
  }

  async function dispose() {
    const h = handle
    handle = null
    if (h?.raw && typeof h.raw.dispose === 'function') {
      try { await h.raw.dispose() } catch { /* ignore */ }
    }
  }

  return {
    open,
    watch,
    dispose,
    reset,
    get sessionId() { return sessionId },
    get agent() { return handle?.agent || null },
    get session() { return handle?.session || null },
    /** 真实契约：ctx.agents.turnBoundaryOf(session) → { lastTurn, ... }。写事件时要它。 */
    turnBoundary(session) {
      try { return agents()?.turnBoundaryOf?.(session) ?? null } catch { return null }
    },
    get personaMode() { return personaMode },
    get lastError() { return lastError },
  }
}
