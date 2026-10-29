/**
 * routes/agents.mjs —— 人格（agent）的全部接口。
 *
 * 这是 routes.mjs 里最大的一块：列表、归档 / 取消归档、读写文件、
 * 新建、清理幽灵、一键建人格、选人格。
 *
 * 「人格」是**插件自己的概念**，宿主完全不知道（见 docs/MODEL.md 1.5）。
 * 宿主只认 sessionId；「这个会话属于哪个人格」记在 private/agents.json。
 * 所以本文件的核心工作是：把宿主的会话事实 + 我们自己的归属表拼成界面要的形状。
 *
 * 会话活不活的判据**不在这里** —— 全在 lib/domain/session.mjs（MODEL.md 1.4）。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { json, readBody } from './http.mjs'
import { readJson, atomicWrite, withBackup } from '../infra/fs.mjs'
import { sessionControllerOf } from '../infra/host.mjs'
import { readSidebarSessions, readHostSessionSizes, sessionAlive } from '../domain/session.mjs'
import { cleanPath } from '../config.mjs'
import { bootstrapPrompt, personaSkeleton, indexSkeleton } from './text.mjs'

const msg = (err) => String((err && err.message) || err)

/**
 * @param {Function} route       registerRoutes 给的注册函数
 * @param {object}   getRuntime  取运行时
 * @param {object}   paths       derivePaths 的结果
 */
export function registerAgentRoutes(route, { ctx, getRuntime, paths }) {
  route('GET', '/agents', async (_req, res) => {
    const dir = paths.agentsDir
    try {
      const allDirs = existsSync(dir)
        ? readdirSync(dir).filter((n) => {
            try {
              return statSync(join(dir, n)).isDirectory()
            } catch {
              return false
            }
          })
        : []

      /*
       * 分两堆：活的 / 已归档的。
       * 归档目录长这样：`<名字>.archived-20261029-013500`
       * 从名字里把原人格名和归档时间抠出来，界面上才能"取消归档"。
       */
      const list = []
      const archivedAgents = []
      for (const n of allDirs) {
        const m = /^(.*)\.archived-(\d{8}-\d{6})$/.exec(n)
        if (m) {
          archivedAgents.push({ name: m[1], dir: n, at: m[2] })
          continue
        }
        list.push(n)
      }
      archivedAgents.sort((a, b) => (a.name === b.name ? b.at.localeCompare(a.at) : a.name.localeCompare(b.name)))

      /*
       * 每个人格名下有几个会话 —— 设置页「Agent 人格管理」要显示。
       *
       * 口径（重要，不然数字会莫名其妙）：
       *   sessions.total  = private/agents.json 里挂在这个人格下的会话数
       *   sessions.live   = 其中"磁盘上真的有日志目录"的（真聊过）
       *   sessions.ids    = 具体的会话 id 列表（点开能看）
       *
       * 为什么两个数都要给：归属表可能留着早就不存在的会话（删了、
       * 换 profile 了）。只给 total 会让人以为有 5 个活跃会话，
       * 实际可能只有 1 个。
       */
      const table = readJson(paths.ownershipPath, null)
      const ownership = table && typeof table === 'object' && !Array.isArray(table) ? table : {}

      /*
       * 「这个会话还在不在」—— 三条依据，命中任意一条就算还在：
       *   ① 磁盘上有 sessions/<id>/logs（真聊过，日志是硬证据）
       *   ② 登记表里有它，且没被标 missing（宿主上次扫描见过）
       *   ③ 宿主这次列出来了（最权威，但拿不到就跳过）
       *
       * 为什么不全靠宿主：冷启动时 controller.list() 可能拿不到，
       * 那时候把所有会话都判成"不在"会把归属表清空。
       * 所以 ① 和 ② 是保底，只要有一条能证明它存在就不动。
       *
       * 归属表里留着一堆早就不存在的会话（删了、换 profile 了）——
       * 以前界面上显示成"5 个会话"，其实只有 1 个是真的。
       */
      const sidebar = readSidebarSessions()
      const sizes = readHostSessionSizes()
      const aliveOf = (sid) => sessionAlive(sid, sidebar, sizes)

      const byAgent = {}
      const ghosts = []
      const unknown = []
      for (const [sid, agent] of Object.entries(ownership)) {
        const name = typeof agent === 'string' && agent ? agent : ''
        if (!name) continue // 空串 = 显式不要人格，不算任何人的
        const alive = aliveOf(sid)
        if (alive === null) {
          // 拿不到宿主列表：不判死活，只记下来
          unknown.push({ sessionId: String(sid), agent: name })
          continue
        }
        if (!alive) {
          ghosts.push({ sessionId: String(sid), agent: name })
          continue
        }
        if (!byAgent[name]) byAgent[name] = { total: 0, ids: [] }
        byAgent[name].total += 1
        byAgent[name].ids.push(String(sid))
      }

      const agents = list.map((name) => ({
        name,
        sessions: byAgent[name] || { total: 0, ids: [] },
      }))

      json(res, 200, {
        ok: true,
        // 老的 agents 数组留着（别的地方在用），新加 detail
        agents: list,
        detail: agents,
        /** 归属表里留着、但实际上已经不存在的会话 */
        ghosts,
        /** 拿不到宿主列表时，"不知道还在不在"的那些（不误判） */
        unknown,
        /** 已归档的人格（目录还在，只是从列表里移走了） */
        archived: archivedAgents,
        /** 这次有没有读到侧边栏清单 —— false 时 ghosts 不可信 */
        hostListAvailable: sidebar !== null,
        dir: cleanPath(dir),
      })
    } catch (err) {
      json(res, 200, { ok: true, agents: [], dir: cleanPath(dir), error: msg(err) })
    }
  })

  route('GET', '/persona', async (_req, res) => {
    const table = readJson(paths.ownershipPath, null)
    json(res, 200, {
      ok: true,
      ownership: table && typeof table === 'object' && !Array.isArray(table) ? table : {},
      path: cleanPath(paths.ownershipPath),
    })
  })

  route('POST', '/persona', async (req, res) => {
    const body = await readBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    /**
     * 三种意图，必须分开（2026-10-28）：
     *   agentId = 'xiaoyu'  → 用这个人格
     *   agentId = ''        → **显式不要人格**（这一趟当临时会话）
     *   agentId = null      → 清除设置，回到"没设置过"（会走默认人格）
     * 以前 '' 和 null 都当清除，所以"选了不要"下次又冒出默认人格。
     */
    const explicitNone = body.agentId === ''
    const agentId = explicitNone || body.agentId === null ? null : String(body.agentId || '').trim()
    if (!sessionId) {
      json(res, 400, { ok: false, error: '缺 sessionId' })
      return
    }
    if (agentId) {
      const dir = join(paths.agentsDir, agentId)
      if (/[\\/]|\.\./.test(agentId) || !existsSync(dir)) {
        json(res, 400, { ok: false, error: `没有这个人格：${agentId}` })
        return
      }
    }

    const table = readJson(paths.ownershipPath, null)
    const next = table && typeof table === 'object' && !Array.isArray(table) ? { ...table } : {}
    if (agentId) next[sessionId] = agentId
    else if (explicitNone) next[sessionId] = '' // 空串 = 我明说不要
    else delete next[sessionId] // null = 回到没设置

    try {
      withBackup(paths.ownershipPath)
      atomicWrite(paths.ownershipPath, JSON.stringify(next, null, 2) + '\n')
    } catch (err) {
      json(res, 500, { ok: false, error: `写不进 ${paths.ownershipPath}：${msg(err)}` })
      return
    }
    // Inject 每轮都重读这张表，所以不用热挂，下一轮就生效
    json(res, 200, { ok: true, ownership: next, path: cleanPath(paths.ownershipPath) })
  })

  // 清掉"不在了的"登记行（missing === true）。
  // 只删登记的元数据，不碰 logs/ 和 diary/ —— 日志和日记一条都不会少。
  /**
   * 会话列表 —— **直接问宿主**，不拿我们自己的登记表当数据源。
   *
   * 为什么改：登记表只收「有人说过话、且有名字」的会话，
   * 而 DSH 侧边栏里还有一些没对话过的（新建但没说话、只有系统消息）。
   * 拿登记表当列表，那些就显示成「（不在登记表里）」—— 用户看着莫名其妙。
   *
   * 现在：
   *   sessions  = controller.list() 原样返回（侧边栏那个来源）
   *   registry  = 我们的登记表，只用来补「人格/名字/首次见到」这类附加信息
   */
  /* ------------------------------------------------- 人格：新建 / 读 / 写 */

  /**
   * 在资源管理器里打开某个目录。只有后端能起进程，浏览器碰不到本地路径。
   * 路径一律从 paths 派生，不接受前端传任意路径。
   */
  function openInFileManager(dir) {
    try {
      const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
      if (child && typeof child.unref === 'function') child.unref()
      return null
    } catch (err) {
      return msg(err)
    }
  }

  /*
   * 清掉归属表里的幽灵会话。
   *
   * 「幽灵」= private/agents.json 里有它，但：
   *   磁盘上没有 sessions/<id>/logs
   *   登记表里没有，或标了 missing
   *   宿主这次也没列出来
   *
   * 只删归属表那一条记录。日志和日记在磁盘上，一个字节都不动 ——
   * 万一判断错了，把归属加回去就行。
   */
  route('POST', '/agents/prune-ghosts', async (req, res) => {
    const body = await readBody(req)
    const only = typeof body.agent === 'string' ? body.agent.trim() : ''

    const table = readJson(paths.ownershipPath, null)
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      json(res, 200, { ok: true, removed: [], kept: 0, reason: '归属表是空的' })
      return
    }

    const sidebar = readSidebarSessions()
    const sizes = readHostSessionSizes()
    const aliveOf = (sid) => sessionAlive(sid, sidebar, sizes)

    const removed = []
    const next = { ...table }
    for (const [sid, agent] of Object.entries(table)) {
      const name = typeof agent === 'string' ? agent : ''
      if (!name) continue // 空串是"显式不要人格"，不是幽灵，留着
      if (only && name !== only) continue
      const alive = aliveOf(sid)
      if (alive !== false) continue // 在，或者不知道 —— 都不删
      delete next[sid]
      removed.push({ sessionId: String(sid), agent: name })
    }

    if (removed.length > 0) {
      try {
        withBackup(paths.ownershipPath)
        atomicWrite(paths.ownershipPath, JSON.stringify(next, null, 2) + '\n')
      } catch (err) {
        json(res, 500, { ok: false, error: `清不掉：${msg(err)}` })
        return
      }
    }

    json(res, 200, {
      ok: true,
      removed,
      kept: Object.keys(next).length,
    })
  })

  /*
   * 归档一个人格。
   *
   * **不是删除** —— 文件一个都不删：
   *   ① 把 agents/<名字>/ 改名为 agents/<名字>.archived-<时间戳>/
   *   ② 从 private/agents.json 里去掉所有指向它的归属
   *
   * 所以随时能"重启"：把它从归档目录改回来，归属重新选一遍就行。
   * 想彻底删，用户自己去资源管理器删那个归档目录。
   *
   * 为什么不真删：人格目录里有日记（xiaoyu 有 5 篇）、people、经验 ——
   * 都是不可再生的东西。一次误点就全没了，代价太大。
   *
   * body: { agent, confirm } —— confirm 必须等于 agent，防手滑。
   */
  /*
   * 手动触发一轮写日记。
   *
   * 为什么要有：定时器一天只跑一次，出问题的时候没法当场验证。
   * 给个手动入口，把"是不是没生效"变成"立刻看得见"。
   *
   * force = true，忽略"今天已经叫过"。
   *
   * **不给会话打"测试"标记**（2026-10-29 用户定的）：
   * 这个按钮虽然是拿来验证的，但关键时刻也用来真的补写日记。
   * 叫它"测试"，会话就会敷衍 —— 写坏了没关系、随便凑两句。
   * 所以对它来说这就是一次正常的写日记，和到点自动叫没有任何区别。
   *
   * 走的还是**同一个 runOnce**，测的就是真链路。
   */
  route('POST', '/agents/archive', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.agent)
    if (!agentId) {
      json(res, 400, { ok: false, error: '缺 agent（只能是普通目录名）' })
      return
    }
    if (String(body.confirm || '') !== agentId) {
      json(res, 400, { ok: false, error: '确认名和人格名不一致，没删' })
      return
    }
    const dir = join(paths.agentsDir, agentId)
    if (!existsSync(dir)) {
      json(res, 404, { ok: false, error: `没有这个人格：${agentId}` })
      return
    }

    // ① 归属表里去掉它（这个必须先做：失败就不动目录，避免"目录没了但表还指着"）
    let detached = 0
    try {
      const table = readJson(paths.ownershipPath, null)
      if (table && typeof table === 'object' && !Array.isArray(table)) {
        const next = { ...table }
        for (const [sid, who] of Object.entries(next)) {
          if (who === agentId) {
            delete next[sid]
            detached += 1
          }
        }
        if (detached > 0) {
          withBackup(paths.ownershipPath)
          atomicWrite(paths.ownershipPath, JSON.stringify(next, null, 2) + '\n')
        }
      }
    } catch (err) {
      json(res, 500, { ok: false, error: `解绑失败，没敢动目录：${msg(err)}` })
      return
    }

    // ② 目录改名归档
    const pad = (n) => String(n).padStart(2, '0')
    const now = new Date()
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const archived = join(paths.agentsDir, `${agentId}.archived-${stamp}`)
    try {
      renameSync(dir, archived)
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: `归属已解除（${detached} 条），但目录改名失败：${msg(err)}。目录还在原处。`,
        detached,
      })
      return
    }

    json(res, 200, {
      ok: true,
      agent: agentId,
      detached,
      archivedTo: cleanPath(archived),
      note: '文件没删，只是改名归档了。随时可以取消归档。',
    })
  })

  /*
   * 取消归档：把最近一次归档的目录改回来。
   *
   * ⚠️ 只恢复目录，**不恢复会话归属** ——
   * 那些会话现在是无主的，得去会话管理里重新选它。
   * 理由：归档时归属被删掉了，还原时无法确定"哪些会话原来是它的"
   * （除非记一份快照，那就过度设计了）。
   */
  route('POST', '/agents/unarchive', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.agent)
    if (!agentId) {
      json(res, 400, { ok: false, error: '缺 agent' })
      return
    }
    let entries = []
    try {
      entries = readdirSync(paths.agentsDir).filter((n) => n.startsWith(agentId + '.archived-'))
    } catch {
      entries = []
    }
    if (entries.length === 0) {
      json(res, 404, { ok: false, error: `没有「${agentId}」的归档目录` })
      return
    }
    // 取时间戳最新的那个
    entries.sort()
    const latest = entries[entries.length - 1]
    const target = join(paths.agentsDir, agentId)
    if (existsSync(target)) {
      json(res, 409, { ok: false, error: `${agentId} 已经存在了，没法还原` })
      return
    }
    try {
      renameSync(join(paths.agentsDir, latest), target)
    } catch (err) {
      json(res, 500, { ok: false, error: `改不回来：${msg(err)}` })
      return
    }
    json(res, 200, {
      ok: true,
      agent: agentId,
      restoredFrom: cleanPath(join(paths.agentsDir, latest)),
      note: '目录回来了。会话归属**没恢复** —— 那些会话现在是无主的，去会话管理里重新选它。',
    })
  })

  route('POST', '/agents/open', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.agent)
    if (!agentId) {
      json(res, 400, { ok: false, error: '缺 agent' })
      return
    }
    const dir = join(paths.agentsDir, agentId)
    if (!existsSync(dir)) {
      json(res, 404, { ok: false, error: `没有这个目录：${cleanPath(dir)}` })
      return
    }
    const error = openInFileManager(dir)
    if (error) {
      json(res, 500, { ok: false, error, dir: cleanPath(dir) })
      return
    }
    json(res, 200, { ok: true, dir: cleanPath(dir) })
  })

  /** agent id 只认一个普通目录名（不许路径、不许 ..） */
  function safeAgent(id) {
    const s = String(id || '').trim()
    if (!s || /[\\/]|\.\.|^[a-zA-Z]:/.test(s)) return null
    return s
  }

  function personaPath(agentId) {
    return join(paths.agentsDir, agentId, '人格.md')
  }

  // 读一个人格文件全文（设置页的编辑器用）
  route('GET', '/agents/file', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const agentId = safeAgent(url.searchParams.get('agent'))
    if (!agentId) {
      json(res, 400, { ok: false, error: '缺 agent，或者 agent 不是合法目录名' })
      return
    }
    const file = personaPath(agentId)
    try {
      if (!existsSync(file)) {
        json(res, 404, { ok: false, error: `没有这个文件：${cleanPath(file)}` })
        return
      }
      const st = statSync(file)
      json(res, 200, {
        ok: true,
        agent: agentId,
        path: cleanPath(file),
        text: readFileSync(file, 'utf8'),
        mtime: st.mtimeMs,
        size: st.size,
      })
    } catch (err) {
      json(res, 500, { ok: false, error: msg(err) })
    }
  })

  // 写回人格文件：**先备份，再原子写**
  // 设计文档 §5.1 的坑：在页面里编辑 = 直接改"人"，手滑一下就没了
  route('POST', '/agents/file', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.agent)
    if (!agentId) {
      json(res, 400, { ok: false, error: '缺 agent，或者 agent 不是合法目录名' })
      return
    }
    if (typeof body.text !== 'string') {
      json(res, 400, { ok: false, error: '缺 text' })
      return
    }
    const file = personaPath(agentId)
    if (!existsSync(file)) {
      json(res, 404, { ok: false, error: `没有这个文件：${cleanPath(file)}` })
      return
    }
    // 冲突检查：编辑期间文件被别人改了，就别覆盖
    try {
      const now = statSync(file).mtimeMs
      if (typeof body.baseMtime === 'number' && Math.abs(now - body.baseMtime) > 1) {
        json(res, 409, { ok: false, conflict: true, mtime: now, error: '这个文件在你编辑期间被改过，先重新读一遍' })
        return
      }
    } catch {
      /* 读不到时间就不拦（下面写的时候还会出错） */
    }
    let backupPath = null
    try {
      withBackup(file)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = cleanPath(`${file}.bak-${stamp}`)
      atomicWrite(file, body.text)
      const st = statSync(file)
      json(res, 200, { ok: true, agent: agentId, path: cleanPath(file), mtime: st.mtimeMs, backupPath })
    } catch (err) {
      json(res, 500, { ok: false, error: `写不进 ${cleanPath(file)}：${msg(err)}`, backupPath })
    }
  })

/**
   * 一键建立人格：建骨架 → 绑到会话 → 投一条"根据本会话补全自己"的指令。
   *
   * POST /agents/bootstrap  { id, name?, sessionId }
   *   - id 不存在就新建骨架；已存在就复用（不覆盖，避免把写过的东西冲掉）
   *   - 把 sessionId 绑到这个人格（写 private/agents.json）
   *   - 往这个会话投一条 prompt（source: {kind:'cordis-host-runner'}，界面显示成
   *     「插件状态更新」而不是"主人说话"）
   *
   * 投递失败不算建人格失败 —— 骨架和绑定已经落盘，只是没叫醒它，
   * 返回 pushed:false + 原因，让人知道要自己去说一句。
   */
  route('POST', '/agents/bootstrap', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.id)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!agentId) {
      json(res, 400, { ok: false, error: 'id 只能是普通目录名（中英文、数字、- _ 都行，不许带路径）' })
      return
    }
    if (!sessionId) {
      json(res, 400, { ok: false, error: '缺 sessionId：得知道把这个人格绑给哪个会话' })
      return
    }

    const dir = join(paths.agentsDir, agentId)
    const existed = existsSync(dir)
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agentId

    try {
      if (!existed) {
        mkdirSync(dir, { recursive: true })
        mkdirSync(join(dir, 'people'), { recursive: true })
        mkdirSync(join(dir, 'diary'), { recursive: true })
        writeFileSync(join(dir, '人格.md'), personaSkeleton(name), 'utf8')
        writeFileSync(join(dir, 'INDEX.md'), indexSkeleton(name), 'utf8')
        writeFileSync(join(dir, 'MEMORY.md'), `# ${name} · 记忆总览\n\n（还没写）\n`, 'utf8')
        writeFileSync(
          join(dir, '经验.md'),
          `# ${name} · 经验\n\n（自己摔出来的教训写这儿，一条三样：事、教训、现在还算不算数）\n`,
          'utf8',
        )
      }
    } catch (err) {
      json(res, 500, { ok: false, error: `建不出来：${msg(err)}` })
      return
    }

    // 绑定会话 → 人格
    try {
      const table = readJson(paths.ownershipPath, null)
      const next = table && typeof table === 'object' && !Array.isArray(table) ? { ...table } : {}
      next[sessionId] = agentId
      withBackup(paths.ownershipPath)
      atomicWrite(paths.ownershipPath, JSON.stringify(next, null, 2) + '\n')
    } catch (err) {
      json(res, 500, { ok: false, error: `人格建好了但绑不上会话：${msg(err)}` })
      return
    }

    // 叫醒这个会话，让它照着对话补全自己
    let pushed = false
    let pushError = null
    try {
      const controller = sessionControllerOf(ctx)
      if (!controller || typeof controller.prompt !== 'function') {
        pushError = '宿主没有 sessionController，得自己去会话里说一句'
      } else {
        await controller.prompt(
          {
            requestId: `dsh-agent-soul-bootstrap-${agentId}-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: bootstrapPrompt({ agentId, name, sessionId }) }],
          },
          new AbortController().signal,
        )
        pushed = true
      }
    } catch (err) {
      pushError = msg(err)
    }

    json(res, 200, {
      ok: true,
      agent: agentId,
      name,
      existed,
      sessionId,
      pushed,
      pushError,
      dir: cleanPath(dir),
    })
  })

  // 新建人格：给骨架，别给空白页（设计文档 §5.1 第 3 条）
  route('POST', '/agents/new', async (req, res) => {
    const body = await readBody(req)
    const agentId = safeAgent(body.id)
    if (!agentId) {
      json(res, 400, { ok: false, error: 'id 只能是普通目录名（中英文、数字、- _ 都行，不许带路径）' })
      return
    }
    const dir = join(paths.agentsDir, agentId)
    if (existsSync(dir)) {
      json(res, 409, { ok: false, error: `已经有人格叫 ${agentId} 了` })
      return
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agentId
    try {
      mkdirSync(dir, { recursive: true })
      mkdirSync(join(dir, 'people'), { recursive: true })
      mkdirSync(join(dir, 'diary'), { recursive: true })
      writeFileSync(join(dir, '人格.md'), personaSkeleton(name), 'utf8')
      writeFileSync(join(dir, 'INDEX.md'), indexSkeleton(name), 'utf8')
      writeFileSync(join(dir, 'MEMORY.md'), `# ${name} · 记忆总览\n\n（还没写）\n`, 'utf8')
      writeFileSync(join(dir, '经验.md'), `# ${name} · 经验\n\n（自己摔出来的教训写这儿，一条三样：事、教训、现在还算不算数）\n`, 'utf8')
      json(res, 200, { ok: true, agent: agentId, dir: cleanPath(dir), name })
    } catch (err) {
      json(res, 500, { ok: false, error: `建不出来：${msg(err)}` })
    }
  })

}
