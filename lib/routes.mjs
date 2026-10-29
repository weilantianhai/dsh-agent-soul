/**
 * routes.mjs —— 设置页的宿主半边（HTTP 接口）
 *
 * 页面在浏览器里，读不到文件；所以配置、人格归属、会话登记表都由这里暴露成
 * 本机接口。**只认回环**，并且写操作一律过信任栅栏（拿不到栅栏就拒）。
 *
 * 路由前缀 /dsh-agent-soul/api：
 *   GET  status            现在各块是开是关、有没有报错
 *   GET  config            当前生效的配置 + 路径
 *   POST config            改配置（落 settings.json，能热挂就热挂）
 *   GET  agents            agents/ 下有哪些人格
 *   GET  persona           当前会话 → 人格 的归属表
 *   POST persona           给某个会话选人格（写 private/agents.json，立刻生效）
 *   GET  sessions          system/sessions.json 原文（只读预览）
 *   GET  board             shared/board.md 预览（只读）
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanPath, normalizeConfig, readSidebarSessions, readHostSessionSizes, sessionAlive } from './config.mjs'
/*
 * 文件读写统一在 infra/fs.mjs，宿主服务统一在 infra/host.mjs。
 * 本文件不再自己实现这些 —— 两份实现一定会分叉。
 */
import { readJson, atomicWrite, withBackup } from './infra/fs.mjs'
import { json, isLoopback, fence, readBody, MAX_BODY } from './routes/http.mjs'
import { registerBoardRoutes } from './routes/board.mjs'
import { registerDailyRoutes } from './routes/daily.mjs'
import { registerSessionRoutes } from './routes/sessions.mjs'
import { registerAgentRoutes } from './routes/agents.mjs'
import { readPrompt, findPackageRoot } from './routes/prompt-file.mjs'
import { sessionControllerOf, sessionTitleOf, sessionsOf, webServerOf, connectionOf } from './infra/host.mjs'

/*
 * 骨架生成是纯函数（输入字符串、输出字符串，不碰文件不碰 ctx），
 * 单独放在 routes/text.mjs。这里继续转手导出，老调用方不用改。
 */
import { bootstrapPrompt, personaSkeleton, indexSkeleton } from './routes/text.mjs'
export { bootstrapPrompt, personaSkeleton, indexSkeleton }

export { readSidebarSessions }

const PREFIX = '/dsh-agent-soul/api'

const msg = (err) => String((err && err.message) || err)


/** 读 settings.json 里那份"页面改过的配置" */
export function readSettings(paths) {
  const data = readJson(paths.settingsPath, null)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null
}

/**
 * 深合并：只认几块已知配置，别的键原样不丢。
 *
 * ⚠️ 2026-10-28 修：这里原来只列了 `log` / `inject`。
 * 设置页后来加了「工具」和「日记」，保存时它们**被静默丢掉** ——
 * 表现就是"改了『几点叫』，点保存又变回 23:30"。
 * 新加配置块时，**这里必须一起加**。
 */
const MERGE_SECTIONS = ['log', 'inject', 'tools', 'daily', 'privacy', 'summary', 'sessions']

export function mergeSettings(base, overrides) {
  const out = { ...base }
  if (!overrides || typeof overrides !== 'object') return out
  if (typeof overrides.rootDir === 'string' && overrides.rootDir) out.rootDir = overrides.rootDir
  for (const section of MERGE_SECTIONS) {
    const src = overrides[section]
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue
    const target = { ...(out[section] || {}) }
    for (const [k, v] of Object.entries(src)) {
      // 嵌套对象合一层；数组整体替换（daily.agents 这种是列表，不是字典）
      if (v && typeof v === 'object' && !Array.isArray(v)) target[k] = { ...(target[k] || {}), ...v }
      else target[k] = v
    }
    out[section] = target
  }
  return out
}

export function registerRoutes(ctx, { getRuntime, paths, onError, remount, remountRoot }) {
  // 正常路径是 ctx.webServer（apply 已经等它就绪）；再留一条 ctx.get 的退路，
  // 免得哪天宿主把服务换个挂法，设置页整块消失。
  const webServer = webServerOf(ctx)
  if (!webServer || typeof webServer.register !== 'function') {
    onError?.(new Error('webServer 不可用：设置页接口没挂上（其余功能不受影响）'))
    return () => {}
  }

  const guard = fence(ctx)
  const disposers = []

  /**
   * ⚠️ 同一路径的 GET / POST 必须**合成一次注册**。
   * 宿主若"首个匹配即终止"，同一个 path 注册两次会让后注册的 POST 永远收不到。
   *
   * 支持两种写法：route(path, { GET, POST }) 或 route('GET', path, handler)；
   * 后者第二次出现时只往同一份表里补方法，不重复注册。
   */
  const byPath = new Map()

  function route(a, b, c) {
    const path = typeof b === 'string' ? b : a
    const table = byPath.get(path) || {}

    if (typeof b === 'string') {
      table[a] = c
    } else {
      Object.assign(table, b)
    }
    byPath.set(path, table)

    if (table.__registered) return
    table.__registered = true

    try {
      const off = webServer.register({
        kind: 'exact',
        path: PREFIX + path,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          const method = req.method === 'HEAD' ? 'GET' : req.method
          const fn = table[method]
          if (typeof fn !== 'function') {
            const allowed = Object.keys(table).filter((k) => !k.startsWith('__'))
            json(res, 405, { ok: false, error: `只接受 ${allowed.join(' / ')}` })
            return
          }
          try {
            await fn(req, res)
          } catch (err) {
            json(res, 500, { ok: false, error: msg(err) })
          }
        },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      onError?.(new Error(`路由挂不上（${path}）：${msg(err)}`))
    }
  }

  /* ── 人格与 agent 文件 ── */
  registerAgentRoutes(route, { ctx, getRuntime, paths })

  /* ── 会话：列表 / 登记表清理 ── */
  registerSessionRoutes(route, { ctx, paths })

  /* ── 日记：手动触发一轮 ── */
  registerDailyRoutes(route, { getRuntime })

  /* ── 话板：读 / 在资源管理器里打开 ── */
  registerBoardRoutes(route, { paths })

  route('GET', '/status', async (_req, res) => {
    const rt = getRuntime()
    json(res, 200, {
      ok: true,
      startedAt: rt.startedAt,
      parts: rt.parts,
      rootDir: rt.paths?.rootDir ?? null,
      lastError: rt.lastError,
      errors: rt.errors.slice(-10),
    })
  })

  route('GET', '/config', async (_req, res) => {
    const rt = getRuntime()
    json(res, 200, { ok: true, config: rt.config, paths: rt.paths })
  })

  /*
   * 改数据目录（rootDir）。
   *
   * 这是唯一一个会**动 paths** 的操作 —— 改完之后，人格、日记、日志、
   * 登记表全部换地方。所以：
   *   ① 先验新目录可用（能建、能写、不是文件）
   *   ② 明确告诉调用方「旧数据不会自动搬过来」
   *   ③ 重新 derivePaths，用新 paths 重新挂载
   *
   * body: { rootDir, migrate?: boolean }
   *   migrate=true  旧目录的内容复制到新目录（不删旧数据）
   *   migrate=false 只管换目录，旧数据留在原处
   */
  route('POST', '/config/root', async (req, res) => {
    const body = await readBody(req)
    const rt = getRuntime()
    /*
     * 读运行时的 paths，不是闭包里那份。
     * 换过一次目录之后，闭包里的 paths 已经过期 —— 用它判断"是不是同一个目录"
     * 会永远拿老目录比，于是换第二次时误判成没变。
     */
    const cur = (rt && rt.paths) || paths

    const raw = typeof body.rootDir === 'string' ? body.rootDir.trim() : ''
    if (!raw) {
      json(res, 400, { ok: false, error: '缺 rootDir' })
      return
    }
    const next = cleanPath(raw)
    if (!isAbsolute(next) && !/^[a-zA-Z]:\//.test(next)) {
      json(res, 400, { ok: false, error: `必须是绝对路径：${raw}` })
      return
    }
    if (next === cur.rootDir) {
      json(res, 200, { ok: true, changed: false, rootDir: next, note: '就是这个目录，没变' })
      return
    }

    /* ① 验新目录可用 */
    try {
      mkdirSync(next, { recursive: true })
      const probe = join(next, '.write-probe')
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
    } catch (err) {
      json(res, 400, { ok: false, error: `新目录不能用：${msg(err)}` })
      return
    }

    /* ② 可选：把旧数据复制过来（**不删**旧目录） */
    let migrated = false
    let migrateError = null
    if (body.migrate === true) {
      try {
        cpSync(cur.rootDir, next, { recursive: true, force: false, errorOnExist: false })
        migrated = true
      } catch (err) {
        migrateError = msg(err)
      }
    }

    /* ③ 落盘 + 用新 paths 重挂 */
    const nextConfig = { ...(rt && rt.config ? rt.config : {}), rootDir: next, rootIsDefault: false }
    let hot = false
    let hotError = null
    try {
      await remountRoot(nextConfig, next)
      hot = true
    } catch (err) {
      hotError = msg(err)
      onError?.(new Error(`数据目录已改，但重挂失败：${hotError}`))
    }

    json(res, 200, {
      ok: true,
      changed: true,
      rootDir: next,
      previous: cur.rootDir,
      migrated,
      migrateError,
      hot,
      hotError,
      note: migrated ? '旧数据已复制到新目录（原目录没删）' : '旧数据留在原目录，没动',
    })
  })

  route('POST', '/config', async (req, res) => {
    const body = await readBody(req)
    // 以「现在生效的配置」为底，而不是以 settings.json 为底 ——
    // 否则页面只改一项时，会把 rootDir 这类没在页面上的字段一起丢了。
    const rt = getRuntime()
    const base = rt && rt.config ? rt.config : readSettings(paths) || {}
    const merged = mergeSettings(base, body && body.config ? body.config : body)
    // rootDir 不在页面上改（改了就得动 paths，得重启），所以也不落盘 ——
    // 否则以后改 profile 的 rootDir 会被这份旧值盖住，"换台机器只改一处"就失效了。
    const toSave = { ...merged }
    delete toSave.rootDir
    delete toSave.rootIsDefault
    try {
      atomicWrite(paths.settingsPath, JSON.stringify(toSave, null, 2) + '\n')
    } catch (err) {
      json(res, 500, { ok: false, error: `写不进 ${paths.settingsPath}：${msg(err)}` })
      return
    }

    // 热挂：失败不算保存失败，只是要重启才生效
    let hot = false
    let hotError = null
    try {
      const { config } = normalizeConfig(merged)
      await remount(config)
      hot = true
    } catch (err) {
      hotError = msg(err)
      onError?.(new Error(`配置已保存，但热挂失败：${hotError}`))
    }
    json(res, 200, { ok: true, saved: true, hot, hotError, settingsPath: paths.settingsPath })
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const off of disposers.reverse()) {
      try {
        off()
      } catch {
        /* 忽略 */
      }
    }
  }
  // 给诊断用：这次到底挂上了几条
  dispose.count = disposers.length
  return dispose
}

/* ------------------------------------------------------------------ 骨架 */

/**
 * 「一键开始」时投给这个会话的指令。
 *
 * 思路（tianhai 定的）：不是让用户在设置页里一条条填，而是先建骨架，
 * 再把「根据你自己的对话内容，把人格/记忆补全」这条任务交给会话本身 ——
 * 它最清楚自己跟主人聊过什么。
 *
 * 指令只做三件事：说清要写哪几个文件、写什么、不许编。
 */
