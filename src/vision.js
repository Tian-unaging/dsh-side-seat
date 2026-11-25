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
 */
import { randomUUID } from 'node:crypto'
import { svc } from './compat.js'
import { SideSeatError, errMsg } from './util.js'

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

  const llm = () => svc(ctx, 'llm') || ctx.llm || null
  const attachments = () => svc(ctx, 'attachments') || ctx.attachments || null
  let autoRoute = null

  /**
   * 解析视觉路由。spec 留空时自动探测：宿主上第一个声明 inputModalities 含 image 的模型。
   *
   * 为什么必须自动探测：真实 provider id 不是固定的（本机是 deepseek-account:deepseek-flash）。
   * 早先硬编码 'llm:deepseek-flash'，每次调用都得到
   * no adapter registered for provider "llm" —— 默认值直接把功能打死。
   */
  async function resolveRoute(spec) {
    const raw = String(spec || '').trim()
    if (raw) return parseModelSpec(raw)
    if (autoRoute) return autoRoute
    const service = llm()
    if (!service || typeof service.listProviders !== 'function') {
      throw new SideSeatError('NO_LLM', '宿主没有可用的 llm 服务，也无法自动探测视觉模型')
    }
    for (const provider of service.listProviders() || []) {
      let models = []
      try { models = await service.listModels(provider.id) } catch { continue }
      const hit = (models || []).find((m) => Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
      if (hit) {
        autoRoute = { provider: provider.id, model: hit.id, id: `${provider.id}:${hit.id}` }
        return autoRoute
      }
    }
    throw new SideSeatError('NO_VISION_MODEL', '没有找到任何声明了 image 输入的模型', '在设置里把「视觉模型」填成 providerId:modelId')
  }

  /** { supported: true|false|null, reason } —— null 表示宿主没说清楚。 */
  async function checkModel(spec) {
    // 路由解析失败不能抛：checkModel 的语义是「能不能看图」的**查询**，
    // 查不出来就是 supported:null，由调用方决定继续还是提示。start() 依赖这一点。
    let route
    try {
      route = await resolveRoute(spec)
    } catch (error) {
      return { supported: null, model: String(spec || '(未配置)'), reason: errMsg(error) }
    }
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
    // 只缓存确定的结论
    if (result.supported !== null) modalityCache.set(id, result)
    return result
  }

  function forgetModelCache() { modalityCache.clear() }

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

  /**
   * 一次模型请求。images: [{ bytes, name, mediaType? }]。图在文字之后、都在 user 消息里。
   * kind 只用于统计（light / heavy / look / caption / review）。
   */
  async function ask({ model: spec, system = '', text = '', images = [], maxTokens = 600, temperature = 0.4, signal, kind = 'other' }) {
    const { provider, model } = await resolveRoute(spec)
    const service = llm()
    if (!service || typeof service.stream !== 'function') throw new SideSeatError('NO_LLM', '宿主没有可用的 llm 服务')
    if (images.length) {
      const check = await checkModel(spec)
      if (check.supported === false) throw new SideSeatError('MODEL_NO_VISION', check.reason, '在设置里换一个 inputModalities 含 image 的模型')
    }
    if (signal?.aborted) throw new SideSeatError('ABORTED', '已取消')
    const content = [{ type: 'text', text }]
    for (const image of images) {
      const block = await imageBlock(image.bytes, image.name || `side-seat-${Date.now()}.jpg`, image.mediaType || 'image/jpeg')
      content.push({ type: 'image', attachment: block.attachment })
    }
    const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'user' } }]
    const usage = { inputTokens: 0, outputTokens: 0 }
    let out = ''
    let failure = null
    stats.calls++
    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1
    try {
      const stream = service.stream({ provider, model, system, messages, maxTokens, temperature, ...(signal ? { signal } : {}) })
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.usage) addUsage(usage, chunk.usage)
        if (chunk.type === 'text-delta') out += chunk.text || ''
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure || { message: 'unknown' }
      }
    } catch (error) {
      stats.failures++
      throw error
    }
    stats.inputTokens += usage.inputTokens
    stats.outputTokens += usage.outputTokens
    if (failure) {
      stats.failures++
      throw new SideSeatError(failure.code || 'MODEL_ERROR', `模型报错：${failure.message || failure.code || '未知错误'}`)
    }
    if (signal?.aborted) throw new SideSeatError('ABORTED', '已取消')
    return { text: out, usage }
  }

  /** 目标宽度：宿主给了 imageRequestTarget 就听它的，宁小不大（坑 4）。 */
  function targetWidth(spec, preferred) {
    try {
      const service = llm()
      if (typeof service?.imageRequestTarget === 'function') {
        const route = String(spec || '').trim() ? parseModelSpec(spec) : autoRoute
        if (!route) return preferred
        const target = service.imageRequestTarget(route.provider, route.model)
        const w = Number(target?.width || target?.maxWidth)
        if (Number.isFinite(w) && w > 0) return Math.min(preferred, w)
      }
    } catch { /* fall through */ }
    return preferred
  }

  return { ask, checkModel, forgetModelCache, targetWidth, stats }
}
