/**
 * helpers.mjs —— 测试用的假宿主
 *
 * 不装 DSH 也能把 apply() 跑起来：给一个最小的 ctx、一棵临时 memory 树、
 * 一对假的 req/res，就能验钩子和接口。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import assert from 'node:assert/strict'

/**
 * 假宿主。
 *
 * 2026-10-28 起对齐真机形状（照着宿主自己的类型核对过）：
 *   - `ctx.on(...)` 一个事件可以挂**多个**监听（cordis 就是这样；以前这里一个名字只留最后一个，
 *     结果 Log 和 Sessions 都监听 session/event 时会互相顶掉）
 *   - `ctx.sessions.list()` → `Session[]`，`Session.id`
 *   - `ctx.agents.list()`   → `Agent[]`，`Agent` 只有 `{ id }`，**没有 `.session`**
 *   - `ctx.sessionTitle.get(session)` → `{ title }`
 */
export function makeCtx({ webServer = true, effect = true, connection = true, sessions = [], agents = [] } = {}) {
  const listeners = new Map() // name -> Set<fn>
  const routes = []
  const effects = []
  const logs = []

  const on = (name, fn) => {
    let set = listeners.get(name)
    if (!set) {
      set = new Set()
      listeners.set(name, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) listeners.delete(name)
    }
  }

  const emit = (name, ...args) => {
    let result
    for (const fn of [...(listeners.get(name) || [])]) {
      const r = fn(...args)
      // waterfall 类事件（system-prompt/assemble）要看返回值，最后一个说了算
      if (r !== undefined) result = r
    }
    return result
  }

  const listenerCount = () => {
    let n = 0
    for (const set of listeners.values()) n += set.size
    return n
  }

  /**
   * 兼容老测试的 `ctx.handlers.get(name)(...)` 写法：按事件名取，
   * 但拿到的是一个"把这次事件发给所有监听"的调度器；
   * size 数的是监听个数（不然多监听会被掩盖）。
   */
  const handlers = {
    has: (name) => listeners.has(name),
    get: (name) => (listeners.has(name) ? (...args) => emit(name, ...args) : undefined),
    get size() {
      return listenerCount()
    },
    keys: () => listeners.keys(),
  }

  const controllerItems = []
  const prompts = []
  const sessionController = {
    list: async () => controllerItems.slice(),
    prompt: async (req, source) => {
      prompts.push({ ...req, __source: source })
      return { accepted: true }
    },
  }

  const toolsRegistered = []
  const toolsService = {
    register(def) {
      toolsRegistered.push(def)
      return () => {
        const i = toolsRegistered.indexOf(def)
        if (i >= 0) toolsRegistered.splice(i, 1)
      }
    },
  }

  const sessionStore = {
    list: () => sessions,
    get: (id) => sessions.find((s) => String(s.id) === String(id)),
  }
  const agentStore = { list: () => agents, get: (id) => agents.find((a) => String(a.id) === String(id)) }
  const titleStore = { get: (session) => (session && session.title ? { title: session.title } : undefined) }

  const ctx = {
    handlers,
    routes,
    effects,
    logs,
    listeners,
    toolsRegistered,
    emit,
    on,
    get(name) {
      if (name === 'connection' && connection) return { requestRejection: () => false }
      if (name === 'sessions') return sessionStore
      if (name === 'agents') return agentStore
      if (name === 'sessionTitle') return titleStore
      if (name === 'tools') return toolsService
      if (name === 'sessionController') return sessionController
      return undefined
    },
    sessions: sessionStore,
    agents: agentStore,
    sessionTitle: titleStore,
    tools: toolsService,
    sessionController,
    prompts,
    controllerItems,
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
  }

/**
   * 造一条"活会话"：真机上 agent 只有 id，标题挂在会话上。
   * extra 可以带 { header, seq, events } —— 子代理会话、空白会话、没标题的会话都靠它造。
   */
  ctx.newSession = (id, title, extra = {}) => {
    const session = { id, title, ...extra }
    if (Array.isArray(extra.events) && typeof session.ownEvents !== 'function') {
      session.ownEvents = () => extra.events
    }
    sessions.push(session)
    agents.push({ id })
    /*
     * 默认视图：这条会话在 DSH 的会话列表里是可见的。
     * sessionController.list() 的真实返回里会带 origin / parentSessionId，
     * 这里要跟着带上 —— 否则"子代理要挡掉"这条就测不出来。
     */
    if (!extra.hidden) {
      controllerItems.push({
        sessionId: id,
        blank: false,
        updatedAt: Date.now(),
        ...(extra.header && extra.header.origin ? { origin: extra.header.origin } : {}),
        ...(extra.header && extra.header.parentSessionId
          ? { parentSessionId: extra.header.parentSessionId }
          : {}),
      })
    }
    return session
  }

  if (effect) {
    ctx.effect = (fn) => {
      effects.push(fn)
      return () => {}
    }
  }
  if (webServer) {
    ctx.webServer = {
      register(route) {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    }
  }
  return ctx
}

export function makeTree(dir) {
  rmSync(dir, { recursive: true, force: true })
  for (const d of ['agents/xiaoyu/diary/bili-whale', 'private', 'system', 'shared', 'sessions']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(
    join(dir, 'agents/xiaoyu/人格.md'),
    ['# 小鱼', '', '## 一、你是谁', '你叫小鱼，住在 DSH 里。', '', '---', '', '## 三、怎么说话', '短句。', '', '## 十二、红线', '不编。', ''].join('\n'),
  )
  writeFileSync(
    join(dir, 'agents/xiaoyu/diary/bili-whale/2026-10-27.md'),
    ['# 2026-10-27', '', '## 总结', '今天把三个模块拼成了一个插件。', ''].join('\n'),
  )
  writeFileSync(join(dir, 'private/agents.json'), JSON.stringify({ 'bili-whale': 'xiaoyu' }, null, 2))
  writeFileSync(join(dir, 'shared/board.md'), '# 话板\n')
  return dir
}

export function fakeReq(method, body, { host = '127.0.0.1:63104' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

export function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(text) {
      this.body = text || ''
    },
  }
}

/**
 * apply 一个插件，然后返回快照。
 *
 * apply 本身**不返回任何值** —— cordis 把返回值当成 effect，返回普通对象会被判
 * `TypeError: Invalid effect` 并立刻把插件拆掉（见 lib/index.js 末尾的长注释）。
 * 所以这里顺手把这条契约钉死在测试里：返回值不是 undefined 就直接失败。
 */
export async function applyPlugin(mod, ctx, config) {
  const returned = await mod.apply(ctx, config)
  assert.equal(returned, undefined, `apply 不能返回值（宿主会当 effect 拆插件），实际返回 ${typeof returned}`)
  return mod.status()
}

export async function call(route, method, body, opts) {
  const req = fakeReq(method, body, opts)
  const res = fakeRes()
  await route.handler(req, res)
  return { code: res.statusCode, data: res.body ? JSON.parse(res.body) : null }
}

export function routeOf(ctx, path) {
  return ctx.routes.find((r) => r.path === `/dsh-agent-soul/api${path}`)
}

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
