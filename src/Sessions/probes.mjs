/**
 * probes.mjs —— 取数三条路 + 兜底
 *
 * 只跟 DSH 运行时打交道，不认登记表、不写文件。
 *
 *   活会话：ctx.agents.list() → agent.session.id
 *   名字  ：ctx.sessions.get(sid) → ctx.sessionTitle.get(s)
 *   归档  ：路一 ctx.get('workspaceRegistry').archivedSessionIds
 *           路二 读 .dsh/storages/workspace.json 的 global.archivedSessionIds
 *
 * ⚠ 最要紧的一条：**归档名单拿不到时不许静默当成「没有归档」**。
 *   dsh-fish-memory 原来 `catch { return new Set() }`，结果 11 条归档会话变幽灵。
 *   这里改成：known=false 交回去，调用方负责报警 + 宁可多露。
 *
 * 这个文件不 import 任何别的模块 —— 要能单独拿走、单独测。
 */

import { existsSync, readFileSync } from 'node:fs'

/*
 * 侧边栏可见集统一在 lib/domain/session.mjs —— 这里转手导出，
 * 原本这里有一份几乎一样的实现（逻辑一致、注释不同），已经删掉。
 */
import { readSidebarSessions, asRows } from '../../lib/domain/session.mjs'
export { asRows }
export { readSidebarSessions }
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 把 sessionController.list() 的返回值统一成数组。
 *
 * 宿主返回的是 `{ items: [...] }`，不是数组 —— 我们三处都按数组判，
 * 于是永远走 else 分支，一条会话都拿不到（真机：「会话管理还是空的」）。
 * 这里同时容忍：数组 / {items} / {sessions} / 其它可迭代。
 *
 * @param {unknown} raw
 * @returns {Array|null} 拿不到返回 null（调用方据此报警，不静默当空）
 */


/** agent.session 上可能叫这些名字（DSH 各版本不一样） */
const SESSION_ID_KEYS = ['id', 'sessionId', 'key', 'sessionKey', 'sid']

/** `session-` 前缀可能只出现在一侧，比对时抹掉 */
const BARE_PREFIX = /^session-/

const msg = (err) => String((err && err.message) || err)

const bare = (x) => String(x).replace(BARE_PREFIX, '')

/** 从一组键里抠一个非空字符串 */
function pickId(obj) {
  for (const k of SESSION_ID_KEYS) {
    try {
      const v = obj[k]
      if (typeof v === 'string' && v) return v
    } catch {
      /* 某个键的 getter 抛错就当没有这个键 */
    }
  }
  return ''
}

/**
 * 从一个对象上抠出会话 id。抠不到返回 ''。
 *
 * 两种形状都认：
 *   - DSH 现行（2026-10-28 核对过宿主类型）：`Agent` 就是 `{ id }`，`Session` 有 `get id()`
 *   - 早期/别的实现：id 挂在 `agent.session.id` 下面
 * @param {object} session
 * @returns {string}
 */
export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return ''
  const direct = pickId(session)
  if (direct) return direct
  let nested
  try {
    nested = session.session
  } catch {
    return ''
  }
  if (nested && typeof nested === 'object') return pickId(nested)
  return ''
}

/** 可选地取一个宿主服务：ctx.get 优先，其次直接读属性；拿不到返回 null */
function serviceOf(ctx, name) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(name)
      if (v !== undefined && v !== null) return v
    }
  } catch {
    /* 服务访问器抛错（没 inject 过）就当没有 */
  }
  try {
    const v = ctx[name]
    if (v !== undefined && v !== null) return v
  } catch {
    /* 同上 */
  }
  return null
}

/** DSH 自己的存储目录：`$DSH_HOME` 或 `~/.dsh` */
export function dshHome() {
  const home = process.env.DSH_HOME
  return home && String(home).trim() ? String(home).trim() : join(homedir(), '.dsh')
}

/** 归档名单兜底文件路径 */
export function defaultWorkspacePath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/**
 * 扫活着的会话。
 *
 * 2026-10-28 真机踩到的坑：以前只走 `ctx.agents.list()`，再读 `agent.session.id`。
 * 但宿主给的 `Agent` 就是 `{ id }`（类型里就一个字段），**没有 `.session`** ——
 * 于是每个 agent 都"抠不出 id"，登记表一直是空的，而且只报 warning 不报错，
 * 从外面看就是"表里什么都没有"。
 *
 * 现在的取数顺序：
 *   1. `ctx.sessions.list()` —— 会话店，`Session.id` 一定在，最直接
 *   2. `ctx.agents.list()`   —— 活的 agent，`Agent.id` 就是会话 id
 *   3. `opts.includeIds`     —— 补录
 * 两路都拿不到才算致命错误；某一路返回 0 条是正常的（刚启动时本来就没人）。
 *
 * @param {object} ctx              DSH 宿主上下文
 * @param {object} [opts]
 * @param {string[]} [opts.includeIds] 额外的会话 id（一般用不上，测试/补录时用）
 * @returns {{ list: {id:string,name:string}[], errors: string[], warnings: string[] }}
 *   errors   —— 致命：两条取数路都不可用
 *   warnings —— 不致命：名字取不到之类，不影响这条会话进表
 */
/**
 * 扫活着的会话。
 *
 * 2026-10-28 真机踩到的坑：以前只走 `ctx.agents.list()`，再读 `agent.session.id`。
 * 但宿主给的 `Agent` 就是 `{ id }`（类型里就一个字段），**没有 `.session`** ——
 * 于是每个 agent 都"抠不出 id"，登记表一直是空的。
 *
 * 2026-10-28 晚些时候（第二次）：表里堆了 100 条，大半是插件自己开的工作会话
 * （`sticker-review-*` 之类），而且一堆没名字。所以取数改成**以 DSH 自己的会话列表为准**：
 *
 *   0. `ctx.sessionController.list()` —— **侧边栏就是从这儿来的**，可见集合
 *   1. `ctx.sessions.list()` —— 活着的会话（有 Session 对象，能读到标题/第一句话）
 *   2. `opts.includeIds`     —— 补录
 *
 * 进表的门槛（任何一条不满足就不进）：
 *   - 在可见集合里（有 controller 时）
 *   - 不是 blank（一条 prompt 都没有）、不是子代理、不是别人的子会话
 *   - **有名字**：标题 → 第一条「人说的」消息 → 旧名字。一个字都没有的，不进表
 *
 * 注：2026-10-28 把 `ctx.agents.list()` 那条老路删了 ——
 * 现在的宿主有 sessionController + sessions 两路，够用；那条路只会把
 * 插件自己开的 agent 会话也扫进来。**要兼容更老的 DSH 再加回来，别默默留着。**
 *
 * @param {object} ctx              DSH 宿主上下文
 * @param {object} [opts]
 * @param {string[]} [opts.includeIds] 额外的会话 id（一般用不上，测试/补录时用）
 * @param {Map<string,object>} [opts.visibility] 测试注入：可见集合
 * @returns {Promise<{ list: {id:string,name:string}[], errors: string[], warnings: string[] }>}
 */
export async function probeLiveSessions(ctx, opts = {}) {
  const errors = []
  const warnings = []
  const list = []
  const seen = new Set()

  const push = (id, name) => {
    const sid = String(id)
    const i = list.findIndex((x) => x.id === sid)
    if (i >= 0) {
      // 同一条会话被列了两次：只补空名字，不改已有的
      if (!list[i].name && name) list[i].name = name
      return
    }
    if (seen.has(sid)) return
    seen.add(sid)
    list.push({ id: sid, name: name || '' })
  }

  /** 可见集合里这条会话能不能进表 */
  const visibilitySkip = (sid, visible) => {
    if (!visible) return ''
    const v = visible.get(sid)
    if (!v) return '不在 DSH 的可见会话列表里'
    // blank（一条消息都没有）**不挡**：侧边栏里有它，这里也得有
    // 但子代理 / 子会话仍然挡掉，那不是"用户能点的会话"
    if (v.origin === 'subagent') return '是子代理会话'
    if (v.parentSessionId) return '是别的会话的子会话'
    return ''
  }

  if (!ctx) {
    errors.push('活会话：ctx 是空的，这次扫不到任何会话')
  } else {
    // 0) 可见集合：DSH 侧边栏的取数口
    let visible = opts.visibility || null
    if (!visible) {
      const controller = serviceOf(ctx, 'sessionController')
      if (controller && typeof controller.list === 'function') {
        try {
          const items = await controller.list()
          const rows = asRows(items)
          if (rows) {
            visible = new Map()
            for (const it of rows) {
              const sid = sessionIdOf(it)
              if (sid) visible.set(sid, it)
            }
          } else {
            warnings.push('可见会话：sessionController.list() 没返回数组，本次按"全可见"处理')
          }
        } catch (err) {
          warnings.push(`可见会话：sessionController.list() 抛错（按全可见处理）→ ${msg(err)}`)
        }
      }
    }

    const store = serviceOf(ctx, 'sessions')
    let anySource = false

    /*
     * ── 路零：sessionController.list() —— **持久化的全部会话** ──
     *
     * 为什么不只靠下面的 ctx.sessions.list()：
     * 那个是 **内存里的活会话**（源码写着 "All live sessions"）。
     * 插件刚启动时一个 Agent 都没恢复，于是返回空数组 ——
     * 真机上表现为「这次一个会话都没扫到，但表里原有 8 个」。
     * sessionController.list() 是从磁盘读的，侧边栏用的就是它，冷启动也有。
     */
    const controller = serviceOf(ctx, 'sessionController')
    if (controller && typeof controller.list === 'function') {
      anySource = true
      try {
        const rows = asRows(await controller.list())
        // 只留侧边栏里能点到的（读不到清单就不过滤）
        const inWs = readSidebarSessions()
        if (rows) {
          for (const it of rows) {
            const sid = String((it && it.sessionId) || '')
            if (!sid) continue
            if (inWs && !inWs.has(sid)) continue
            if (visibilitySkip(sid, visible)) continue
            // 子代理 / 子会话不是"用户能点的会话"，一律不进（跟路一同一个判断）
            if (it && it.origin === 'subagent') continue
            if (it && it.parentSessionId) continue
            /*
             * 名字：sessionController 给没给 → 标题服务 → 第一条人话。
             * **没名字也照收** —— 设置页的会话列表要跟 DSH 侧边栏一致，
             * 没说过话的会话也得能配人格、能设开关。
             */
            const name =
              (it && typeof it.title === 'string' && it.title.trim()) || nameOf(ctx, sid, warnings) || ''
            push(sid, name)
          }
        } else {
          warnings.push('持久会话：sessionController.list() 没返回数组')
        }
      } catch (err) {
        warnings.push(`持久会话：sessionController.list() 抛错 → ${msg(err)}`)
      }
    }

    /* ── 路一：会话店（内存中的活会话，补名字/补新开的） ── */
    if (store && typeof store.list === 'function') {
      anySource = true
      try {
        const raw = store.list()
        if (Array.isArray(raw)) {
          for (const s of raw) {
            const sid = sessionIdOf(s)
            if (!sid) {
              warnings.push('活会话：ctx.sessions.list() 里有个会话抠不出 id，已跳过')
              continue
            }
            const why = visibilitySkip(sid, visible) || skipReason(s)
            if (why) {
              warnings.push(`活会话：${sid} ${why}，没进登记表`)
              continue
            }
            const name = nameOf(ctx, sid, warnings, s)
            if (!name && opts.requireName) {
              warnings.push(`活会话：${sid} 没有标题也没人说过话，不进表`)
              continue
            }
            push(sid, name)
          }
        } else {
          errors.push(`活会话：ctx.sessions.list() 没返回数组（是 ${typeof raw}）`)
        }
      } catch (err) {
        errors.push(`活会话：ctx.sessions.list() 抛错 → ${msg(err)}`)
      }
    }

    if (!anySource) {
      errors.push('活会话：ctx.sessions.list 不可用，这次扫不到任何会话')
    }
  }

  for (const id of opts.includeIds || []) {
    if (id) push(id, nameOf(ctx, String(id), warnings))
  }

  return { list, errors, warnings }
}

/**
 * 会话标题。取不到不算错 —— 名字读不到就留空，界面显示 id 片段，比瞎编一个名字强。
 * 但也不能完全没痕迹，所以记进 warnings。
 */
function nameOf(ctx, sid, warnings, known) {
  try {
    const store = serviceOf(ctx, 'sessions')
    const s = known || (store && typeof store.get === 'function' ? store.get(sid) : null)
    if (!s) return ''
    // sessionTitle.get() 要的是 Session 对象，不是 id
    const titles = serviceOf(ctx, 'sessionTitle')
    if (titles && typeof titles.get === 'function') {
      const snap = titles.get(s)
      const title = snap && snap.title ? String(snap.title).trim() : ''
      if (title) return title
    }
    // 还没有标题（没生成 / 没足够的输入）→ 拿第一句人话当名字，
    // 总比在设置页里显示一串 uuid 强
    return firstUserText(s)
  } catch (err) {
    warnings.push(`标题：取不到 ${sid} 的标题 → ${msg(err)}`)
    return ''
  }
}

/**
 * 会话里的第一条**人说的**消息，压成一行、截短 —— 只用来当显示名。
 *
 * 插件自己发的 prompt（表情审核、定时叫醒、系统提示）也算 user/message，
 * 但 source.kind 不是 'user' / 'user-rpc'。拿那种话当名字，表里就会长出一堆
 * "你是 WeChatAgent 表情池维护器…" —— 所以这里只认人说的话。
 */
export function firstUserText(session) {
  let events = []
  try {
    if (session && typeof session.ownEvents === 'function') events = session.ownEvents() || []
    else if (session && typeof session.snapshotEvents === 'function') events = session.snapshotEvents() || []
  } catch {
    return ''
  }
  const HUMAN = new Set(['user', 'user-rpc', ''])
  for (const ev of events) {
    if (!ev || ev.type !== 'user/message') continue
    const data = ev.data || {}
    const kind = String((data.source && data.source.kind) || '')
    if (!HUMAN.has(kind)) continue
    const content = data.content ?? data.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
    }
    const one = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^#+\s*/, '')
      .trim()
    if (one) return one.length > 24 ? `${one.slice(0, 23)}…` : one
  }
  return ''
}

/**
 * 这条会话该不该进登记表。
 *
 * 2026-10-28：设置页里堆了一堆没名字的 id —— 原因是把**子代理会话**和
 * **刚建出来还没人说话的空白会话**都登记了。它们不是"人的对话"，
 * 留着只会把登记表撑成一串 uuid。
 */
export function skipReason(session) {
  try {
    const origin = session && session.header && session.header.origin
    if (origin === 'subagent') return '是子代理会话'
  } catch {
    /* 读不到 header 就当普通会话 */
  }
  try {
    if (session && typeof session.seq === 'number' && session.seq === 0) return '还没有任何消息（空白会话）'
  } catch {
    /* 读不到 seq 就不判空 */
  }
  return ''
}

/**
 * 归档名单。两条路，先服务、后文件。
 *
 * @param {object} ctx
 * @param {object} [opts]
 * @param {string} [opts.workspacePath] 兜底文件路径（默认 ~/.dsh/storages/workspace.json）
 * @returns {{ ids:Set<string>, bare:Set<string>, known:boolean, source:'service'|'file'|null, notes:string[] }}
 *   known=false 时 ids 是**空的**，调用方绝不能把它当成「没有归档」
 */
export function probeArchived(ctx, opts = {}) {
  const notes = []
  const ids = new Set()
  const bareIds = new Set()

  const take = (arr, kind, label) => {
    for (const x of arr) {
      if (x === null || x === undefined || x === '') continue
      ids.add(String(x))
      bareIds.add(bare(x))
    }
    notes.push(`归档名单：从${label}拿到 ${ids.size} 个`)
    return { ids, bare: bareIds, known: true, source: kind, notes }
  }

  // ── 路一：问运行时（首选，实时） ────────────────────────────
  try {
    if (!ctx || typeof ctx.get !== 'function') {
      notes.push('归档名单路一：ctx.get 不可用（宿主没给 workspaceRegistry）')
    } else {
      const wr = ctx.get('workspaceRegistry')
      if (wr === undefined || wr === null) {
        notes.push('归档名单路一：ctx.get("workspaceRegistry") 是空的')
      } else {
        const arr = wr.archivedSessionIds
        if (Array.isArray(arr)) return take(arr, 'service', '服务')
        notes.push(`归档名单路一：archivedSessionIds 不是数组，是 ${typeof arr}`)
      }
    }
  } catch (err) {
    notes.push(`归档名单路一抛错 → ${msg(err)}`)
  }

  // ── 路二：读 DSH 自己的存储文件（同一份数据，格式稳定） ──────
  const path = opts.workspacePath || defaultWorkspacePath()
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    const arr = j && j.global && j.global.archivedSessionIds
    if (Array.isArray(arr)) return take(arr, 'file', `存储文件 ${path}`)
    notes.push(`归档名单路二：${path} 里没有 global.archivedSessionIds`)
  } catch (err) {
    notes.push(`归档名单路二：读 ${path} 失败 → ${msg(err)}`)
  }

  notes.push('归档名单：两条路都拿不到，本次 archivedKnown=false（不是「没有归档」）')
  return { ids, bare: bareIds, known: false, source: null, notes }
}

/**
 * 这条会话归档了没有。
 * 归档名单里可能写 `session-xxx`，agent 上报的是 `xxx`，两边都认。
 */
export function isArchivedId(archive, sid) {
  if (!archive || !archive.ids || !sid) return false
  const s = String(sid)
  if (archive.ids.has(s)) return true
  return archive.bare ? archive.bare.has(bare(s)) : false
}
