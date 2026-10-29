/**
 * config.mjs —— 配置归一化
 *
 * 三件事：
 *   1. 把 profile 里那份可能残缺、写错的 rawConfig 变成一份**一定能用**的配置
 *   2. 所有路径从 rootDir 派生，代码里不出现第二个绝对路径
 *   3. 发现写错不抛异常，只把问题攒进 issues，交给调用方报一次
 *
 * 设计原则：**缺字段 = 默认值，写错 = 默认值 + 报一次**，绝不让插件起不来。
 * （对应任务单 §5「配置写错了不许崩」和 §7 验收第 7 条）
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/*
 * 会话判据统一在 domain/session.mjs —— 这里只**转手导出**，
 * 让老调用方（routes.mjs 等）不用改 import 路径。
 *
 * 不要再把实现写回本文件：两份实现一定会分叉（2026-10-29 踩过，
 * readSidebarSessions 在两个文件里各有一份，sessionAlive 搬过三次）。
 */
export {
  readSidebarSessions,
  readHostSessionSizes,
  sessionAlive,
  EMPTY_SESSION_BYTES,
  readSessionSnapshot,
  aliveIn,
} from './domain/session.mjs'

/**
 * 默认记忆根目录：**不写死某台机器的路径**，按顺序找。
 *
 * 1. 环境变量 `DSH_MEMORY_ROOT`（部署/容器里最省事）
 * 2. 已经存在的老位置 `D:/ProgramData/dsh/memory`（这台机器上就在用，别动它）
 * 3. `$DSH_HOME/memory`，再不行 `~/.dsh/memory` —— 新机器上会自动建
 *
 * 显式配置的 `rootDir` 永远优先，这个函数只在"没配"的时候用。
 */
export function resolveRootDir(env = process.env, exists = existsSync) {
  const clean = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const forced = clean(env.DSH_MEMORY_ROOT)
  if (forced) return forced
  const legacy = 'D:/ProgramData/dsh/memory'
  if (exists(legacy)) return legacy
  const home = clean(env.DSH_HOME) || join(homedir(), '.dsh')
  return `${home}/memory`
}

/** 保留这个名字给老代码/文档用（等价于"现在解析出来的默认值"） */
export const DEFAULT_ROOT = resolveRootDir()

export const DEFAULT_CONFIG = {
  rootDir: DEFAULT_ROOT,
  log: {
    enabled: true,
    /** 默认只给「有人格认领」的会话记日志；false = 所有会话都记 */
    onlyOwned: true,
    sessions: {},
    // 2026-10-28 改：默认**记**。记忆系统的原料就是日志，不记 = 后面全空。
    // （模块自己的默认是 false —— 那是它独立跑的时候定的；插件里有会话登记表兜着。）
    defaults: { log: true },
  },
  inject: {
    enabled: true,
    /** 默认人格：新会话没单独选过时用它。null = 没有默认（临时会话就是空的） */
    defaultAgent: null,
    budget: { total: 2500, persona: 1500, diary: 800, signpost: 200 },
    // manual = B 层「插件说明书」；board = 话板「有新留言」一句
    sections: { manual: true, persona: true, diarySummary: true, signpost: true, board: true },
  },
  tools: {
    enabled: true,
    find: true,
    open: true,
    diary: true,
    recall: true,
    index: true,
  },
  daily: {
    enabled: true,
    /** 每晚几点叫醒 Ta 写日记 */
    time: '23:30',
    /** 当天至少几条对话才算"有料" */
    minLines: 6,
    /** 只给这些人格写日记；null = 所有有人格的会话 */
    agents: null,
  },
  privacy: {
    /**
     * 跨 agent 访问时，能不能弹窗让人放行。
     *
     * false（默认）= 直接拒绝，理由写在错误里 —— 用户能看清为什么被拦。
     * true          = 交给宿主审批弹窗。
     *
     * 为什么默认 false（2026-10-29 真机验证）：
     * 宿主在有 approval 服务、但这轮没有应答者时，会把 ask 变成
     * 「the user rejected tool "xxx"」—— 我们写的理由被吞掉，
     * 用户只会以为是误拦，不知道为什么、也不知道该怎么办。
     * 弹窗能正常工作的环境里，把它改成 true 体验更好。
     */
    allowPrompt: false,
  },
  summary: {
    /**
     * 上下文到多少就写交接总结。0~1 的小数。
     *
     * 为什么是 0.8：压缩（compaction）一般在那之后才触发，
     * 而"我这段干了什么"只有 agent 自己知道 —— 得赶在细节被压掉之前写。
     * 调太低会频繁打断，调太高可能来不及。
     */
    threshold: 0.8,
  },
  sessions: {
    enabled: true,
  },
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const toBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
const toNum = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback)

/**
 * "HH:mm" 校验（带范围）。以前只写了正则，25:99 也会被当合法 ——
 * 结果定时器在 Daily 那边又退回 23:30，用户看到的是"改了没生效"。
 */
export function isHhMm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!m) return false
  const h = Number(m[1])
  const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

/** 统一斜杠，去掉尾部的 /，让 Windows 和 *nix 写出来是一个样子 */
export function cleanPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return s || '/'
}

function pickSection(raw, key, issues) {
  if (raw[key] === undefined) return {}
  if (!isObj(raw[key])) {
    issues.push(new Error(`配置 ${key} 必须是对象，已按默认值处理`))
    return {}
  }
  return raw[key]
}

/**
 * @param {unknown} rawConfig  profile 覆盖块里那份 config（可能为空）
 * @returns {{config: object, issues: Error[], paths: object}}
 */
export function normalizeConfig(rawConfig) {
  const issues = []

  if (rawConfig !== undefined && rawConfig !== null && !isObj(rawConfig)) {
    issues.push(new Error('插件 config 必须是对象，已整份按默认值处理'))
    rawConfig = {}
  }
  const raw = rawConfig || {}

  /* ------------------------------------------------------------------ root */
  let rootDir = typeof DEFAULT_CONFIG.rootDir === 'string' ? DEFAULT_CONFIG.rootDir : DEFAULT_ROOT
  let rootIsDefault = true
  if (typeof raw.rootDir === 'string' && raw.rootDir.trim()) {
    const p = cleanPath(raw.rootDir.trim())
    if (!isAbsolute(p) && !/^[a-zA-Z]:\//.test(p)) {
      issues.push(new Error(`rootDir 不是绝对路径：${raw.rootDir}，已改用默认目录`))
    } else {
      rootDir = p
      rootIsDefault = false
    }
  } else if (raw.rootDir !== undefined) {
    issues.push(new Error('rootDir 必须是字符串，已改用默认目录'))
  }

  /* ------------------------------------------------------------------- log */
  const rawLog = pickSection(raw, 'log', issues)
  const log = {
    enabled: toBool(rawLog.enabled, DEFAULT_CONFIG.log.enabled),
    onlyOwned: toBool(rawLog.onlyOwned, true),
    sessions: {},
    defaults: { log: toBool(isObj(rawLog.defaults) ? rawLog.defaults.log : undefined, DEFAULT_CONFIG.log.defaults.log) },
  }
  if (rawLog.sessions !== undefined) {
    if (!isObj(rawLog.sessions)) {
      issues.push(new Error('log.sessions 必须是对象（会话 id → 设置）'))
    } else {
      for (const [sid, v] of Object.entries(rawLog.sessions)) {
        if (!isObj(v)) {
          issues.push(new Error(`log.sessions.${sid} 必须是对象，已跳过`))
          continue
        }
        const entry = { log: toBool(v.log, false) }
        if (typeof v.dir === 'string' && v.dir.trim()) entry.dir = cleanPath(v.dir.trim())
        log.sessions[sid] = entry
      }
    }
  }
  if (typeof rawLog.enabled !== 'undefined' && typeof rawLog.enabled !== 'boolean') {
    issues.push(new Error('log.enabled 必须是 true/false，已按默认值处理'))
  }

  /* ---------------------------------------------------------------- inject */
  const rawInject = pickSection(raw, 'inject', issues)
  const rawBudget = isObj(rawInject.budget) ? rawInject.budget : {}
  const rawSections = isObj(rawInject.sections) ? rawInject.sections : {}
  if (rawInject.budget !== undefined && !isObj(rawInject.budget)) {
    issues.push(new Error('inject.budget 必须是对象，已按默认值处理'))
  }
  if (rawInject.sections !== undefined && !isObj(rawInject.sections)) {
    issues.push(new Error('inject.sections 必须是对象，已按默认值处理'))
  }
  const inject = {
    enabled: toBool(rawInject.enabled, DEFAULT_CONFIG.inject.enabled),
    defaultAgent: typeof rawInject.defaultAgent === 'string' && rawInject.defaultAgent.trim() ? rawInject.defaultAgent.trim() : null,
    budget: {
      total: toNum(rawBudget.total, DEFAULT_CONFIG.inject.budget.total),
      persona: toNum(rawBudget.persona, DEFAULT_CONFIG.inject.budget.persona),
      diary: toNum(rawBudget.diary, DEFAULT_CONFIG.inject.budget.diary),
      signpost: toNum(rawBudget.signpost, DEFAULT_CONFIG.inject.budget.signpost),
    },
    sections: {
      manual: toBool(rawSections.manual, true),
      persona: toBool(rawSections.persona, true),
      diarySummary: toBool(rawSections.diarySummary, true),
      signpost: toBool(rawSections.signpost, true),
      board: toBool(rawSections.board, true),
    },
  }

  /* ----------------------------------------------------------------- tools */
  const rawTools = pickSection(raw, 'tools', issues)
  if (rawTools.enabled !== undefined && typeof rawTools.enabled !== 'boolean') {
    issues.push(new Error('tools.enabled 必须是 true/false，已按默认值处理'))
  }
  const tools = {
    enabled: toBool(rawTools.enabled, true),
    find: toBool(rawTools.find, true),
    open: toBool(rawTools.open, true),
    diary: toBool(rawTools.diary, true),
    recall: toBool(rawTools.recall, true),
  }
  for (const key of ['find', 'open', 'diary', 'recall']) {
    if (rawTools[key] !== undefined && typeof rawTools[key] !== 'boolean') {
      issues.push(new Error(`tools.${key} 必须是 true/false，已按默认值处理`))
    }
  }

  /* ----------------------------------------------------------------- daily */
  const rawDaily = pickSection(raw, 'daily', issues)
  if (rawDaily.time !== undefined && !isHhMm(rawDaily.time)) {
    issues.push(new Error('daily.time 要写成 HH:mm（例如 23:30），已按默认值处理'))
  }
  const rawPrivacy = isObj(raw.privacy) ? raw.privacy : {}
  const privacy = { allowPrompt: toBool(rawPrivacy.allowPrompt, false) }

  const rawSummary = isObj(raw.summary) ? raw.summary : {}
  const summary = { threshold: 0.8 }
  if (rawSummary.threshold !== undefined) {
    const t = Number(rawSummary.threshold)
    // 只认 0.1 ~ 1 之间的数；越界就退回默认并记一条
    if (!Number.isFinite(t) || t <= 0 || t > 1) {
      issues.push(new Error('summary.threshold 要在 0 和 1 之间（比如 0.8），已退回 0.8'))
    } else {
      summary.threshold = t
    }
  }

  const daily = {
    enabled: toBool(rawDaily.enabled, true),
    time: isHhMm(rawDaily.time) ? String(rawDaily.time).trim() : '23:30',
    minLines: toNum(rawDaily.minLines, 6),
    agents: Array.isArray(rawDaily.agents) ? rawDaily.agents.map(String).filter(Boolean) : null,
    /** 每个会话单独开关：{ [sessionId]: { enabled?: boolean } }，没写就走默认 */
    sessions: {},
  }
  if (rawDaily.sessions !== undefined) {
    if (!isObj(rawDaily.sessions)) {
      issues.push(new Error('daily.sessions 必须是对象（会话 id → 设置）'))
    } else {
      for (const [sid, v] of Object.entries(rawDaily.sessions)) {
        if (!isObj(v)) {
          issues.push(new Error(`daily.sessions.${sid} 必须是对象，已跳过`))
          continue
        }
        daily.sessions[sid] = { enabled: toBool(v.enabled, true) }
      }
    }
  }

  /* -------------------------------------------------------------- sessions */
  const rawSessions = pickSection(raw, 'sessions', issues)
  const sessions = { enabled: toBool(rawSessions.enabled, DEFAULT_CONFIG.sessions.enabled) }

  /* ------------------------------------------------------------------ 派生 */
  const paths = derivePaths(rootDir)

  const config = { rootDir, rootIsDefault, log, inject, tools, daily, privacy, summary, sessions }
  return { config, issues, paths }
}




/** 所有路径只在这里出现一次：改目录结构只改这个函数 */
export function derivePaths(rootDir) {
  const root = cleanPath(rootDir)
  return {
    rootDir: root,
    sessionsDir: join(root, 'sessions').replace(/\\/g, '/'),
    registryPath: join(root, 'system', 'sessions.json').replace(/\\/g, '/'),
    agentsDir: join(root, 'agents').replace(/\\/g, '/'),
    ownershipPath: join(root, 'private', 'agents.json').replace(/\\/g, '/'),
    /** 机器生成，别手改：Log 模块只认配置文件，不认内存里的对象 */
    logConfigPath: join(root, 'system', 'log.config.json').replace(/\\/g, '/'),
    /** 机器生成：Inject 每次 register 都会先去读默认路径，给它一份真的，免得每次报"配置文件不存在" */
    injectConfigPath: join(root, 'system', 'inject.config.json').replace(/\\/g, '/'),
    settingsPath: join(root, 'system', 'settings.json').replace(/\\/g, '/'),
    /** 插件自述：apply 时写了什么、路由挂没挂上、报了什么错。排查只看这一个文件 */
    statusPath: join(root, 'system', 'plugin-status.json').replace(/\\/g, '/'),
    /** 事件流水（只追加）：apply / 路由挂上 / 挂载完成 / 被拆 —— 用来看时序 */
    statusLogPath: join(root, 'system', 'plugin-status.log').replace(/\\/g, '/'),
  }
}

/** 启动时看一眼根目录在不在：不在只报一次，不拦启动（验收第 7 条） */
export function checkRoot(paths) {
  if (existsSync(paths.rootDir)) return null
  return new Error(`记忆根目录不存在：${paths.rootDir}（插件照常启动，但写不进去）`)
}

/** 把插件配置翻译成 Log 模块自己的配置形状 */
export function toLogConfig(config, paths, ownership) {
  const sessions = {}
  const owners = ownership && typeof ownership === 'object' ? ownership : {}
  for (const [sid, entry] of Object.entries(config.log.sessions || {})) {
    const item = { log: entry.log === true }
    if (entry.dir) item.dir = entry.dir
    if (owners[sid]) item.selfName = String(owners[sid])
    sessions[sid] = item
  }
  // 归属表里的会话也带上 selfName，哪怕页面上没点过日志开关 ——
  // 图纸 §3.7：助手说话记的是"会话自己的名字"，别写死 assistant
  for (const [sid, agent] of Object.entries(owners)) {
    if (!agent) continue
    sessions[sid] = { ...(sessions[sid] || {}), selfName: String(agent) }
  }
  /*
   * 「默认记」对谁生效：
   *   onlyOwned !== false（默认）→ 只对「有人格认领」的会话默认记
   *   onlyOwned === false        → 所有会话默认记
   *
   * Log 模块的规则是：sessions[sid].log 有就用它，没有就用 defaults.log。
   * 所以「有人格但没单独设过」的会话，这里显式写 log:true；
   * 「没人格的」保持不写，靠 defaults 决定（默认记时也不该记）。
   */
  const defaultLog = config.log.defaults?.log === true
  const onlyOwned = config.log.onlyOwned !== false
  if (defaultLog) {
    for (const [sid, agent] of Object.entries(owners)) {
      if (!agent) continue // 显式"不要人格"的空串，跳过
      if (onlyOwned && !agent) continue
      const cur = sessions[sid] || {}
      if (cur.log === undefined) sessions[sid] = { ...cur, log: true }
    }
    if (!onlyOwned) {
      // 所有会话都记：defaults 打开即可，上面那圈只是补齐 selfName
    }
  }
  return {
    enabled: config.log.enabled !== false,
    baseDir: paths.sessionsDir,
    selfName: 'assistant',
    ownerMid: '',
    ownerName: 'tianhai',
    defaultRole: 'tianhai',
    sessions,
    // onlyOwned 时，没人格的会话不许靠 defaults 漏记
    defaults: { log: onlyOwned ? false : defaultLog },
  }
}

/** 读人定的归属表（`private/agents.json`）：会话 id → agent 名。读不到就是空表 */
export function readOwnership(paths) {
  try {
    if (!paths || !paths.ownershipPath || !existsSync(paths.ownershipPath)) return {}
    const data = JSON.parse(readFileSync(paths.ownershipPath, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out = {}
    for (const [sid, agent] of Object.entries(data)) {
      if (typeof agent === 'string' && agent.trim()) out[sid] = agent.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** 把插件配置翻译成 Inject 模块自己的配置形状 */
export function toInjectConfig(config) {
  return {
    enabled: config.inject.enabled !== false,
    budget: { ...config.inject.budget },
    sections: { ...config.inject.sections },
    persona: { includeFirstSection: true, repeat: 'first-turn' },
    // 说明书要如实说"你现在手上是哪几个工具"，所以工具开关得传过去
    tools: { ...(config.tools || {}) },
    rootDir: config.rootDir,
    // 默认人格：没单独选过的会话用它；显式"不要"的会话仍然空着（注入器认得 agents.json 里的空串）
    fallbackAgent: (config.inject && config.inject.defaultAgent) || null,
  }
}

/** 给日记任务（Daily）的配置 */
export function toDailyConfig(config) {
  const d = config.daily || {}
  const sessions = {}
  for (const [sid, v] of Object.entries(d.sessions || {})) {
    sessions[sid] = { enabled: v && v.enabled !== false }
  }
  return {
    enabled: d.enabled !== false,
    time: d.time || '23:30',
    minLines: Number.isFinite(d.minLines) ? d.minLines : 6,
    agents: Array.isArray(d.agents) && d.agents.length ? d.agents.slice() : null,
    /** 每会话开关：false = 这个会话不写日记 */
    sessions,
  }
}

/** 给工具区（Search）的配置 */
export function toToolsConfig(config) {
  const t = config.tools || {}
  return {
    enabled: t.enabled !== false,
    find: t.find !== false,
    open: t.open !== false,
    diary: t.diary !== false,
    recall: t.recall !== false,
    index: t.index !== false,
  }
}
