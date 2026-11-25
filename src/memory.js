/**
 * C 轴：记忆与人格的四张表（4.3）+ 沉默记录 moments + 元数据 meta。
 *
 *   taste   口味：喜欢的类型、雷区、剧透容忍度、节奏偏好
 *   ledger  观点账本：它自己的立场 + 时间戳，跨时间一致
 *   bond    关系：称呼、亲密度、累计时长、免打扰、说话预算、被嫌烦计数
 *   shared  共同经历：看过什么、哪句被接受 —— 「你上次说…」的唯一来源
 *   moments 每一次 SILENT 的 { t, reason }，调阈值与算沉默正确率的唯一数据源
 *
 * 存储：优先 DSH 自带的 storage domain（ctx.storageDomain / ctx.storage.domain，
 * domain 名 side-seat）；拿不到时落到 $DSH_HOME/plugins-data/side-seat/memory.json。
 * 只读写自己的 domain，不碰别人的（零冲突契约 #4）。
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { svc } from './compat.js'
import { dataDir, errMsg, log, readJsonFile, writeJsonAtomic } from './util.js'

export const TABLES = ['taste', 'ledger', 'bond', 'shared']
const ALL_TABLES = [...TABLES, 'moments', 'meta']
const MOMENTS_CAP = 2000
const SHARED_CAP = 500
const LEDGER_CAP = 200

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : undefined)

/** 每张表允许用户 / 模型改写的字段（side_seat_profile 的 patch 只接受这些）。 */
export const PATCH_SCHEMA = {
  taste: {
    likes: (v) => strList(v, 30, 40),
    dislikes: (v) => strList(v, 30, 40),
    spoilerTolerance: (v) => (['none', 'low', 'high'].includes(v) ? v : undefined),
    pace: (v) => str(v, 40),
    notes: (v) => str(v, 200),
  },
  ledger: {
    topic: (v) => str(v, 60),
    stance: (v) => str(v, 200),
  },
  bond: {
    nickname: (v) => str(v, 20),
    intimacy: (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : undefined),
    quietMode: (v) => (typeof v === 'boolean' ? v : undefined),
  },
  shared: {
    title: (v) => str(v, 80),
    note: (v) => str(v, 200),
  },
}

export function validatePatch(table, patch) {
  const schema = PATCH_SCHEMA[table]
  if (!schema) return { ok: false, error: `未知的表：${table}` }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch 必须是对象' }
  const clean = {}
  const rejected = []
  for (const [key, value] of Object.entries(patch)) {
    if (!schema[key]) { rejected.push(key); continue }
    const v = schema[key](value)
    if (v === undefined) rejected.push(key)
    else clean[key] = v
  }
  if (!Object.keys(clean).length) return { ok: false, error: `没有可写的字段（${table} 只接受：${Object.keys(schema).join(', ')}）`, rejected }
  return { ok: true, clean, rejected }
}

const DEFAULT_TASTE = { likes: [], dislikes: [], spoilerTolerance: 'none', pace: '', notes: '' }
const DEFAULT_BOND = {
  nickname: '',
  intimacy: 0.2,
  totalMinutes: 0,
  quietMode: false,
  speakBudgetPerHour: 30,
  annoyedStreak: 0,
  annoyedUntil: 0,
}

/* ---------------- 后端：storage domain ---------------- */

async function openDomainBackend(ctx) {
  const facility = svc(ctx, 'storageDomain') || (() => { try { return svc(ctx, 'storage')?.domain || null } catch { return null } })()
  if (!facility || typeof facility.open !== 'function') return null
  let defineDomain
  let domainTable
  let z
  try {
    ({ defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain'))
    ;({ z } = await import('zod'))
  } catch {
    return null
  }
  if (typeof defineDomain !== 'function' || typeof domainTable !== 'function' || !z) return null
  const value = () => domainTable(z.object({}).passthrough())
  const tables = Object.fromEntries(ALL_TABLES.map((t) => [t, value()]))
  let domain = null
  for (const name of ['side-seat', 'side_seat']) {
    try {
      domain = await facility.open(defineDomain({ name, version: 1, tables }))
      break
    } catch (error) {
      log(`storage domain「${name}」打开失败：${errMsg(error)}`)
    }
  }
  if (!domain) return null
  const t = (name) => domain.table(name)
  return {
    kind: 'storage-domain',
    get: (table, key) => t(table).get(key),
    entries: (table) => [...t(table).entries()],
    put: (table, key, v) => t(table).put(key, v),
    del: (table, key) => t(table).delete(key),
    async clear(table) {
      const keys = [...t(table).keys()]
      if (!keys.length) return 0
      if (typeof t(table).deleteMany === 'function') return t(table).deleteMany(keys)
      let n = 0
      for (const k of keys) if (await t(table).delete(k)) n++
      return n
    },
    flush: async () => {},
    close: () => domain.close(),
  }
}

/* ---------------- 后端：JSON 文件兜底 ---------------- */

function openFileBackend() {
  const file = join(dataDir(), 'memory.json')
  const raw = readJsonFile(file, null)
  const state = { version: 1, tables: Object.fromEntries(ALL_TABLES.map((t) => [t, {}])) }
  if (raw && raw.tables && typeof raw.tables === 'object') {
    for (const t of ALL_TABLES) if (raw.tables[t] && typeof raw.tables[t] === 'object') state.tables[t] = raw.tables[t]
  }
  let timer = null
  const save = () => {
    try { writeJsonAtomic(file, state) } catch (error) { log(`写记忆失败：${errMsg(error)}`) }
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => { timer = null; save() }, 800)
  }
  return {
    kind: 'file',
    file,
    get: (table, key) => state.tables[table][key],
    entries: (table) => Object.entries(state.tables[table]),
    async put(table, key, v) { state.tables[table][key] = v; schedule() },
    async del(table, key) { const had = key in state.tables[table]; delete state.tables[table][key]; schedule(); return had },
    async clear(table) { const n = Object.keys(state.tables[table]).length; state.tables[table] = {}; schedule(); return n },
    async flush() { if (timer) { clearTimeout(timer); timer = null } save() },
    async close() { await this.flush() },
  }
}

/* ---------------- 记忆门面 ---------------- */

export async function createMemory(ctx) {
  let kv = null
  try { kv = await openDomainBackend(ctx) } catch (error) { log(`storage domain 不可用：${errMsg(error)}`) }
  if (!kv) kv = openFileBackend()
  log(`记忆存储：${kv.kind}`)

  const taste = () => ({ ...DEFAULT_TASTE, ...(kv.get('taste', 'profile') || {}) })
  const bond = () => ({ ...DEFAULT_BOND, ...(kv.get('bond', 'self') || {}) })
  const sortByT = (rows) => rows.map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.t || 0) - (b.t || 0))
  const ledger = () => sortByT(kv.entries('ledger'))
  const shared = () => sortByT(kv.entries('shared'))
  const moments = () => sortByT(kv.entries('moments'))

  async function trim(table, cap) {
    const rows = sortByT(kv.entries(table))
    if (rows.length <= cap) return
    for (const row of rows.slice(0, rows.length - cap)) await kv.del(table, row.id)
  }

  const api = {
    get backend() { return kv.kind },
    taste,
    bond,
    ledger,
    shared,
    moments,

    meta(key) { return kv.get('meta', key)?.value },
    async setMeta(key, value) { await kv.put('meta', key, { value, t: Date.now() }) },

    async updateBond(patch) { await kv.put('bond', 'self', { ...bond(), ...patch }) },

    async addMoment(reason, extra = {}) {
      await kv.put('moments', randomUUID(), { t: Date.now(), reason: String(reason).slice(0, 200), ...extra })
      if (Math.random() < 0.05) await trim('moments', MOMENTS_CAP)
    },

    async addShared(entry) {
      const id = randomUUID()
      await kv.put('shared', id, { t: Date.now(), ...entry })
      await trim('shared', SHARED_CAP)
      return id
    },

    async markShared(id, patch) {
      const current = kv.get('shared', id)
      if (current) await kv.put('shared', id, { ...current, ...patch })
    },

    async upsertStance(topic, stance) {
      const existing = ledger().find((row) => row.topic === topic)
      await kv.put('ledger', existing ? existing.id : randomUUID(), { topic, stance, t: Date.now() })
      await trim('ledger', LEDGER_CAP)
    },

    /** side_seat_profile read：给模型 / 用户看的摘要。 */
    read() {
      const b = bond()
      return {
        taste: taste(),
        ledger: ledger().slice(-30).map(({ topic, stance, t }) => ({ topic, stance, t })),
        bond: { nickname: b.nickname, intimacy: b.intimacy, totalMinutes: Math.round(b.totalMinutes), quietMode: b.quietMode, speakBudgetPerHour: b.speakBudgetPerHour },
        shared: shared().slice(-20).map(({ t, title, see, line, accepted, note }) => ({ t, title, see, line, accepted, note })),
        counts: { ledger: ledger().length, shared: shared().length, moments: moments().length },
        storage: kv.kind,
      }
    },

    async update(table, patch) {
      const check = validatePatch(table, patch)
      if (!check.ok) return check
      const clean = check.clean
      if (table === 'taste') await kv.put('taste', 'profile', { ...taste(), ...clean, t: Date.now() })
      else if (table === 'bond') await api.updateBond(clean)
      else if (table === 'ledger') {
        if (!clean.topic || !clean.stance) return { ok: false, error: 'ledger 需要同时给 topic 与 stance' }
        await api.upsertStance(clean.topic, clean.stance)
      } else if (table === 'shared') await api.addShared({ title: clean.title, note: clean.note, source: 'profile' })
      return { ok: true, table, written: clean, rejected: check.rejected }
    },

    async forget(table) {
      if (!TABLES.includes(table)) return { ok: false, error: `未知的表：${table}` }
      const n = await kv.clear(table)
      return { ok: true, table, deleted: n }
    },

    /** 设置页「清除全部记忆」：真的删，并回报删了几条。 */
    async clearAll() {
      const counts = {}
      let total = 0
      for (const t of [...TABLES, 'moments']) {
        const n = await kv.clear(t)
        counts[t] = n
        total += n
      }
      await kv.flush()
      return { total, counts }
    },

    async flush() { await kv.flush() },
    async close() { try { await kv.close() } catch { /* ignore */ } },
  }
  return api
}
