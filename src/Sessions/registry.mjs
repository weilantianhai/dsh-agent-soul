/**
 * registry.mjs —— 登记表 sessions.json 的读写、校验、合并
 *
 * 只碰这一个文件。日志、日记、对象文件一概不认 —— 删登记表绝不能碰坏真数据。
 *
 * 三条自我约束：
 *   1. 写之前先写 .tmp 再 rename —— 中途崩了也不会留半张表
 *   2. 读坏了**先备份再重建**，绝不把坏文件直接覆盖掉
 *   3. 版本比我新就不写（version > 1 说明以后改过结构，我不认识就别动）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(MODULE_DIR, '..', '..')

/** 结构版本。改结构就升这个数，并且同步 API.md */
export const REGISTRY_VERSION = 1

/** 登记表新位置：`memory/system/sessions.json`（`shared/` 只留 MEMORY.md 和 people，别把表放回去） */
export const REGISTRY_PATH_SYSTEM = resolve(PROJECT_ROOT, 'memory', 'system', 'sessions.json')

/** 旧位置（2026-10-27 目录改版前）。只有 system 还没建、它还有数据时才认它，免得表分裂成两份 */
export const REGISTRY_PATH_LEGACY = resolve(PROJECT_ROOT, 'memory', 'shared', 'sessions.json')

function pickDefaultRegistryPath() {
  if (existsSync(REGISTRY_PATH_SYSTEM)) return REGISTRY_PATH_SYSTEM
  if (existsSync(REGISTRY_PATH_LEGACY)) return REGISTRY_PATH_LEGACY
  return REGISTRY_PATH_SYSTEM
}

export const DEFAULT_REGISTRY_PATH = pickDefaultRegistryPath()

const msg = (err) => String((err && err.message) || err)

/** 一张空表 */
export function emptyRegistry() {
  return { version: REGISTRY_VERSION, updated: null, archivedKnown: false, sessions: {} }
}

/**
 * 读登记表。**不写、不备份**（只读语义，getRegistry 用）。
 *
 * @param {string} [path]
 * @returns {{ registry:object, health:'ok'|'missing'|'corrupt'|'future'|'unreadable',
 *             path:string, error:string|null }}
 *   health 说明：
 *     ok         —— 读到了，能用
 *     missing    —— 文件不存在（第一次跑，正常）
 *     corrupt    —— 文件在但内容不是我能认的（register 会备份后重建）
 *     future     —— version 比我新（**不许覆盖**）
 *     unreadable —— 文件在但读不动（权限/占用）
 */
export function readRegistry(path = DEFAULT_REGISTRY_PATH) {
  const p = resolve(path)

  if (!existsSync(p)) {
    return { registry: emptyRegistry(), health: 'missing', path: p, error: null }
  }

  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch (err) {
    return { registry: emptyRegistry(), health: 'unreadable', path: p, error: `登记表读不了：${msg(err)}` }
  }

  if (!text.trim()) {
    return { registry: emptyRegistry(), health: 'corrupt', path: p, error: '登记表是空的（0 字节）' }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { registry: emptyRegistry(), health: 'corrupt', path: p, error: `登记表不是合法 JSON：${msg(err)}` }
  }

  const norm = normalize(parsed)
  if (norm.future) {
    return { registry: emptyRegistry(), health: 'future', path: p, error: norm.error }
  }
  if (!norm.ok) {
    return { registry: emptyRegistry(), health: 'corrupt', path: p, error: norm.error }
  }
  return { registry: norm.registry, health: 'ok', path: p, error: null }
}

/** YYYY-MM-DD 往前推几天 */
function dayBefore(date, days) {
  if (!date) return ''
  const d = new Date(`${date}T12:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 把读进来的东西收成我能用的样子；收不了就说为什么 */
function normalize(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '登记表根节点不是对象' }
  }

  const v = parsed.version
  if (v !== undefined && v !== null) {
    if (!Number.isInteger(v)) return { ok: false, error: `version 不是整数（是 ${typeof v}）` }
    if (v > REGISTRY_VERSION) {
      return { ok: false, future: true, error: `登记表版本 ${v} 比本模块认识的 ${REGISTRY_VERSION} 新，不敢覆盖` }
    }
  }

  const raw = parsed.sessions
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, error: 'sessions 不是对象' }
  }

  const registry = {
    version: REGISTRY_VERSION,
    updated: typeof parsed.updated === 'string' ? parsed.updated : null,
    archivedKnown: parsed.archivedKnown === true,
    sessions: {},
  }

  for (const [sid, row] of Object.entries(raw || {})) {
    if (!sid) continue
    registry.sessions[sid] = normalizeRow(row)
  }
  return { ok: true, registry }
}

function normalizeRow(row) {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {}
  const out = {
    name: typeof r.name === 'string' ? r.name : '',
    firstSeen: typeof r.firstSeen === 'string' ? r.firstSeen : '',
    lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : '',
    archived: r.archived === true,
    enabled: r.enabled !== false,
  }
  if (r.missing === true) out.missing = true
  return out
}

/**
 * 备份坏掉的登记表，返回备份路径。
 * 名字带时间戳，同名就加序号，绝不覆盖旧备份。
 */
export function backupCorrupt(path) {
  const p = resolve(path)
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

  let target = `${p}.bak-${stamp}`
  let i = 1
  while (existsSync(target)) target = `${p}.bak-${stamp}-${i++}`

  copyFileSync(p, target)
  return target
}

/**
 * 写登记表：先写 .tmp 再 rename，key 按字母排，缩进 2。
 * @returns {{ ok:boolean, path:string, error:string|null }}
 */
export function writeRegistry(path, registry) {
  const p = resolve(path)
  const payload = {
    version: REGISTRY_VERSION,
    updated: registry.updated || null,
    archivedKnown: registry.archivedKnown === true,
    sessions: sortSessions(registry.sessions || {}),
  }

  const tmp = `${p}.tmp`
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, p)
    } catch {
      // Windows 上偶尔 rename 不过去（文件被占用），退一步直接写正本
      writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 残留个 tmp 不致命 */
      }
    }
    return { ok: true, path: p, error: null }
  } catch (err) {
    return { ok: false, path: p, error: `登记表写不进去：${msg(err)}` }
  }
}

function sortSessions(sessions) {
  const out = {}
  for (const sid of Object.keys(sessions).sort()) out[sid] = sessions[sid]
  return out
}

/**
 * 把「这次扫到的」合进「表里原有的」。
 *
 * 规矩（任务单第四节）：
 *   - 老会话：保留 firstSeen，更新 lastSeen / name / archived
 *   - 新会话：加进去，firstSeen = 今天，并回调 onDiscover
 *   - 表里有、这次没扫到：**不删**，标 missing:true
 *   - archivedKnown=false：不许拿「没归档」去覆盖，保留原值；新行给 archived:false + enabled:true（多露）
 *
 * @param {object} prev            原登记表（readRegistry().registry）
 * @param {object} scanned         scan() 的返回
 * @param {object} ctx
 * @param {string} ctx.today       YYYY-MM-DD
 * @param {string} ctx.updated     ISO8601 带时区
 * @param {(sid:string, info:object)=>void} [ctx.onDiscover]
 * @returns {{ registry:object, discovered:string[], missing:string[] }}
 */
export function mergeScanned(prev, scanned, ctx = {}) {
  const today = ctx.today || ''
  const prevSessions = (prev && prev.sessions) || {}
  const scannedSessions = (scanned && scanned.sessions) || {}
  const archivedKnown = scanned ? scanned.archivedKnown === true : false

  const registry = {
    version: REGISTRY_VERSION,
    updated: ctx.updated || null,
    archivedKnown,
    sessions: {},
  }

  const discovered = []
  const missing = []
  const seen = new Set()

  for (const [sid, s] of Object.entries(scannedSessions)) {
    if (!sid) continue
    seen.add(sid)
    const old = prevSessions[sid]

    const name = (s && s.name) || (old && old.name) || ''
    const lastSeen = (s && s.lastSeen) || today
    const firstSeen = (old && old.firstSeen) || today

    // 归档状态：只有拿到了可信名单才敢改，拿不到就留原样
    const archived = archivedKnown ? !!(s && s.archived) : !!(old && old.archived)

    // enabled：可信时跟 archived 反着走；不可信时保留原值（新会话给 true）
    const enabled = archivedKnown ? !archived : old ? old.enabled !== false : true

    registry.sessions[sid] = { name, firstSeen, lastSeen, archived, enabled }
    if (!old) discovered.push(sid)
  }

  /*
   * 表里有、这次没扫到的会话 —— **不删，标 missing**。
   *
   * 这是模块的原始契约，2026-10-29 恢复回来了。
   *
   * 中间试过"直接清掉"（想解决设置页里一堆点不开的 uuid），
   * 但那是**显示层的问题**，不该让存储层担。模块的职责是如实记录
   * "我见过它、现在没见到"，删不删由调用方决定。
   *
   * 现在插件层用另一套判据决定哪些显示、哪些算幽灵
   * （见 lib/routes.mjs 的 sessionAlive），模块保持中立。
   *
   * 安全：即使标了 missing，日志和日记也一个字节都不动。
   */
  for (const [sid, old] of Object.entries(prevSessions)) {
    if (seen.has(sid)) continue
    registry.sessions[sid] = {
      name: old.name || '',
      firstSeen: old.firstSeen || '',
      lastSeen: old.lastSeen || '',
      archived: old.archived === true,
      enabled: old.enabled !== false,
      missing: true,
    }
    missing.push(sid)
  }

  if (typeof ctx.onDiscover === 'function') {
    for (const sid of discovered) {
      try {
        ctx.onDiscover(sid, registry.sessions[sid])
      } catch (err) {
        // 别人的回调炸了不该毁我的表；交给 onError
        if (typeof ctx.onError === 'function') {
          try {
            ctx.onError(new Error(`onDiscover(${sid}) 抛错：${msg(err)}`))
          } catch {
            /* 回调里的回调，不再兜 */
          }
        }
      }
    }
  }

  return { registry, discovered, missing }
}

/** 今天是哪天（本地时区 YYYY-MM-DD） */
export function todayStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 现在几点（本地时区 ISO8601 带偏移） */
export function isoLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(off) / 60))
  const mm = pad(Math.abs(off) % 60)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
  )
}
