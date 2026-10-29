/**
 * index.mjs —— 工具区：给 LLM 的四只手
 *
 * 依据 `private/projects/design-tools-daily-prompt.md` §一。
 *
 *   > 它真正的作用是：让 agent 能伸手去够自己的记忆。没有这只手，
 *   > 记忆就是一堆躺在硬盘上的文件，她只能凭印象说话 —— 那就是编。
 *
 * 四个工具，各管一头（**用法写在 schema 里，不写在系统提示里**）：
 *
 *   memory_find    按关键词 + 类型找，给 id 和一句摘要
 *   memory_open    打开一本，读全文
 *   memory_diary   按日期读日记，只给「总结」
 *   memory_recall  查某天的原始对话 —— **只在写日记前拿稿子、或回查时用**
 *
 * 三条硬规矩：
 *   1. 只读当前 agent 自己的目录（别人的碰不到）
 *   2. 不写任何文件
 *   3. 读不到就明说，不许编
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentForSession, sessionsOfAgent } from './paths.mjs'
import { findMemory, openMemory, readDiary, readTranscript } from './read.mjs'

const msg = (err) => String((err && err.message) || err)

export const DEFAULT_CONFIG = {
  enabled: true,
  find: true,
  open: true,
  diary: true,
  recall: true,
}

/** 工具名 → 开关字段 */
export const TOOL_KEYS = {
  memory_find: 'find',
  memory_open: 'open',
  memory_diary: 'diary',
  memory_recall: 'recall',
  memory_index: 'index',
}

/** 一段文本就是工具的全部输出（够用，不搞花卡片） */
const textOutput = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
}

/* ------------------------------------------------------------------ 格式化 */

export function formatFind(result) {
  if (!result.ok) return result.error
  if (!result.hits.length) return `没找到「${result.query}」。换个词试试，或者去问清楚再查 —— 别凭印象编。`
  const lines = [`找到 ${result.hits.length} 条（${result.agent}）：`, '']
  for (const h of result.hits) lines.push(`- \`${h.id}\` · 第 ${h.line} 行：${h.excerpt}`)
  lines.push('', '想看全文用 `memory_open`，把 id 传进去。')
  return lines.join('\n')
}

export function formatOpen(result) {
  if (!result.ok) return result.error
  const head = `# ${result.id}（${result.chars} 字${result.truncated ? '，已截断' : ''}）`
  return `${head}\n\n${result.text}`
}

export function formatDiary(result) {
  if (!result.ok) return result.error
  if (!result.entries.length) return '最近这些天没有日记。'
  const lines = [`最近 ${result.entries.length} 天的日记总结：`, '']
  for (const e of result.entries) {
    lines.push(`## ${e.date}${e.session ? ` · ${e.session}` : ''}`)
    lines.push(e.summary)
    lines.push('')
  }
  lines.push('（只有总结。要原文对话用 `memory_recall`，但要先想清楚是不是真要。）')
  return lines.join('\n').trim()
}

export function formatTranscript(result) {
  if (!result.ok) return result.error
  if (!result.lines.length) return `那天没有对话记录（${result.file || result.date}）。`
  const lines = [`${result.date} · ${result.session}（共 ${result.total} 条${result.truncated ? '，只给最后几条' : ''}）`, '']
  for (const l of result.lines) {
    const time = /T(\d{2}:\d{2}:\d{2})/.exec(l.t)
    // 跨会话时每行带上会话号，不然分不清哪句是哪段日子里的
    lines.push(`[${time ? time[1] : l.t}] ${l.session ? `${l.session} · ` : ''}${l.role}: ${l.text}`)
  }
  return lines.join('\n')
}

/* --------------------------------------------------------------- 工具定义 */

/**
 * @param {object} deps { rootDir, fallbackAgent, limits }
 * @param {(exec)=>string|null} deps.sessionIdOf
 */
export function buildTools(deps) {
  const rootDir = deps.rootDir
  const fallbackAgent = deps.fallbackAgent ?? null
  const maxChars = deps.maxChars

  const agentOf = (exec) => {
    const sessionId = deps.sessionIdOf(exec)
    if (!sessionId) return { sessionId: null, agentId: null, today: new Date().toISOString().slice(0, 10) }
    const { agentId } = agentForSession({ rootDir, sessionId, fallbackAgent })
    return { sessionId, agentId, today: new Date().toISOString().slice(0, 10) }
  }

  const needAgent = (exec) => {
    const got = agentOf(exec)
    if (!got.agentId) return { ok: false, text: '这个会话没有认领的人格（`private/agents.json` 里没登记），所以读不到记忆。' }
    return { ok: true, ...got }
  }

  const find = {
    name: 'memory_find',
    description:
      '在你的记忆里按关键词找（你认识的人、经验、索引、人格）。知道要找谁/找什么事、但不知道在哪本时用它。' +
      '返回命中文件的 id 和一句摘要，想看全文再用 `memory_open`。**别用它查原始对话** —— 那是 `memory_recall` 的事。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，中文词就行；空格分隔多个（任一命中即算）' },
        limit: { type: 'number', description: '最多返回几条，默认 10，最多 30' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const who = needAgent(exec)
      if (!who.ok) return { text: who.text, ok: false }
      const r = findMemory({ rootDir, agentId: who.agentId, query: args?.query, limit: args?.limit })
      return { text: formatFind(r), ok: r.ok, agent: who.agentId }
    },
  }

  const open = {
    name: 'memory_open',
    description:
      '打开一本记忆文件读全文。id 来自 `memory_find` 的结果，或者你自己知道的路径（`people/tianhai`、`经验`、`INDEX`、`diary/<会话>/2026-10-27`）。' +
      '只读得到你自己的目录；读不到会明说，不会猜。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文件 id，例如 people/tianhai、经验、INDEX、diary/bili-whale/2026-10-27' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const who = needAgent(exec)
      if (!who.ok) return { text: who.text, ok: false }
      const r = openMemory({ rootDir, agentId: who.agentId, id: args?.id, maxChars })
      return { text: formatOpen(r), ok: r.ok, agent: who.agentId }
    },
  }

  const diary = {
    name: 'memory_diary',
    description:
      '按日期读日记，默认最近 10 天，**只给每天「总结」那一段**（正文不给）。' +
      '想知道"那几天大概发生了什么"、或者写日记前想回忆，用它。要原文对话用 `memory_recall`。' +
      '日记按 agent 归属：同一个人的其他会话写的日记，你也能读。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往前看几天，默认 10，最多 60' },
        session: { type: 'string', description: '只看某个会话的日记目录；不给就是这个人的全部日记' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const who = needAgent(exec)
      if (!who.ok) return { text: who.text, ok: false }
      const r = readDiary({ rootDir, agentId: who.agentId, days: args?.days, session: args?.session })
      return { text: formatDiary(r), ok: r.ok, agent: who.agentId }
    },
  }

  const recall = {
    name: 'memory_recall',
    description:
      '查某天的原始对话（谁在什么时候说了什么）。**默认覆盖这个人名下所有会话** —— 同一个 agent 的几段日子会合并、按时间排、标出是哪段会话。' +
      '**只在两个场合用**：① 写日记前拿稿子 ② 真出问题要回查。' +
      '别的场合别用它 —— 一晚上几百行原文，会把你自己的上下文撑爆；找东西用 `memory_find`，回想日子用 `memory_diary`。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        session: {
          type: 'string',
          description:
            '限定哪个会话的日志。不传 = 这个人人名下的所有会话（日志仍按会话分文件，这里合并给你看）；写 this = 只看当前这个；写具体会话 id = 只看那一个',
        },
        limit: { type: 'number', description: '只要最后几条，默认 40，最多 200' },
        query: { type: 'string', description: '只看包含这个词的行' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const got = agentOf(exec)
      const scope = String(args?.session || '').trim()
      const isThis = scope.toLowerCase() === 'this'
      const pinned = scope && !isThis && scope.toLowerCase() !== 'all' ? scope : null
      const sessionId = pinned || got.sessionId
      const date = args?.date || got.today

      // 只看一个会话：this（当前）或具体 id
      if (pinned || isThis) {
        const r = readTranscript({ rootDir, sessionId, date, limit: args?.limit, query: args?.query })
        return { text: formatTranscript(r), ok: r.ok, session: sessionId || null }
      }

      // 默认：同一个人名下的几条会话，日志各在各的文件里，这里拼起来
      {
        const who = needAgent(exec)
        if (!who.ok) return { text: who.text, ok: false }
        const ids = sessionsOfAgent({ rootDir, agentId: who.agentId })
        if (!ids.length) return { text: '这个人名下还没有会话。', ok: false }
        const rows = []
        const seenSessions = []
        for (const sid of ids) {
          const one = readTranscript({ rootDir, sessionId: sid, date, limit: args?.limit || 40, query: args?.query })
          if (one.ok && one.lines.length) {
            seenSessions.push(sid)
            for (const l of one.lines) rows.push({ ...l, session: sid })
          }
        }
        if (!rows.length) return { text: `${date} 这天，这个人名下的 ${ids.length} 个会话都没有对话记录。`, ok: true }
        rows.sort((a, b) => String(a.t).localeCompare(String(b.t)))

        const cap = Math.min(Math.max(1, Number(args?.limit) || 40), 200)
        const lines = rows.slice(-cap)
        const label = new Map(seenSessions.map((sid, i) => [sid, i + 1]))
        const legend = seenSessions.map((sid) => `#${label.get(sid)} ${sid}`).join('  ')
        const body = lines.map((l) => {
          const time = /T(\d{2}:\d{2}:\d{2})/.exec(l.t)
          return `[${time ? time[1] : l.t}] #${label.get(l.session) || '?'} ${l.role}: ${l.text}`
        })
        const head = `${date} · 你名下 ${seenSessions.length} 个会话（共 ${rows.length} 条${rows.length > cap ? '，只给最后几条' : ''}）`
        const text = [head, `会话：${legend}`, '', ...body].join('\n')
        return { text, ok: true, session: 'all', sessions: seenSessions.length }
      }

      const r = readTranscript({ rootDir, sessionId, date, limit: args?.limit, query: args?.query })
      return { text: formatTranscript(r), ok: r.ok, session: sessionId || null }
    },
  }

  /*
   * memory_index —— 看一眼自己的记忆地图。
   *
   * 和 memory_open 的区别：open 是"我知道要看哪本"，
   * 这是"我不知道有什么，先看地图"。只读 INDEX.md 一个文件，很便宜。
   */
  const indexTool = {
    name: 'memory_index',
    description:
      '看一眼你自己写的记忆地图（INDEX.md）。\n' +
      '【什么时候用】\n' +
      '1. 刚醒来、或觉得脑子一片空白，想找回"我是谁、我都经历过什么"的领地感时。\n' +
      '2. 主人提起某件事，你有模糊印象但不知道具体藏在哪本日记或档案里 —— 先看地图。\n' +
      '3. 今天有了新感悟、或认识了新的人，打算给记忆添砖加瓦时，看看现在的版图，决定放哪儿最合适。\n' +
      '\n这是你自己一笔一划画出来的认知版图。如果发现版图乱了、或有新变化，顺手把它更新一下。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute(_args, exec) {
      const who = needAgent(exec)
      if (!who.ok) return { text: who.text, ok: false }
      const agentDir = join(String(rootDir), 'agents', who.agentId)
      const file = join(agentDir, 'INDEX.md')
      if (!existsSync(file)) {
        // 没有就告诉他怎么起一个，别只说"没有"
        let listing = []
        try {
          listing = readdirSync(agentDir).filter((n) => !n.startsWith('.'))
        } catch {
          /* 读不到就只给建议 */
        }
        const hint = listing.length
          ? '\n\n你的目录里现在有：' + listing.join(' / ')
          : ''
        return {
          text:
            '你还没有 INDEX.md（记忆地图）。' +
            '\n\n它是你目录的索引 —— 写清"哪本记着什么"，下次脑子空白时第一眼看的就是它。' +
            '\n建议现在就建一个，把下面这些东西列清楚：' +
            '\n- 人格.md 我是谁' +
            '\n- people/ 我认识谁' +
            '\n- diary/ 我过的日子' +
            '\n- 经验.md 我摔过的跤' +
            hint,
          ok: false,
        }
      }
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch (err) {
        return { text: '读不到 ' + file + '：' + msg(err), ok: false }
      }
      const trimmed = String(text).trim()
      if (!trimmed) return { text: file + ' 是空的。', ok: false }
      return { text: trimmed, ok: true, agent: who.agentId, chars: trimmed.length }
    },
  }

  return {
    memory_find: find,
    memory_open: open,
    memory_diary: diary,
    memory_recall: recall,
    memory_index: indexTool,
  }
}

/* ------------------------------------------------------------------ 挂载 */

function toolsServiceOf(ctx) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const s = ctx.get('tools')
      if (s && typeof s.register === 'function') return s
    }
  } catch {
    /* 没 inject 过就当没有 */
  }
  try {
    const s = ctx.tools
    if (s && typeof s.register === 'function') return s
  } catch {
    /* 同上 */
  }
  return null
}

/**
 * 挂工具。返回 dispose。
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {object} [opts.config]  { enabled, find, open, diary, recall }
 * @param {(err:Error)=>void} [opts.onError]
 * @param {()=>string|null} [opts.sessionIdOf] 给测试注一个假的会话 id
 * @returns {{dispose:()=>void, names:string[], reason?:string}}
 */
export function register(ctx, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) }
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {}
  const report = (err) => {
    try {
      onError(err instanceof Error ? err : new Error(String(err)))
    } catch {
      /* 回调自己炸了不影响工具 */
    }
  }

  if (cfg.enabled === false) return { dispose: () => {}, names: [], reason: 'disabled' }

  const tools = toolsServiceOf(ctx)
  if (!tools) {
    report(new Error('宿主没有 tools 服务，四个记忆工具没挂上（记忆照常记，只是她够不到）'))
    return { dispose: () => {}, names: [], reason: 'no-tools-service' }
  }

  const sessionIdOf =
    typeof opts.sessionIdOf === 'function'
      ? opts.sessionIdOf
      : (exec) => {
          const a = exec && exec.agent
          if (!a) return null
          if (typeof a.id === 'string' && a.id) return a.id
          if (a.sessionId) return String(a.sessionId)
          return null
        }

  const defs = buildTools({ rootDir: opts.rootDir, fallbackAgent: opts.fallbackAgent, maxChars: opts.maxChars, sessionIdOf })
  const disposers = []
  const names = []

  for (const [name, def] of Object.entries(defs)) {
    const key = TOOL_KEYS[name]
    if (cfg[key] === false) continue
    try {
      const off = tools.register(def)
      if (typeof off === 'function') disposers.push(off)
      names.push(name)
    } catch (err) {
      report(new Error(`工具 ${name} 没挂上：${msg(err)}`))
    }
  }

  return {
    dispose() {
      for (const off of disposers.reverse()) {
        try {
          off()
        } catch {
          /* 一个拆不掉，别的照拆 */
        }
      }
    },
    names,
  }
}
