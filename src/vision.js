/**
 * 视觉调用的统一封装（5.5）。
 *
 *   截屏 JPEG（内存）
 *   -> ctx.attachments.saveImage 存成 ImageAttachmentRef（不许塞裸 base64）
 *   -> messages: [{ role:'user', content:[{type:'text'}, {type:'image', attachment}] }]
 *   -> ctx.llm.stream({ provider, model, system, messages, maxTokens, signal })
 *
 * 三条纪律：
 *  1. 先查 inputModalities；不含 image 就不发请求，直接报错（设置页同样显示）。
 *  2. 图只进 user 消息，绝不进 system。
 *  3. 帧不落盘；附件服务内部怎么存由宿主决定，我们不额外写文件。
 *
 * 自动探测（visionModel 留空时）：遍历宿主 provider，**每个 provider 各取一个**能看图的
 * 模型当候选，按顺序试；认证类失败就换下一条，并记住成功的那条。
 *
 * 为什么不能「取第一个就锁死」：provider 顺序由宿主组合决定（本机 llm-deepseek 排在
 * llm-deepseek-account 之前，即 deepseek-official 在 deepseek-account 前面），第一条
 * 路线的凭据可能缺失或失效。锁死会让整块看图能力全废 —— 实测：api key 失效时每次 look
 * 都报「Your api key … is invalid」，而同一时刻 account 路由完全可用。
 */
import { randomUUID } from 'node:crypto'
import { svc } from './compat.js'
import { SideSeatError, errMsg } from './util.js'

/**
 * 这些代码说明「这条路由本身用不了」，自动模式下值得换下一条候选。
 * 配额、限流、网络抖动不在此列：换条路解决不了，直接把错误抛给用户。
 */
const ROUTE_FALLBACK_CODES = new Set([
  'AUTH',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'MODEL_NO_VISION',
  'MODEL_UNSUPPORTED',
  'CLIENT_UPGRADE_REQUIRED',
  'NO_VISION_MODEL',
])

export function parseModelSpec(spec, fallback = 'llm:deepseek-flash') {
  const raw = String(spec || fallback).trim()
  const at = raw.indexOf(':')
  const provider = (at > 0 ? raw.slice(0, at) : 'llm').trim()
  const model = (at > 0 ? raw.slice(at + 1) : raw).trim()
  if (!provider || !model) throw new SideSeatError('BAD_MODEL', `模型要写成 providerId:modelId，现在是「${raw}」`)
  return { provider, model, id: `${provider}:${model}` }
}
function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
  if (Number.isFinite(Number(input))) target.inputTokens += Number(input)
  if (Number.isFinite(Number(output))) target.outputTokens += Number(output)
}

export function createVision(ctx) {
  const stats = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, byKind: {} }
  const modalityCache = new Map()
  /** 自动探测出的候选路由：每个 provider 各一条，顺序即宿主 provider 顺序。 */
  let discovered = null
  /** 上一次真正成功的路由。自动模式下排最前，避免每次调用都先撞一次用不了的路。 */
  let pinned = null

  const llm = () => svc(ctx, 'llm') || ctx.llm || null
  const attachments = () => svc(ctx, 'attachments') || ctx.attachments || null

  /**
   * 自动探测：每个 provider 取第一个声明 inputModalities 含 image 的模型。
   * 真实 provider id 不是固定的（本机是 deepseek-account:deepseek-flash），绝不能硬编码。
   */
  async function discover() {
    if (discovered) return discovered
    const service = llm()
    if (!service || typeof service.listProviders !== 'function') {
      throw new SideSeatError('NO_LLM', '宿主没有可用的 llm 服务，也无法自动探测视觉模型')
    }
    const found = []
    for (const provider of service.listProviders() || []) {
      let models = []
      try { models = await service.listModels(provider.id) } catch { continue }
      const hit = (models || []).find((m) => Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
      if (!hit || !provider?.id || !hit.id) continue
      const id = `${provider.id}:${hit.id}`
      if (found.some((route) => route.id === id)) continue
      found.push({ provider: provider.id, model: hit.id, id })
    }
    if (!found.length) {
      throw new SideSeatError('NO_VISION_MODEL', '没有找到任何声明了 image 输入的模型', '在设置里把「视觉模型」填成 providerId:modelId')
    }
    discovered = found
    return found
  }

  /** 候选路由：显式配置只认那一条（用户写什么就试什么）；自动模式先试上次成功的那条。 */
  async function candidateRoutes(spec) {
    const raw = String(spec || '').trim()
    if (raw) return [parseModelSpec(raw)]
    const routes = await discover()
    if (!pinned) return routes
    return [pinned, ...routes.filter((route) => route.id !== pinned.id)]
  }

  /** 单条路由的视觉能力结论：{ supported: true|false|null, model, reason }；确定的结论才缓存。 */
  async function checkRoute(route) {
    const { provider, model, id } = route
    if (modalityCache.has(id)) return modalityCache.get(id)
    const service = llm()
    let result
    if (!service || typeof service.stream !== 'function') {
      result = { supported: false, model: id, reason: '宿主没有可用的 llm 服务' }
    } else if (typeof service.resolveModelInfo !== 'function') {
      result = { supported: null, model: id, reason: '宿主没有提供 resolveModelInfo，无法预先确认视觉能力' }
    } else {
      try {
        const info = await service.resolveModelInfo(provider, model)
        const mods = info?.inputModalities
        if (!info) result = { supported: false, model: id, reason: `找不到模型 ${id}` }
        else if (!Array.isArray(mods)) result = { supported: null, model: id, reason: '模型信息里没有 inputModalities' }
        else if (mods.includes('image')) result = { supported: true, model: id, reason: '' }
        else result = { supported: false, model: id, reason: `模型 ${id} 的 inputModalities 不含 image：没有视觉能力的模型不能用旁座` }
      } catch (error) {
        result = { supported: null, model: id, reason: `查询模型信息失败：${errMsg(error)}` }
      }
    }
    if (result.supported !== null) modalityCache.set(id, result)
    return result
  }

  /** { supported: true|false|null, model, reason } —— null 表示宿主没说清楚；任一候选能看图即为 true。 */
  async function checkModel(spec) {
    // 路由解析失败不能抛：checkModel 的语义是「能不能看图」的**查询**，
    // 查不出来就是 supported:null，由调用方决定继续还是提示。start() 依赖这一点。
    let routes
    try {
      routes = await candidateRoutes(spec)
    } catch (error) {
      return { supported: null, model: String(spec || '(未配置)'), reason: errMsg(error) }
    }
    let fallback = null
    for (const route of routes) {
      const result = await checkRoute(route)
      if (result.supported === true) return result
      if (!fallback || (fallback.supported === false && result.supported === null)) fallback = result
    }
    return fallback
  }

  function forgetModelCache() {
    modalityCache.clear()
    discovered = null
    pinned = null
  }

  async function imageBlock(bytes, name, mediaType = 'image/jpeg') {
    const service = attachments()
    if (!service) throw new SideSeatError('NO_ATTACHMENTS', '宿主没有 attachments 服务，图片无法交给模型')
    if (typeof service.saveImage === 'function') {
      try {
        const ref = await service.saveImage({ data: new Uint8Array(bytes), mediaType, name })
        if (ref) return { type: 'image', attachment: ref, ref }
      } catch (error) {
        if (typeof service.admitPromptContent !== 'function') {
          throw new SideSeatError('NO_ATTACHMENTS', `图片登记失败：${errMsg(error)}`)
        }
      }
    }
    if (typeof service.admitPromptContent === 'function') {
      const blocks = await service.admitPromptContent([{ type: 'image', data: Buffer.from(bytes).toString('base64'), mediaType, name }])
      const block = Array.isArray(blocks) ? blocks[0] : blocks
      if (block?.type === 'image' && block.attachment) return { type: 'image', attachment: block.attachment, ref: block.attachment }
    }
    throw new SideSeatError('NO_ATTACHMENTS', '附件服务没有返回可用的图片引用')
  }

  /** 失败信息里补上路由 id：否则用户只看到「密钥无效」，不知道是哪条路线。 */
  function withRoute(error, route) {
    if (error instanceof SideSeatError) {
      if (String(error.message).includes(route.id)) return error
      return new SideSeatError(error.code, `${error.message}（路由 ${route.id}）`, error.hint)
    }
    const code = String(error?.code || 'MODEL_ERROR')
    return new SideSeatError(code, `模型报错（${route.id}）：${errMsg(error)}`)
  }

  /** 在一条路由上跑一次请求。失败时抛出的错误一定带着路由 id。 */
  async function askOnce(route, { system, messages, maxTokens, temperature, signal, kind }) {
    const service = llm()
    const usage = { inputTokens: 0, outputTokens: 0 }
    let out = ''
    let failure = null
    stats.calls++
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1
    try {
      const stream = service.stream({ provider: route.provider, model: route.model, system, messages, maxTokens, temperature, ...(signal ? { signal } : {}) })
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.usage) addUsage(usage, chunk.usage)
        if (chunk.type === 'text-delta') out += chunk.text || ''
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          failure = chunk.reason.failure || { code: 'MODEL_ERROR', message: 'unknown' }
        }
      }
    } catch (error) {
      stats.failures++
      throw withRoute(error, route)
    }
    stats.inputTokens += usage.inputTokens
    stats.outputTokens += usage.outputTokens
    if (failure) {
      stats.failures++
      throw new SideSeatError(
        String(failure.code || 'MODEL_ERROR'),
        `模型报错（${route.id}）：${failure.message || failure.code || '未知错误'}`,
      )
    }
    if (signal?.aborted) throw new SideSeatError('ABORTED', '已取消')
    return { text: out, usage }
  }

  /**
   * 一次模型请求。images: [{ bytes, name, mediaType? }]。图在文字之后、都在 user 消息里。
   * kind 只用于统计（light / heavy / look / caption / review）。
   *
   * 自动探测模式下按候选顺序尝试：能力不符或认证失败就换下一条，成功后记住它。
   * 显式写了 providerId:modelId 时不换路 —— 用户指定了就忠实报错，别偷偷用别的模型。
   */
  async function ask({ model: spec, system = '', text = '', images = [], maxTokens = 600, temperature = 0.4, signal, kind = 'other' }) {
    const routes = await candidateRoutes(spec)
    const service = llm()
    if (!service || typeof service.stream !== 'function') throw new SideSeatError('NO_LLM', '宿主没有可用的 llm 服务')
    if (signal?.aborted) throw new SideSeatError('ABORTED', '已取消')

    // 图片只登记一次：回退换路由不能重复写附件
    const content = [{ type: 'text', text }]
    for (const image of images) {
      const block = await imageBlock(image.bytes, image.name || `side-seat-${Date.now()}.jpg`, image.mediaType || 'image/jpeg')
      content.push({ type: 'image', attachment: block.attachment })
    }
    const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'user' } }]

    const explicit = Boolean(String(spec || '').trim())
    let last = null
    for (const route of routes) {
      if (signal?.aborted) throw new SideSeatError('ABORTED', '已取消')
      if (images.length) {
        const check = await checkRoute(route)
        if (check.supported === false) {
          last = new SideSeatError('MODEL_NO_VISION', check.reason, '在设置里换一个 inputModalities 含 image 的模型')
          if (explicit) throw last
          continue
        }
      }
      try {
        const out = await askOnce(route, { system, messages, maxTokens, temperature, signal, kind })
        pinned = route
        return out
      } catch (error) {
        last = error
        if (explicit || !ROUTE_FALLBACK_CODES.has(String(error?.code || ''))) throw error
      }
    }
    throw last || new SideSeatError('NO_VISION_MODEL', '没有可用的视觉路由', '在设置里把「视觉模型」填成 providerId:modelId')
  }

  /** 目标宽度：宿主给了 imageRequestTarget 就听它的，宁小不大（坑 4）。 */
  function targetWidth(spec, preferred) {
    try {
      const service = llm()
      if (typeof service?.imageRequestTarget === 'function') {
        const raw = String(spec || '').trim()
        const route = raw ? parseModelSpec(raw) : (pinned || (discovered && discovered[0]))
        if (!route) return preferred
        const target = service.imageRequestTarget(route.provider, route.model)
        const w = Number(target?.width || target?.maxWidth)
        if (Number.isFinite(w) && w > 0) return Math.min(preferred, w)
      }
    } catch { /* fall through */ }
    return preferred
  }

  /** 诊断用：当前会走哪条路由（成功过的那条优先，否则自动探测的第一条）。 */
  function lastRoute() {
    const route = pinned || (discovered && discovered[0])
    return route ? route.id : null
  }

  return { ask, checkModel, forgetModelCache, targetWidth, lastRoute, stats }
}
