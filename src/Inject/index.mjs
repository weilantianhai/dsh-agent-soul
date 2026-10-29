/**
 * index.mjs —— 入口：register / buildInjection / status
 *
 * 只干一件事：**每轮开场，把该让她知道的东西塞进系统提示。**
 * 只有三段：人格摘要、最近一篇日记的总结、一句路标。多一样都不给。
 *
 * 钩子契约（照 dsh-meme/index.js 的写法）：
 *   ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
 *     const assembled = await next()      // 必须先 next，拿到别人组装好的
 *     ...push...
 *     return assembled
 *   })
 *
 * 三个坑都避开了：
 *   ① push 在 await next() 之后；② 关了直接 return assembled（同一个对象，不新建）；
 *   ③ context.agent.session 拿不到就报一次 onError，不静默。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveAgentId,
  readPersona,
  personaText,
  readDiary,
  diaryTrail,
  buildSignpost,
} from './assemble.mjs'
import { buildManual } from './manual.mjs'
import { readBoard, boardHint } from './board.mjs'
import { applyBudget, chars, DEFAULT_LIMITS } from './budget.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = join(MODULE_DIR, 'config.json')

export const DEFAULT_CONFIG = {
  enabled: true,
  budget: { ...DEFAULT_LIMITS },
  sections: { manual: true, persona: true, diarySummary: true, signpost: true, board: true },
  persona: { includeFirstSection: true, repeat: 'first-turn' },
  tools: { enabled: true, find: true, open: true, diary: true, recall: true, index: true },
  /**
   * 记忆根目录。**这里刻意留空** —— 不能写死某台机器的路径。
   *
   * 实际运行时主插件一定会传（`toInjectConfig` 里带 `config.rootDir`），
   * 这里只是"万一没传"的兜底。写死 `D:/ProgramData/...` 的话，
   * 别人装上、配置漏传，就会往**我的**目录里写人格和日记。
   *
   * @see lib/config.mjs 的 resolveRootDir —— 那边才是权威解析
   */
  rootDir: '',
  fallbackAgent: null,
}

/** 运行态。只给 status 看，不当状态传给别人 */
const state = {
  config: null,
  enabled: false,
  lastChars: 0,
  lastSections: [],
  lastAgentId: null,
  lastAt: null,
  lastError: null,
  injected: 0,
  /** 已经在"第一轮"里给过完整人格的会话（人格上半不重复付钱） */
  /*
   * 会话 → 上一次注入时用的是哪个人格。
   *
   * 为什么不是 Set（2026-10-28 tianhai 发现）：
   * 原来只记"这个会话见过没有"。中途换人格时，会话早被标成"见过"，
   * **人格段永远不再注入** —— 它不知道自己换了个人。
   * 现在记"上次见的是谁"：人格一变就重新给全量。
   *
   * 值：'agentId' / ''（显式不要人格）/ 没有这个 key = 从没注入过
   */
  seenSessions: new Map(),
  /** 每个 agent 上次看到话板有几条留言 */
  boardSeen: new Map(),
}

const safeReport = (onError, err) => {
  const e = err instanceof Error ? err : new Error(String(err))
  state.lastError = String(e.message || e)
  if (typeof onError === 'function') {
    try {
      onError(e)
    } catch {
      /* 回调自己炸了，不能让注入停 */
    }
  }
}

/** 读配置。读不到就用默认值，并把原因报出去 */
export function loadConfig(configPath, onError) {
  const path = configPath || DEFAULT_CONFIG_PATH
  if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG, enabled: false }, path, error: `配置文件不存在：${path}` }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是一个 JSON 对象')
    return {
      config: {
        ...DEFAULT_CONFIG,
        ...parsed,
        budget: { ...DEFAULT_CONFIG.budget, ...(parsed.budget || {}) },
        sections: { ...DEFAULT_CONFIG.sections, ...(parsed.sections || {}) },
      },
      path,
      error: null,
    }
  } catch (err) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      path,
      error: `配置文件读不了（${path}）：${err.message}`,
    }
  }
}

/** 从 context 里挖出"谁在用这个钩子" */
/**
 * 从 assemble 的 context 里抠会话 id。
 *
 * 宿主契约（@deepseek-ai/dsh-agent 的 assembleContextFor）：
 *   { agent, scope: agent, signal? }
 * 会话 id = `agent.session.id`。
 *
 * ⚠️ `Session.id` 是 **getter**。旧写法 `typeof v[k] === 'string'` 直接读，
 * 一旦 getter 抛错就带崩整条链 —— 真机上表现为每轮都报
 * "拿不到 context.agent.session，这一轮不注入"。
 * 现在每一项单独 try，任何一环炸了只影响它自己。
 *
 * @param {object} context
 * @returns {string|null}
 */
export function sessionIdOf(context) {
  const readKey = (obj, k) => {
    try {
      const v = obj[k]
      return typeof v === 'string' && v ? v : null
    } catch {
      return null
    }
  }
  const pickId = (v) => {
    if (!v) return null
    if (typeof v === 'string') return v || null
    if (typeof v !== 'object') return null
    for (const k of ['id', 'sessionId', 'key']) {
      const got = readKey(v, k)
      if (got) return got
    }
    return null
  }
  const safe = (fn) => {
    try {
      return fn()
    } catch {
      return null
    }
  }

  return (
    safe(() => pickId(context && context.agent && context.agent.session)) ||
    safe(() => pickId(context && context.scope)) ||
    safe(() => pickId(context && context.agent)) ||
    safe(() => pickId(context && context.session)) ||
    null
  )
}

/**
 * 把 assemble context 的形状压成一句话，写进错误信息。
 *
 * 为什么需要：真机上一直报"拿不到 context.agent.session"，而按宿主源码那字段是有的。
 * 与其继续猜，不如失败时把实际形状记下来 —— 下一次报错就直接能看到答案。
 */
export function describeContext(context) {
  const seen = (label, fn) => {
    try {
      const v = fn()
      if (v === undefined) return label + '=undefined'
      if (v === null) return label + '=null'
      if (typeof v === 'string') return label + '="' + v + '"'
      return label + '=' + typeof v
    } catch (e) {
      return label + '=THREW(' + String((e && e.message) || e) + ')'
    }
  }
  return [
    seen('context', () => context),
    seen('context.agent', () => context && context.agent),
    seen('context.agent.session', () => context && context.agent && context.agent.session),
    seen('context.agent.session.id', () => context && context.agent && context.agent.session && context.agent.session.id),
    seen('context.scope', () => context && context.scope),
    seen('context.session', () => context && context.session),
  ].join(' ')
}

/**
 * 只拼不塞。测试不用起 DSH 就能调。
 * @param {object} context  DSH 的 system-prompt/assemble context
 * @param {object} [opts]   { config, configPath, onError }
 * @returns {Promise<{text:string, sections:Array<{name:string,chars:number}>, chars:number, agentId:string|null, sessionId:string|null, cuts:string[], over:boolean, disabled?:boolean}>}
 */
export async function buildInjection(context, opts = {}) {
  const onError = opts.onError
  let cfg = opts.config ?? state.config
  if (!cfg) {
    const loaded = loadConfig(opts.configPath, onError)
    cfg = loaded.config
    if (loaded.error) safeReport(onError, new Error(loaded.error))
  }
  const empty = { text: '', sections: [], chars: 0, agentId: null, sessionId: null, cuts: [], over: false }

  // 关了就把嘴闭上，一个字不塞，也不报错
  if (cfg.enabled === false) return { ...empty, disabled: true }

  const sessionId = sessionIdOf(context)
  const rootDir = cfg.rootDir || DEFAULT_CONFIG.rootDir

  /*
   * 根目录拿不到就**这一轮不注入**，不要退到相对路径。
   *
   * 为什么：`join('', 'agents', x)` 得到的是 `agents/x` —— 相对当前工作目录。
   * 那等于往"不知道哪里"写人格和日记，比不注入严重得多。
   * 正常运行时主插件一定会传 rootDir，走到这里说明配置链路漏了。
   */
  if (!rootDir) {
    safeReport(onError, new Error('没拿到记忆根目录（rootDir），这一轮不注入 —— 请检查配置'))
    return empty
  }

  if (!sessionId) {
    safeReport(
      onError,
      new Error(`拿不到会话 id，这一轮不注入。context 形状：${describeContext(context)}`),
    )
    return empty
  }

  const { agentId, source } = resolveAgentId({
    sessionId,
    rootDir,
    fallbackAgent: cfg.fallbackAgent,
  })

  if (!agentId) {
    // 「显式不要人格」不是错误 —— 人明说了这一趟不要，别报警
    if (source === 'agents.json:none') return { ...empty, sessionId, agentSource: source }
    safeReport(
      onError,
      new Error(
        `会话 ${sessionId} 找不到对应的 agent 目录（查了 private/agents.json 和 system/sessions.json），这一轮不注入`,
      ),
    )
    return { ...empty, sessionId }
  }

  const agentDir = join(rootDir, 'agents', agentId)
  const want = cfg.sections || {}
  const wantRepeat = cfg.persona?.repeat === 'every-turn' ? 'every-turn' : 'first-turn'
  // 第一轮给完整人格上半；之后只给一句路径提醒（设计文档 §3.3）
  const firstTurn = opts.firstTurn !== false
  const giveFullPersona = wantRepeat === 'every-turn' || firstTurn

  // —— B 层：插件说明书（不预算、不许砍，跟着开关走）
  const manual = want.manual === false ? '' : buildManual({ agentId, tools: cfg.tools, memoryRoot: rootDir })

  // —— 人格摘要
  let persona = ''
  let redline = ''
  let personaFile = null
  if (want.persona !== false) {
    const p = readPersona(agentDir)
    if (p) {
      personaFile = p.file
      redline = p.redline
      persona = giveFullPersona
        ? personaText({ ...p, includeFirstSection: cfg.persona?.includeFirstSection !== false })
        : personaReminder({ agentId, memoryRoot: rootDir })
    } else {
      safeReport(onError, new Error(`agent ${agentId} 没人格文件（${join(agentDir, '人格.md')}），这一段不塞`))
    }
  }

  // —— 日记总结（没有就不塞，不报错）
  let diary = ''
  let diarySource = null
  if (want.diarySummary !== false) {
    const d = readDiary({ agentDir, sessionId })
    if (d) {
      diary = `${d.text}\n${diaryTrail({ memoryRoot: rootDir, agentId, diary: d })}`
      diarySource = d.source
    }
  }

  // —— 路标
  let signpost = ''
  if (want.signpost !== false) signpost = buildSignpost({ memoryRoot: rootDir, agentId })

  // —— 话板：只给"有新留言"一句，不给内容（没有新的就一个字都不给）
  let boardNote = ''
  if (want.board !== false) {
    const b = readBoard(rootDir)
    if (b.error) safeReport(onError, new Error(b.error))
    else {
      const seen = Number.isFinite(opts.boardSeen) ? opts.boardSeen : state.boardSeen.get(agentId) ?? 0
      boardNote = boardHint({ board: b, seen })
      if (!Number.isFinite(opts.boardSeen) && b.ok) state.boardSeen.set(agentId, b.count)
    }
  }

  // —— 预算
  const out = applyBudget({
    persona,
    redline,
    diary,
    signpost,
    limits: cfg.budget,
    onCut: (reason) => safeReport(onError, new Error(`注入超预算：${reason}`)),
  })

  const parts = []
  const sections = []
  if (manual) {
    parts.push(manual)
    sections.push({ name: 'manual', chars: chars(manual) })
  }
  if (out.persona) {
    parts.push(out.persona)
    sections.push({ name: 'persona', chars: chars(out.persona), from: personaFile, firstTurn: giveFullPersona })
  }
  if (out.diary) {
    parts.push(`最近的日记：\n${out.diary}`)
    sections.push({ name: 'diarySummary', chars: chars(out.diary), from: diarySource })
  }
  if (out.signpost) {
    parts.push(out.signpost)
    sections.push({ name: 'signpost', chars: chars(out.signpost) })
  }
  if (boardNote) {
    parts.push(boardNote)
    sections.push({ name: 'board', chars: chars(boardNote) })
  }

  const text = parts.join('\n\n')
  const total = chars(text)
  const manualChars = chars(manual)
  const cChars = total - manualChars

  state.lastChars = total
  state.lastSections = sections.map((s) => s.name)
  state.lastAgentId = agentId
  state.lastAt = new Date().toISOString()
  if (text) state.injected += 1

  return {
    text,
    sections,
    chars: total,
    // B 层（说明书）不占 C 层的预算：它不进 applyBudget，也不许砍
    manualChars,
    cChars,
    agentId,
    agentSource: source,
    sessionId,
    firstTurn: giveFullPersona,
    cuts: out.cuts,
    over: out.over,
  }
}

/**
 * 后续轮次只贴这一句：人格下半在哪儿、要不要自己翻。
 *
 * 设计文档 §3.3 的理由：上半是"不用想就知道"的（我是谁、什么不能做），
 * 下半是"要看才记得"的（怎么接话、口味）。下半天天用不着，每轮贴就是白付钱。
 */
export function personaReminder({ agentId, memoryRoot } = {}) {
  const root = String(memoryRoot || DEFAULT_CONFIG.rootDir).replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = root ? `${root}/agents/${agentId}/人格.md` : `agents/${agentId}/人格.md`
  return `你的人格在 ${rel}（常驻部分这一轮没重复贴）。怎么说话、口味、评论区规矩在下半，要用的自己翻。`
}

/**
 * 挂钩子。返回 dispose。
 * @param {object} ctx  要能 ctx.on
 * @param {object} [opts] { configPath, config, onError }
 * @returns {() => void}
 */
export function register(ctx, opts = {}) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('register 需要 ctx.on')

  const { config, error } = loadConfig(opts.configPath, opts.onError)
  state.config = opts.config ? { ...DEFAULT_CONFIG, ...opts.config } : config
  state.enabled = state.config.enabled !== false
  if (error) safeReport(opts.onError, new Error(error))

  const handler = async (_assembly, context, next) => {
    // ⚠️ 必须先 next()：别跟别的插件抢位置
    const assembled = await next()
    // ⚠️ 关了要原样交回去（同一个对象），不能 return undefined
    if (state.config.enabled === false) return assembled

    try {
      const sid = sessionIdOf(context)

      /*
       * 「要不要给完整人格段」的判定，必须在拼之前做完。
       *
       * 为什么不能等 buildInjection 回来再判（2026-10-28 tianhai 发现）：
       * 原来是「这个会话见过没有」——一旦见过就永远不再注人格段。
       * 中途换了人格的会话，根本不知道自己换了个人。
       *
       * 现在：先解析这次该用谁，再跟上次记下的比。
       *   从没注入过           → 给全量
       *   上次是 A，这次是 B    → 给全量（它换了人）
       *   上次是 A，这次还是 A  → 省略（省字数）
       */
      const head = sid
        ? resolveAgentId({
            sessionId: sid,
            rootDir: state.config.rootDir,
            fallbackAgent: state.config.fallbackAgent,
          })
        : { agentId: null, source: 'no-session' }
      const nowAgent = head.agentId ? String(head.agentId) : ''
      const seen = sid ? state.seenSessions.get(sid) : undefined
      const firstTurn = seen === undefined || seen !== nowAgent

      const out = await buildInjection(context, { config: state.config, onError: opts.onError, firstTurn })

      if (out?.text) {
        assembled.sections.push({ name: 'memory:inject', text: out.text })
      }
      if (sid) state.seenSessions.set(sid, nowAgent)
    } catch (err) {
      // 注入崩了不能带崩对话
      safeReport(opts.onError, err)
    }
    return assembled
  }

  const off = ctx.on('system-prompt/assemble', handler)
  return () => {
    try {
      if (typeof off === 'function') off()
    } catch {
      /* 解绑失败不影响退出 */
    }
  }
}

/** @returns {{enabled:boolean, lastChars:number, lastSections:string[]}} */
export function status() {
  return {
    enabled: state.enabled,
    lastChars: state.lastChars,
    lastSections: [...state.lastSections],
    lastAgentId: state.lastAgentId,
    lastAt: state.lastAt,
    lastError: state.lastError,
    injected: state.injected,
  }
}

/** 测试用：把运行态清干净 */
export function reset() {
  state.config = null
  state.enabled = false
  state.lastChars = 0
  state.lastSections = []
  state.lastAgentId = null
  state.lastAt = null
  state.lastError = null
  state.injected = 0
  state.seenSessions.clear()
  state.boardSeen.clear()
}

