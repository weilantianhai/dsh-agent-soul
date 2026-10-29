/**
 * index.mjs —— Sessions 模块入口
 *
 * 一件事：扫出 DSH 里活着的会话，登记进 memory/shared/sessions.json。
 *
 *   import { scan, register, getRegistry, isEnabled } from 'file:///<仓库根>/src/Sessions/index.mjs'
 *
 *   const r = await register(ctx, { onError })   // 扫 + 合并 + 落盘
 *   r.sessions['bili-whale'].enabled             // true / false
 *   isEnabled('bili-whale')                      // 1 号拿来决定记不记日志
 *
 * 不 import 任何别的模块 —— 模块要能单独删掉而不连累别人。
 * 不写日志、不写日记、不碰对象文件 —— 只碰 sessions.json。
 */

import {
  DEFAULT_REGISTRY_PATH,
  REGISTRY_VERSION,
  backupCorrupt,
  isoLocal,
  mergeScanned,
  readRegistry,
  todayStamp,
  writeRegistry,
} from './registry.mjs'
import { isArchivedId, probeArchived, probeLiveSessions } from './probes.mjs'

const msg = (err) => String((err && err.message) || err)

/** onError 只有调用方给了才转；转的时候炸了也不能毁流程 */
function report(onError, err) {
  if (typeof onError !== 'function') return
  try {
    onError(err)
  } catch {
    /* 回调自己炸了，不管 */
  }
}

function toDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now
  if (now !== undefined && now !== null) {
    const d = new Date(now)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

function registryPathOf(opts) {
  if (typeof opts === 'string' && opts) return opts
  if (opts && typeof opts.registryPath === 'string' && opts.registryPath) return opts.registryPath
  return DEFAULT_REGISTRY_PATH
}

/**
 * 扫一次，返回一份「刚扫到的登记表」（不读旧表、不写盘）。
 *
 * @param {object} ctx   DSH 宿主上下文
 * @param {object} [opts]
 * @param {Date|string|number} [opts.now]        测试用：假装现在几点
 * @param {string} [opts.workspacePath]          归档名单兜底文件路径
 * @param {string[]} [opts.includeIds]           额外要登记的会话 id
 * @param {(err:Error)=>void} [opts.onError]     出错回调（**不吞**）
 * @returns {Promise<object>} 见 API.md「scan 返回什么」
 */
export async function scan(ctx, opts = {}) {
  const now = toDate(opts.now)
  const onError = opts.onError
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null
  const today = todayStamp(now)

  const live = await probeLiveSessions(ctx, {
    includeIds: opts.includeIds,
    visibility: opts.visibility,
    requireName: opts.requireName,
  })
  const archive = probeArchived(ctx, { workspacePath: opts.workspacePath })

  const sessions = {}
  for (const s of live.list) {
    // 归档名单拿不到 → 一律当没归档，宁可多露也不许漏记
    const archived = archive.known ? isArchivedId(archive, s.id) : false
    sessions[s.id] = {
      name: s.name || '',
      firstSeen: today,
      lastSeen: today,
      archived,
      enabled: archive.known ? !archived : true,
    }
  }

  const errors = [...live.errors]
  const notes = [...live.warnings]
  if (archive.known) notes.push(...archive.notes)
  else errors.push(...archive.notes)

  const result = {
    version: REGISTRY_VERSION,
    updated: isoLocal(now),
    archivedKnown: archive.known,
    archivedSource: archive.source,
    sessions,
    errors,
    notes,
  }

  // 报警：一类失败报一次，但不许一次都不报
  if (live.errors.length) {
    report(onError, new Error(`扫会话失败：${live.errors.join('；')}`))
  }
  if (!archive.known) {
    report(
      onError,
      new Error(`归档名单两条路都拿不到（本次 archivedKnown=false，宁可多露）：${archive.notes.join('；')}`),
    )
  }

  return result
}

/**
 * 扫 + 合并 + 写盘。日常跑这个。
 *
 * @param {object} ctx
 * @param {object} [opts]  同 scan，另有：
 * @param {string} [opts.registryPath]          登记表路径
 * @param {(sid:string, info:object)=>void} [opts.onDiscover] 新会话回调
 * @returns {Promise<object>} 写后的登记表对象（另带 wrote / discovered / missing / backupPath）
 */
export async function register(ctx, opts = {}) {
  const now = toDate(opts.now)
  const path = registryPathOf(opts)
  const onError = opts.onError

  const scanned = await scan(ctx, opts)
  const read = readRegistry(path)

  // 版本比我新：不认，也不许覆盖
  if (read.health === 'future') {
    report(onError, new Error(read.error))
    return {
      ...scanned,
      wrote: false,
      reason: 'version-too-new',
      path: read.path,
      backupPath: null,
    }
  }

  // 读不动（权限/占用）：不写，免得把别人的表覆盖成空表
  if (read.health === 'unreadable') {
    report(onError, new Error(read.error))
    return {
      ...scanned,
      wrote: false,
      reason: 'unreadable',
      path: read.path,
      backupPath: null,
    }
  }

  // 坏了：先备份，再按空表重建
  let prev = read.registry
  let backupPath = null
  if (read.health === 'corrupt') {
    try {
      backupPath = backupCorrupt(path)
    } catch (err) {
      report(onError, new Error(`登记表坏了，备份也失败：${msg(err)}`))
    }
    report(
      onError,
      new Error(
        `登记表坏了（${read.error}），本次按空表重建` +
          (backupPath ? `；坏文件已备份到 ${backupPath}` : '；备份没成功，坏文件已被覆盖'),
      ),
    )
    prev = read.registry
  }

  // 扫到 0 个会话 + 表里原来有东西 = 不许覆盖
  // 2026-10-27 实战踩到：离线纯扫盘那次扫出 98 个，换到运行时环境扫出 0 个，
  // 结果把 98 个覆盖成了空表，且没有备份。防护漏的就是这一条。
  const scannedCount = Object.keys((scanned && scanned.sessions) || {}).length
  const prevCount = Object.keys((prev && prev.sessions) || {}).length
  if (scannedCount === 0 && prevCount > 0) {
    /*
     * ⚠️ 这是**警告**，不是错误（2026-10-29 用户反馈体检里一直红着）。
     *
     * 它描述的是一件正常的事：插件启动得比宿主早，那一刻 sessionController
     * 还没把会话列出来，于是扫到 0 条。防护按设计工作（不覆盖、数据没丢），
     * 但把它当错误报，用户每次点体检都会看到一条红 —— 看起来像坏了。
     *
     * 所以走 onWarn：进 warnings，不进 errors。
     */
    const text = `启动时一个会话都没扫到，但表里原有 ${prevCount} 个 —— 没覆盖，等宿主就绪后会自己补上`
    if (typeof onWarn === 'function') onWarn(new Error(text))
    else report(onError, new Error(text))
    return {
      ...(prev || {}),
      wrote: false,
      reason: 'scan-empty',
      path,
      backupPath: null,
      errors: scanned.errors,
      notes: scanned.notes,
    }
  }

  const merged = mergeScanned(prev, scanned, {
    today: todayStamp(now),
    updated: scanned.updated,
    onDiscover: opts.onDiscover,
    onError,
    // 要清旧行的话由调用方显式给天数（默认不清）
    ...(Number.isFinite(opts.pruneUnnamedAfterDays) ? { pruneUnnamedAfterDays: opts.pruneUnnamedAfterDays } : {}),
  })

  const written = writeRegistry(path, merged.registry)
  if (!written.ok) report(onError, new Error(written.error))

  return {
    ...merged.registry,
    archivedSource: scanned.archivedSource,
    discovered: merged.discovered,
    missing: merged.missing,
    wrote: written.ok,
    path: written.path,
    backupPath,
    errors: scanned.errors,
    notes: scanned.notes,
  }
}

/**
 * 盯着宿主，有新会话就重新扫一遍登记表。
 *
 * 为什么必须有这个：`apply` 跑在**启动那一刻**，那时一个会话都没有，
 * 扫出来必然是空表 —— 表就一直是空的，直到下次重启。真机 2026-10-28 就是这样：
 * 插件全绿、登记表 `{}`、设置页一片空白。
 *
 * 监听（都只在"会话真的冒出来"时触发，不做定时轮询）：
 *   session/created —— 会话发布（新建 / 恢复 / 分叉）
 *   agent/created   —— agent 起来
 *   session/event   —— 兜底：当这条会话还不在表里时（比如插件比会话晚就绪）补一次
 *
 * 多次触发会合并成一次写盘（delay 毫秒内只扫一次），写盘失败只报错不抛。
 *
 * @param {object} ctx
 * @param {object} [opts]  同 register，另有 opts.delay（合并窗口，默认 30ms）
 * @returns {() => void} 取消监听（幂等）
 */
export function watch(ctx, opts = {}) {
  const onError = opts.onError
  const delay = Number.isFinite(opts.delay) ? Math.max(0, Number(opts.delay)) : 30
  const offs = []
  let timer = null
  let busy = false
  let pending = false
  let stopped = false

  /** 现在表里有哪些会话 —— 只用来看"这条是不是还没登记" */
  let known = new Set()
  try {
    const cur = getRegistry(opts)
    known = new Set(Object.keys(cur.sessions || {}))
  } catch {
    /* 读不到就当成空，反正第一次扫会把 known 补上 */
  }

  const refresh = async () => {
    if (stopped) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    try {
      const out = await register(ctx, { ...opts, onError })
      const rows = (out && out.sessions) || null
      if (rows) known = new Set(Object.keys(rows))
    } catch (err) {
      report(onError, err instanceof Error ? err : new Error(String(err)))
    } finally {
      busy = false
      if (pending && !stopped) {
        pending = false
        schedule()
      }
    }
  }

  const schedule = () => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, delay)
    // 别为了等一次合并把进程拖住
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  const on = (name, fn) => {
    try {
      if (!ctx || typeof ctx.on !== 'function') return false
      const off = ctx.on(name, fn)
      if (typeof off === 'function') offs.push(off)
      return true
    } catch (err) {
      report(onError, new Error(`挂不上 ${name} 监听：${msg(err)}`))
      return false
    }
  }

  const sidOfEvent = (session) => {
    try {
      return String((session && session.id) || '')
    } catch {
      return ''
    }
  }

  on('session/created', () => schedule())
  on('agent/created', () => schedule())
  on('session/event', (session) => {
    const sid = sidOfEvent(session)
    // 已知会话的事件不用扫；不认识的才补一次（插件比会话晚就绪时靠这条自愈）
    if (sid && !known.has(sid)) schedule()
  })

  return function unwatch() {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    for (const off of offs.reverse()) {
      try {
        off()
      } catch {
        /* 拆不掉不影响别的 */
      }
    }
    offs.length = 0
  }
}

/**
 * 读当前登记表，**不扫**。
 *
 * @param {object|string} [opts]  路径，或 { registryPath, onError }
 * @returns {object} 登记表对象；另带 health / path / error
 */
export function getRegistry(opts = {}) {
  const path = registryPathOf(opts)
  const read = readRegistry(path)
  const onError = typeof opts === 'object' && opts ? opts.onError : undefined

  if (read.error) report(onError, new Error(read.error))

  return { ...read.registry, health: read.health, path: read.path, error: read.error }
}

/**
 * 这个会话要不要记日志（1 号来问的就是这句）。
 *
 * 拿不准一律 true —— 宁可多记，不许漏记。
 * 表里没这个会话也 true（新会话默认开着，等下次 register 再落成一行）。
 *
 * @param {string} sid
 * @param {object|string} [opts]
 * @returns {boolean}
 */
export function isEnabled(sid, opts = {}) {
  const reg = getRegistry(opts)

  // 表不可信 → 多记
  if (reg.health !== 'ok' && reg.health !== 'missing') return true

  const row = sid ? reg.sessions[String(sid)] : null
  if (!row) return true
  if (row.archived === true) return false
  return row.enabled !== false
}
