/**
 * domain/session.mjs —— 会话是什么：身份、可见性、存活、空壳。
 *
 * 这个文件存在的唯一理由：**同一个判据只许出现一次。**
 *
 * 2026-10-29 之前的实际情况：`readSidebarSessions` 在 lib/config.mjs 和
 * Sessions/probes.mjs 各有一份（逻辑一致，注释不同）；`sessionAlive`
 * 在两个文件之间搬过三次，其中一次删错了文件；"空壳"判据（4KB）
 * 只写在 routes.mjs 里，别处想用就重新写一遍。
 *
 * 现在所有会话判据都在这里，别人只能 import，不能重写。
 * 每一条都对应 docs/MODEL.md 的第一章，改之前先看那份文档。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 宿主用户目录：`~/.dsh`。读不到返回 '' */
function dshHome() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home ? join(home, '.dsh') : ''
}

/* ------------------------------------------------------------------ 可见性 */

/**
 * 侧边栏里**真正能点到**的会话集合。
 *
 * 口径（和 DSH 的 sessionVisible 一致）：
 *   (tables.workspaces[*].sessionIds ∪ global.pinnedSessionIds)
 *     − global.archivedSessionIds
 *
 * 为什么这个集合是最重要的一个（MODEL.md 1.2）：
 *   磁盘上有 141 个会话，侧边栏只显示 77 个。那 64 个差额是旧工作区、
 *   已删没清、别人的目录 —— **用户根本看不到它们**。
 *   任何给用户看的数字（会话数、日记筛选、幽灵判定）都必须用这个集合，
 *   否则用户会一直觉得数字不对（他数的是眼睛能看见的东西）。
 *
 * @returns {Set<string>|null}  sessionId 集合；**读不到返回 null**（不是空集）
 */
export function readSidebarSessions() {
  try {
    const base = dshHome()
    if (!base) return null
    const file = join(base, 'storages', 'workspace.json')
    if (!existsSync(file)) return null

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const table = raw && raw.tables && raw.tables.workspaces
    const global = (raw && raw.global) || {}
    if (!table || typeof table !== 'object') return null

    const out = new Set()
    // ① 工作区里的
    for (const w of Object.values(table)) {
      const ids = w && w.sessionIds
      if (!Array.isArray(ids)) continue
      for (const sid of ids) if (sid) out.add(String(sid))
    }
    // ② 置顶的（哪怕不属于任何工作区，侧边栏也显示）
    if (Array.isArray(global.pinnedSessionIds)) {
      for (const sid of global.pinnedSessionIds) if (sid) out.add(String(sid))
    }
    // ③ 减掉归档的（那是僵尸，侧边栏不显示）
    if (Array.isArray(global.archivedSessionIds)) {
      for (const sid of global.archivedSessionIds) if (sid) out.delete(String(sid))
    }

    return out.size > 0 ? out : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 宿主存储 */

/**
 * 读宿主会话库里每个会话的**实际内容字节数**。
 *
 * 为什么需要（MODEL.md 1.4）：有些会话在侧边栏里、也在宿主存储里，
 * 但只有 0.3 KB —— 建过、一句正经话都没聊，只剩元数据。
 * 用户心里"有会话"指的是真聊过的，不是这种空壳。
 *
 * 实测：bili-whale 7733 KB（真聊过）/ xiaoxi 名下那个 0.4 KB（空壳）
 *
 * @returns {Map<string, number>|null}  sessionId → 字节数；读不到返回 null
 */
export function readHostSessionSizes() {
  try {
    const base = dshHome()
    if (!base) return null
    const dir = join(base, 'sessions')
    if (!existsSync(dir)) return null

    const out = new Map()
    for (const bucket of readdirSync(dir)) {
      const sub = join(dir, bucket)
      let isDir = false
      try {
        isDir = statSync(sub).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue

      for (const sid of readdirSync(sub)) {
        const inner = join(sub, String(sid))
        let bytes = 0
        try {
          for (const f of readdirSync(inner)) {
            try {
              bytes += statSync(join(inner, f)).size
            } catch {
              /* 单个文件读不到就跳过 */
            }
          }
        } catch {
          continue // 不是目录
        }
        out.set(String(sid), bytes)
      }
    }
    return out.size > 0 ? out : null
  } catch {
    return null
  }
}

/** 小于这个字节数就算"空壳"：建了会话但没真聊过。见 MODEL.md 1.4 的 ❓ */
export const EMPTY_SESSION_BYTES = 4 * 1024

/* ------------------------------------------------------------------ 存活 */

/**
 * 一个会话「还在不在」：侧边栏可见 **且** 不是空壳。
 *
 * @param {string} sid
 * @param {Set<string>|null} sidebar  侧边栏可见集合（readSidebarSessions 的结果）
 * @param {Map<string,number>|null} sizes  宿主存储大小（readHostSessionSizes 的结果）
 * @returns {boolean|null}  true 在 / false 不在 / **null 不知道**
 *
 * 为什么三种返回值：判据读不到时不能当成"不在" —— 那会误删。
 * 调用方遇到 null 必须原样保留。
 */
export function sessionAlive(sid, sidebar, sizes) {
  if (sidebar === null) return null // 读不到清单就不判
  const id = String(sid)
  if (!sidebar.has(id)) return false

  // 清单里有，但内容太小 → 空壳，不算
  if (sizes === null) return true // 拿不到大小就按"在"算，宁可多露
  const bytes = sizes.get(id)
  if (bytes === undefined) return true // 宿主没有它的记录，但仍能算在
  return bytes >= EMPTY_SESSION_BYTES
}

/**
 * 一次性拿到判定所需的两份数据，避免调用方各自去读。
 *
 * 这么做的原因：这两个读取各有几十毫秒，一个请求里读两遍很浪费，
 * 而且两次读到的东西可能不一致（中间别人动了文件）。
 *
 * @returns {{sidebar: Set<string>|null, sizes: Map<string,number>|null}}
 */
export function readSessionSnapshot() {
  return { sidebar: readSidebarSessions(), sizes: readHostSessionSizes() }
}

/** 按上面这份快照判断存活，省得每次都传两个参数 */
export function aliveIn(snapshot) {
  return (sid) => sessionAlive(sid, snapshot.sidebar, snapshot.sizes)
}

/**
 * 把宿主各种"列表返回值"统一成数组。
 *
 * 宿主给的是 `{ items: [...] }` —— 按数组判会永远拿不到。
 * 2026-10-27 踩到：`Array.isArray(value) ? value : []` 让整个会话列表
 * 静默变成空，看起来像"插件读不到任何会话"。
 *
 * 不同接口用的键不一样（items / sessions / list / rows），全试一遍。
 *
 * @returns {any[]|null}  拿不到返回 null（区别于"确实是空的"）
 */
export function asRows(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return null
  for (const k of ['items', 'sessions', 'list', 'rows']) {
    try {
      if (Array.isArray(raw[k])) return raw[k]
    } catch {
      /* getter 抛错就当没有这个键 */
    }
  }
  return null
}
