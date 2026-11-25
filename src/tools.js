/**
 * B 轴：工作区里可被调用的视觉工具（5.9）。全部 side_seat_ 前缀；
 * 不与 video_probe / video_storyboard / video_read / video_zoom / video_outline /
 * video_subtitles / video_shots / video_describe / reaction_* 重名。
 *
 * B 轴三条纪律：
 *   1. 永不主动：只有用户开口才动；不读取屏幕，除非本次调用明确 target=screen。
 *   2. 产物可寻址：视频类结果带 [mm:ss] 出处，能点回具体秒数。
 *   3. 不产生音视频：不调 TTS，不合成成片。
 *
 * 返回值契约（坑 1）：execute 返回规范值 { text: string, images: [] }，
 * output.render 把它变成内容块数组；text 永远是字符串，绝不是对象。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pcm16ToWav } from './audio/asr.js'
import { VISION_DISCIPLINE } from './persona.js'
import { SideSeatError, TOOL_PREFIX, dataDir, errMsg, fmtTime, log } from './util.js'
import { runCaption } from './video/caption.js'
import { assertLocalFile, audioPcm, frameAt, kindOf, probeMedia } from './video/index.js'
import { runReview } from './video/review.js'

export const TOOL_NAMES = ['look', 'caption', 'review', 'profile'].map((n) => TOOL_PREFIX + n)

const output = {
  // 真实契约：ToolOutputDefinition.schema 是 JsonSchemaNode，
  // 其 type 只能是 object/array/string/number/integer/boolean/null —— 没有 'json'。
  // 早先写成 { type: 'json' } 会被注册器拒绝，四个工具全部注册失败（且被 reg() 的 catch 吞掉）。
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      images: { type: 'array', items: { type: 'object' } },
    },
    required: ['text'],
    additionalProperties: true,
  },
  render: (_args, value) => {
    const text = typeof value?.text === 'string' ? value.text : String(value?.text ?? '')
    const blocks = [{ type: 'text', text }]
    for (const ref of Array.isArray(value?.images) ? value.images : []) blocks.push({ type: 'image', attachment: ref })
    return blocks
  },
}

const result = (text, images = []) => ({ text: String(text ?? ''), images })

function failText(error) {
  const hint = error?.hint ? `\n建议：${error.hint}` : ''
  return result(`旁座：${errMsg(error)}${hint}`)
}

const LOOK_SYSTEM = [
  '你是旁座，用户叫你来看一眼东西。你只回答这一次的问题，不主动延伸。',
  VISION_DISCIPLINE,
  '回答格式：先一段带定位的描述（说清在画面的哪里：左上 / 中部 / 右下……或时间点），再用一句话给出你的判断。',
].join('\n')

async function fetchBytes(url, signal, limit = 25 * 1024 * 1024) {
  if (!/^https?:\/\//i.test(url)) throw new SideSeatError('BAD_URL', 'url 必须以 http:// 或 https:// 开头')
  const res = await fetch(url, { signal })
  if (!res.ok) throw new SideSeatError('HTTP', `下载失败：${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > limit) throw new SideSeatError('TOO_LARGE', '文件太大')
  return { buf, type: res.headers.get('content-type') || '' }
}

function mediaTypeOf(name, fallback = 'image/jpeg', bytes = null) {
  const ext = extname(String(name).split(/[?#]/)[0]).toLowerCase()
  const known = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext]
  if (known) return known
  // 无扩展名（DSH 附件）时按文件头定类型，别一律当 jpeg
  if (bytes && bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'GIF8') return 'image/gif'
    if (Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF') return 'image/webp'
  }
  return fallback
}

function writeOut(out, text) {
  if (!out) return ''
  const ext = extname(out).toLowerCase()
  if (ext === '.srt' || ext === '.csv') return '\n（.srt / .csv 请用 side_seat_caption 生成；这次没有写文件）'
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text, 'utf8')
  return `\n已写出：${out}`
}

/**
 * 包一层 vision.ask：空文本自动重试一次，仍为空则给出明确说明。
 * 之前空返回会被静默变成空字符串，用户看到的就是「啥也没返回」，
 * 分不清是截图失败、模型拒答，还是请求被截断。
 */
async function askText(vision, params, label = '') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await vision.ask({ ...params, maxTokens: Number(params.maxTokens || 700) + attempt * 300 })
    const text = String(res?.text || '').trim()
    if (text) return text
  }
  return `模型这次没有返回内容${label ? `（${label}）` : ''}。可以再试一次；若反复出现，换一个视觉模型试试。`
}

export function registerTools(ctx, deps) {
  const { getCfg, vision, capture, observer, memory, asr } = deps
  const disposers = []
  const failures = []
  const reg = (def) => {
    try {
      disposers.push(ctx.tools.register(def))
    } catch (error) {
      // 规格第 3 条红线：不许静默降级。注册失败必须留下可查的证据。
      failures.push({ name: def.name, error: errMsg(error) })
      log(`注册工具 ${def.name} 失败：${errMsg(error)}`)
    }
  }

  async function lookScreen(question, signal) {
    const cfg = getCfg()
    const observing = observer.status !== 'off' && observer.status !== 'error'
    try {
      const frame = await capture.grab({ fullWidth: vision.targetWidth(cfg.visionModel, 1280), thumbWidth: 256 })
      const text = await askText(vision, {
        model: cfg.visionModel,
        system: LOOK_SYSTEM,
        text: `这是用户此刻的主屏截图。${question ? `用户想知道：${question}` : '请做一个通用描述。'}`,
        images: [{ bytes: frame.full, name: `side-seat-look-${frame.t}.jpg` }],
        maxTokens: 700,
        signal,
        kind: 'look',
      }, '看屏幕')
      return `${text}\n\n（截屏后端：${capture.backendLabel}；截图只在内存里用了这一次，没有保存）`
    } finally {
      if (!observing) capture.release() // 不在陪看时，用完即释放截屏进程
    }
  }

  async function lookImage(bytes, name, question, signal) {
    const cfg = getCfg()
    return askText(vision, {
      model: cfg.visionModel,
      system: LOOK_SYSTEM,
      text: question ? `用户想知道：${question}` : '请描述这张图。',
      images: [{ bytes, name, mediaType: mediaTypeOf(name, 'image/jpeg', bytes) }],
      maxTokens: 700,
      signal,
      kind: 'look',
    }, '看图片')
  }

  async function lookVideo(input, question, range, signal) {
    const cfg = getCfg()
    const media = await probeMedia(input, { signal })
    const start = Math.max(0, Number(range?.start) || 0)
    const end = Math.min(media.duration || Infinity, Number(range?.end) || media.duration || 0)
    if (!(end > start)) throw new SideSeatError('BAD_RANGE', `range 无效（文件时长 ${fmtTime(media.duration)}）`)
    const notes = []
    let cues = []
    const status = asr.status(cfg)
    if (media.hasAudio && status.ready) {
      const span = Math.min(end - start, 300)
      try {
        const pcm = await audioPcm(input, { start, duration: span, signal })
        const res = await asr.transcribe(pcm16ToWav(pcm, 16000), { signal })
        cues = res.segments.map((s) => `[${fmtTime(start + (s.start || 0))}] ${s.text}`)
        if (res.cloud) notes.push('台词来自云端转写')
        if (end - start > span) notes.push(`只转写了 ${fmtTime(start)} 起的 ${fmtTime(span)}`)
      } catch (error) {
        notes.push(`转写失败：${errMsg(error)}`)
      }
    } else if (media.hasAudio) {
      notes.push(`没有台词依据：${status.reason}`)
    }
    if (!media.hasVideo) {
      if (!cues.length) return [`这是一个没有画面的文件。`, ...notes].join('\n')
      return [`（无画面）转写：`, ...cues, '', notes.join('；')].join('\n')
    }
    const n = Math.max(1, Math.min(6, Math.ceil((end - start) / 10)))
    const times = Array.from({ length: n }, (_, i) => start + ((i + 0.5) * (end - start)) / n)
    const images = []
    for (const t of times) {
      try { images.push({ bytes: await frameAt(input, t, { width: 768, signal }), name: `frame-${Math.round(t)}.jpg`, t }) } catch { /* skip */ }
    }
    if (!images.length) throw new SideSeatError('NO_FRAME', '一帧都抽不出来')
    const text = await askText(vision, {
      model: cfg.visionModel,
      system: `${LOOK_SYSTEM}\n解读视频时，每一条说法后面都带上出处时间 [mm:ss]，时间只能取自给你的帧时间或台词时间。`,
      text: [
        `视频 ${input}，时长 ${fmtTime(media.duration)}，本次看 ${fmtTime(start)}–${fmtTime(end)}。`,
        `按顺序给你 ${images.length} 帧，时间分别是 ${images.map((im) => fmtTime(im.t)).join('、')}。`,
        cues.length ? `这一段的台词：\n${cues.join('\n')}` : '你没有这一段的台词，不要编造台词。',
        question ? `用户想知道：${question}` : '请给出结构化的解读：发生了什么、关键画面在哪一秒、值得注意的细节。',
      ].join('\n'),
      images,
      maxTokens: 1200,
      signal,
      kind: 'look',
    }, '看视频')
    return [text, notes.length ? `\n—— ${notes.join('；')}` : ''].join('\n')
  }

  reg({
    name: `${TOOL_PREFIX}look`,
    description: [
      '旁座的「看一眼」：只在用户明确要你看东西时调用。',
      'target=screen 截一帧用户主屏回答问题（不需要 ffmpeg）；target=file 看本地图片或视频（视频需 ffmpeg）；',
      'target=url 看直链图片 / 视频；target=window 为后续版本。视频结果每条带 [mm:ss] 出处。',
      '这个工具从不主动运行，也不会开启实时陪看。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['screen', 'window', 'file', 'url'], description: '看什么' },
        source: { type: 'string', description: 'target=file 时为文件绝对路径；target=url 时为链接' },
        question: { type: 'string', description: '想看什么；不给则做通用描述' },
        range: {
          type: 'object',
          additionalProperties: false,
          properties: { start: { type: 'number' }, end: { type: 'number' } },
          description: '视频只取一段，单位秒',
        },
        out: { type: 'string', description: '把结果写到文件（.md / .txt）' },
      },
      required: ['target'],
    },
    output,
    async execute(args, exec) {
      const signal = exec?.signal
      try {
        const target = args?.target
        let text
        if (target === 'screen') text = await lookScreen(args.question, signal)
        else if (target === 'window') text = '「当前窗口」是后续版本（P1）的能力，这一版请用 target=screen 看整个主屏。'
        else if (target === 'file') {
          assertLocalFile(args.source)
          const kind = kindOf(args.source)
          if (kind === 'image') {
            if (statSync(args.source).size > 25 * 1024 * 1024) throw new SideSeatError('TOO_LARGE', '图片超过 25MB')
            text = await lookImage(readFileSync(args.source), args.source, args.question, signal)
          } else if (kind === 'video' || kind === 'audio') text = await lookVideo(args.source, args.question, args.range, signal)
          else throw new SideSeatError('UNSUPPORTED', `不认识的文件类型：${extname(args.source) || '（无扩展名）'}`)
        } else if (target === 'url') {
          const kind = kindOf(args.source)
          if (kind === 'image') {
            const { buf } = await fetchBytes(args.source, signal)
            text = await lookImage(buf, args.source, args.question, signal)
          } else if (kind === 'video' || kind === 'audio') text = await lookVideo(args.source, args.question, args.range, signal)
          else text = '旁座不渲染网页。请在浏览器里打开这个页面，然后用 target=screen 让我看屏幕；直链图片或视频可以直接给我。'
        } else {
          throw new SideSeatError('BAD_TARGET', 'target 只能是 screen / window / file / url')
        }
        return result(text + writeOut(args.out, text))
      } catch (error) {
        return failText(error)
      }
    },
  })

  reg({
    name: `${TOOL_PREFIX}caption`,
    description: '给本地视频按镜头 / 按秒 / 按场景出标注（每镜一行 + 时间码），导出 .srt 或 .csv。需要 ffmpeg。只在用户要求时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '本地视频绝对路径' },
        mode: { type: 'string', enum: ['shot', 'second', 'scene'], description: '按镜头 / 按秒 / 按场景，默认 shot' },
        fields: { type: 'array', items: { type: 'string', enum: ['scene', 'people', 'action', 'props', 'text'] }, description: '要哪些字段' },
        out: { type: 'string', description: '输出路径，.csv 或 .srt' },
      },
      required: ['source', 'out'],
    },
    output,
    async execute(args, exec) {
      try {
        return result(await runCaption({ vision, cfg: getCfg(), source: args.source, mode: args.mode || 'shot', fields: args.fields, out: args.out, signal: exec?.signal }))
      } catch (error) {
        return failText(error)
      }
    },
  })

  reg({
    name: `${TOOL_PREFIX}review`,
    description: '为本地视频写鉴赏 / 观后感：每一条论断后面都带秒数出处 [mm:ss]，没有出处的句子会被删掉。需要 ffmpeg；配了听写引擎时会引用台词。只在用户要求时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '本地视频绝对路径' },
        angle: { type: 'string', enum: ['story', 'craft', 'theme', 'personal'], description: '看故事 / 看技法 / 看主题 / 写私人感受' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], description: '字数档位' },
      },
      required: ['source'],
    },
    output,
    async execute(args, exec) {
      try {
        return result(await runReview({ vision, asr, cfg: getCfg(), source: args.source, angle: args.angle, length: args.length, signal: exec?.signal }))
      } catch (error) {
        return failText(error)
      }
    },
  })

  reg({
    name: `${TOOL_PREFIX}profile`,
    description: '读 / 改 / 删旁座的记忆（口味 taste、观点账本 ledger、关系 bond、共同经历 shared）。update 只接受该表 schema 内的字段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'update', 'forget'] },
        table: { type: 'string', enum: ['taste', 'ledger', 'bond', 'shared'], description: 'update / forget 必填' },
        patch: { type: 'object', description: 'update 必填；只接受该表 schema 内字段' },
      },
      required: ['action'],
    },
    output,
    async execute(args) {
      try {
        if (args.action === 'read') return result(JSON.stringify(memory.read(), null, 2))
        if (!args.table) throw new SideSeatError('BAD_ARGS', `${args.action} 需要 table`)
        if (args.action === 'update') {
          if (!args.patch) throw new SideSeatError('BAD_ARGS', 'update 需要 patch')
          const res = await memory.update(args.table, args.patch)
          if (!res.ok) return result(`没有写入：${res.error}`)
          return result(`已更新 ${args.table}：${JSON.stringify(res.written)}${res.rejected?.length ? `（忽略了不在 schema 内的字段：${res.rejected.join(', ')}）` : ''}`)
        }
        if (args.action === 'forget') {
          const res = await memory.forget(args.table)
          return result(res.ok ? `已删除 ${args.table} 的 ${res.deleted} 条记录` : `没有删除：${res.error}`)
        }
        throw new SideSeatError('BAD_ARGS', 'action 只能是 read / update / forget')
      } catch (error) {
        return failText(error)
      }
    },
  })

  if (failures.length) {
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(join(dataDir(), 'tools-register.json'), `${JSON.stringify({ at: Date.now(), failures }, null, 2)}\n`, 'utf8')
    } catch { /* 写不了就算了，stderr 里还有一份 */ }
  }

  return () => {
    for (const d of disposers.reverse()) {
      try { (typeof d === 'function' ? d : d?.dispose)?.call(d) } catch { /* ignore */ }
    }
  }
}
