/**
 * routes/sessions.mjs —— 会话列表 + 登记表清理。
 *
 * 两块都是"把宿主的事实翻译成界面能用的形状"：
 *   GET  /sessions        有哪些会话、各自叫什么
 *   POST /registry/prune  把不在的从登记表里删掉
 *
 * ⚠️ 这里最容易错的一件事：**会话集合有三个，别混用**（见 docs/MODEL.md 1.2）
 *     ① 磁盘全部  ② 宿主 list()  ③ 侧边栏可见
 *   给用户看的列表必须用 ③，否则会出现"显示 141 个但用户只看得见 77 个"。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { json } from './http.mjs'
import { readJson, atomicWrite, withBackup } from '../infra/fs.mjs'
import { sessionControllerOf, sessionTitleOf, sessionsOf } from '../infra/host.mjs'
import { readSidebarSessions, sessionAlive, readHostSessionSizes, asRows } from '../domain/session.mjs'
import { cleanPath } from '../config.mjs'

const msg = (err) => String((err && err.message) || err)
/**
 * 把 sessionController.list() 的返回值统一成数组。
 * 宿主给的是 `{ items: [...] }`，不是数组 —— 按数组判会永远拿不到。
 */
/**
 * 读 DSH 的会话标题缓存。
 *
 * 为什么必须读这个文件：`sessionController.list()` 的返回值里**没有标题**
 * （只有 sessionId / updatedAt / blank / running / origin / cwd）。
 * `sessionTitle.get()` 又要一个**已加载的 Session 对象**，冷会话没有。
 *
 * DSH 侧边栏显示的标题来自这里：
 *   ~/.dsh/storages/session_projcache.json
 *     → tables.sessions[<id>].rows.title.val
 * 我们读同一份，名字就能对上。
 *
 * 只读，不改。读不到就返回空表（名字留空，不影响其它功能）。
 *
 * @returns {Map<string,string>} sessionId → title
 */

/**
 * 从我们自己记的日志里，捞这个会话的第一句**人话**当名字。
 *
 * 为什么需要：DSH 的标题是"用 LLM 生成的"，很多老会话从来没生成过，
 * 于是 sessionController / projcache / useSessions 三处都拿不到 title，
 * 界面上只能显示 uuid。我们手里有日志，第一句人话通常比 uuid 好认。
 *
 * 只读 sessions/<id>/logs/*.jsonl，取第一条 role 是人的。
 *
 * @param {string} sessionsDir
 * @param {string} sid
 * @returns {string} 没有就返回 ''
 */
function firstHumanLine(sessionsDir, sid) {
  try {
    const dir = join(String(sessionsDir), String(sid), 'logs')
    if (!existsSync(dir)) return ''
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let rec
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        // 只认人说的：插件自己投的 prompt 不算（role 可能是 agent 名）
        const role = String(rec.role || '')
        if (!role || role === 'assistant') continue
        if (rec.from === 'plugin' || rec.plugin === true) continue
        const body = String(rec.text || '').trim()
        if (!body) continue
        // 系统那种一长串带换行的元信息跳过
        if (body.includes('Time sampled while preparing turn')) continue
        const oneLine = body.split('\n')[0].trim()
        if (!oneLine) continue
        return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine
      }
    }
  } catch {
    /* 读不到就算了，名字留空 */
  }
  return ''
}

function readTitleCache() {
  const out = new Map()
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    if (!home) return out
    const file = join(home, '.dsh', 'storages', 'session_projcache.json')
    if (!existsSync(file)) return out
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const table = raw && raw.tables && raw.tables.sessions
    if (!table || typeof table !== 'object') return out
    for (const [sid, row] of Object.entries(table)) {
      try {
        const t = row && row.rows && row.rows.title && row.rows.title.val
        if (typeof t === 'string' && t.trim()) out.set(String(sid), t.trim())
      } catch {
        /* 单条坏掉不影响整体 */
      }
    }
  } catch {
    /* 缓存读不到就当没有标题 */
  }
  return out
}





/**
 * @param {Function} route      registerRoutes 给的注册函数
 * @param {object}   ctx        host context
 * @param {object}   paths      derivePaths 的结果
 */
export function registerSessionRoutes(route, { ctx, paths }) {
  route('POST', '/registry/prune', async (_req, res) => {
    const reg = readJson(paths.registryPath, null)
    if (!reg || typeof reg !== 'object' || !reg.sessions) {
      json(res, 200, { ok: true, removed: 0, left: 0 })
      return
    }
    const keep = {}
    let removed = 0
    for (const [sid, row] of Object.entries(reg.sessions)) {
      if (row && row.missing === true) {
        removed += 1
        continue
      }
      keep[sid] = row
    }
    if (removed) {
      try {
        atomicWrite(
          paths.registryPath,
          JSON.stringify({ ...reg, updated: new Date().toISOString(), sessions: keep }, null, 2) + '\n',
        )
      } catch (err) {
        json(res, 500, { ok: false, error: `写不进 ${cleanPath(paths.registryPath)}：${msg(err)}` })
        return
      }
    }
    json(res, 200, { ok: true, removed, left: Object.keys(keep).length, path: cleanPath(paths.registryPath) })
  })

  route('GET', '/sessions', async (_req, res) => {
    const registry = readJson(paths.registryPath, null)
    const rows = []

    // ① 宿主会话列表（权威）
    const controller = sessionControllerOf(ctx)
    if (controller && typeof controller.list === 'function') {
      try {
        // ⚠️ 别叫 rows：外面那个 rows 才是要返回的数组，同名会把 push 打到自己身上
        const fromHost = asRows(await controller.list())
        if (fromHost) {
          for (const it of fromHost) {
            const sid = String((it && it.sessionId) || '')
            if (!sid) continue
            rows.push({
              id: sid,
              blank: it.blank === true,
              running: it.running === true,
              origin: it.origin || null,
              parentSessionId: it.parentSessionId || null,
              updatedAt: typeof it.updatedAt === 'number' ? it.updatedAt : null,
              cwd: it.cwd || null,
            })
          }
        }
      } catch (err) {
        // 拿不到就说清楚，别假装没有会话
        json(res, 200, {
          ok: false,
          error: `拿不到宿主会话列表：${msg(err)}`,
          sessions: [],
          registry,
          path: cleanPath(paths.registryPath),
        })
        return
      }
    } else {
      json(res, 200, {
        ok: false,
        error: '宿主没有 sessionController，列不出会话',
        sessions: [],
        registry,
        path: cleanPath(paths.registryPath),
      })
      return
    }

    // ② 名字：sessionTitle 服务（DSH 侧边栏也是这么拿的）
    const titles = sessionTitleOf(ctx)
    const stores = sessionsOf(ctx)
    // DSH 侧边栏的名字来源（冷会话也在里面）
    const cached = readTitleCache()
    /*
     * 只保留"侧边栏里真的能点到的会话"。
     * 不这么做的后果：宿主 list() 给 128 条，侧边栏只显示 100 条，
     * 多出来的 28 条在 UI 上没有任何入口 —— 看着像幽灵。
     * 读不到工作区清单就不过滤（宁可多露）。
     */
    const inWorkspace = readSidebarSessions()
    if (inWorkspace) {
      const kept = rows.filter((r) => inWorkspace.has(String(r.id)))
      rows.length = 0
      rows.push(...kept)
    }

    for (const row of rows) {
      let title = ''
      // ① 活的会话：问标题服务
      try {
        if (titles && typeof titles.get === 'function' && stores && typeof stores.get === 'function') {
          const sess = stores.get(row.id)
          if (sess) {
            const snap = titles.get(sess)
            if (snap && typeof snap.title === 'string') title = snap.title.trim()
          }
        }
      } catch {
        /* 取不到不影响列表 */
      }
      // ② 冷会话：读 DSH 自己的标题缓存（跟侧边栏一模一样）
      if (!title) title = cached.get(row.id) || ''
      // ③ 登记表里记过的（之前扫描时从一个有名字的来源拿到的）
      if (!title) {
        const reg = registry && registry.sessions && registry.sessions[row.id]
        if (reg && typeof reg.name === 'string') title = reg.name
      }
      // ④ 还是没有 → 从我们自己的日志捞第一句人话（总比 uuid 好认）
      if (!title) title = firstHumanLine(paths.sessionsDir, row.id)
      row.name = title
      // 标记：我们自己的登记表里有没有它（决定人格等附加信息可不可读）
      row.registered = Boolean(registry && registry.sessions && registry.sessions[row.id])
    }

    json(res, 200, {
      ok: true,
      sessions: rows,
      registry,
      path: cleanPath(paths.registryPath),
    })
  })
}
