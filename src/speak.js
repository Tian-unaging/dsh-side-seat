/**
 * 主动发言（5.8）：三条路径，按序降级，当前用的是哪条写进状态与 README。
 *
 *   路径一  append：旁座自己生成那句话，直接往自己的会话 append 一条
 *           assistant/message（surfaceOp: 'append'）。不依赖 agent loop 被唤醒。
 *   路径二  followup：往会话里 followup 一条带「内部提示」标记的 user 消息，
 *           让 agent loop 自然跑一轮。语义更真，但会在历史里留下一条用户没说过的话。
 *   兜底    overlay：客户端在会话里显示「旁座此刻在想：…」的浮层卡片，点一下进入对话。
 *
 * 无论走哪条，朗读都在浏览器端做（Web Speech），由状态里的 lastLine 驱动。
 * 设置项 speakPath 可在现场核实后锁定某一条（docs/DETAIL.md 的 M0 清单）。
 */
import { randomUUID } from 'node:crypto'
import { appendLog, errMsg, sleep } from './util.js'

let llmHelpers = null
async function helpers() {
  if (llmHelpers) return llmHelpers
  try { llmHelpers = await import('@deepseek-ai/dsh-llm') } catch { llmHelpers = {} }
  return llmHelpers
}

const textBlock = (line) => [{ type: 'text', text: line }]

/**
 * 造一条合法的 AssistantMessage。
 * 真实契约（dsh-llm / dsh-session）：AssistantMessage.source 必须是
 * { kind:'model', provider, model } —— 早先写的是 { kind:'assistant' }，宿主会拒。
 */
async function assistantMessage(line, model) {
  const h = await helpers()
  const [provider, id] = String(model || '').split(':')
  const source = { kind: 'model', provider: provider || 'side-seat', model: id || 'side-seat' }
  const fn = h.createAssistantMessage
  if (typeof fn === 'function') {
    for (const attempt of [() => fn(textBlock(line), source), () => fn({ content: textBlock(line), source })]) {
      try {
        const v = attempt()
        if (v && v.role === 'assistant') return v
      } catch { /* 下一种写法 */ }
    }
  }
  return { id: randomUUID(), role: 'assistant', content: textBlock(line), source }
}

/**
 * 造 assistant/message 的事件数据。
 * 真实 SessionEventMap['assistant/message'] = { turn, step, message, stream }
 * 真实 AssistantStreamRecord = { type:'text-chunks', time0, index, dt[], texts[] }
 * 早先写的是 { id, role, stream:[text-start…], content } —— 四个字段全不对。
 */
async function assistantEvent(line, session, turnBoundary, model) {
  const message = await assistantMessage(line, model)
  let turn = 0
  try {
    const tb = turnBoundary?.(session)
    if (Number.isFinite(tb?.lastTurn)) turn = tb.lastTurn
  } catch { /* 保持 0 */ }
  const now = Date.now()
  return {
    turn,
    step: 1,
    message,
    stream: [{ type: 'text-chunks', time0: now, index: 0, dt: [0], texts: [line] }],
  }
}

async function userMessage(text) {
  const h = await helpers()
  if (typeof h.createUserMessage === 'function') {
    try { return h.createUserMessage({ content: textBlock(text), source: { kind: 'user' } }) } catch { /* literal */ }
  }
  return { role: 'user', id: randomUUID(), content: textBlock(text), source: { kind: 'user' } }
}

export function createSpeaker({ sessions, getCfg, onLine }) {
  const pathStatus = { append: '未测试', followup: '未测试', overlay: '可用' }
  let lastPath = null
  let pending = null // 兜底路径的「旁座此刻在想」

  const paths = {
    async append(line) {
      const session = sessions.session
      if (!session || typeof session.append !== 'function') throw new Error('会话句柄上没有 append')
      const data = await assistantEvent(line, session, sessions.turnBoundary, getCfg().visionModel)
      session.append('assistant/message', data, { surfaceOp: 'append' })
    },
    async followup(line) {
      const agent = sessions.agent
      if (!agent || typeof agent.followup !== 'function') throw new Error('agent 句柄上没有 followup')
      const text = `【旁座内部提示：这条不是用户说的】你刚刚自己决定对用户说一句话。只原样输出这一句，不要加别的：${line}`
      await agent.followup(await userMessage(text))
    },
    async overlay(line) {
      pending = { id: randomUUID(), line, t: Date.now() }
    },
  }

  async function say(line) {
    const cfg = getCfg()
    // 'append' 已验证会写出「没有对应 turn/step」的 assistant/message，导致会话日志 corrupt。
    // 所以 auto 不再包含它；只有显式配置 append 才会尝试（排障用）。
    const order = cfg.speakPath === 'auto'
      ? ['followup', 'overlay']
      : [cfg.speakPath, 'overlay']
    const needsSession = (p) => p !== 'overlay' && !sessions.sessionId
    for (const p of order) {
      if (needsSession(p)) { pathStatus[p] = '旁座会话还没打开'; continue }
      try {
        await paths[p](line)
        pathStatus[p] = '可用'
        lastPath = p
        try { onLine?.(line) } catch { /* 推送失败不影响已经说出的话 */ }
        return { path: p }
      } catch (error) {
        pathStatus[p] = `失败：${errMsg(error)}`
      }
    }
    lastPath = 'overlay'
    await paths.overlay(line)
    try { onLine?.(line) } catch { /* ignore */ }
    return { path: 'overlay' }
  }

  /**
   * 用户在桌面弹窗里回的一句：作为一条真实的用户消息送进旁座会话。
   * 走 agent.followup —— 这是宿主提供的正规入队入口（DSH 自己的定时任务也是这么投递的）。
   */
  async function sayAsUser(text) {
    const body = String(text || '').trim()
    if (!body) return false
    // 用户可能还没打开旁座会话就在弹窗里回话：先把会话开起来，否则消息无处可投。
    if (!sessions.agent || typeof sessions.agent.followup !== 'function') {
      try {
        await sessions.open()
      } catch (error) {
        pathStatus.followup = `打开会话失败：${errMsg(error)}`
        return false
      }
    }
    const agent = sessions.agent
    if (!agent || typeof agent.followup !== 'function') {
      pathStatus.followup = '旁座会话还没打开'
      return false
    }
    try {
      const before = Number(sessions.session?.seq)
      await agent.followup(await userMessage(body))
      if (!Number.isFinite(before)) return true
      // 投递后确认真的开了一轮。卡死的会话只排队、永不运行（只发 agent/inbox/spliced）。
      for (let i = 0; i < 10; i++) {
        await sleep(500)
        const now = Number(sessions.session?.seq)
        if (Number.isFinite(now) && now > before) return true
      }
      // 判定卡死：丢掉这个会话，新建一个，再投一次
      pathStatus.followup = '会话没有响应，已重建'
      await sessions.reset()
      await sessions.open()
      const fresh = sessions.agent
      if (!fresh || typeof fresh.followup !== 'function') return false
      await fresh.followup(await userMessage(body))
      appendLog('session.log', 'sayAsUser: 会话卡死 → 已重建并重投')
      return true
    } catch (error) {
      pathStatus.followup = `投放失败：${errMsg(error)}`
      return false
    }
  }

  return {
    say,
    sayAsUser,
    get lastPath() { return lastPath },
    get pathStatus() { return { ...pathStatus } },
    get pending() { return pending },
    clearPending(id) { if (!id || pending?.id === id) pending = null },
  }
}
