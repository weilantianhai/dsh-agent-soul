/**
 * hook.mjs —— 事件监听 + 过滤
 *
 * 契约（和 dsh-whale-memory/lib/turns.js 同一套，DSH Host Event）：
 *   ctx.on('session/event', (session, event) => {})
 *     session.id / session.sessionId
 *     event.type = 'user/message' | 'assistant/message' | 'turn/start' | 'turn/end' | ...
 *     event.data（老版本在 event.payload）
 *
 * 只收两种：用户说的话、小鱼说的话。
 * reasoning / tool-call / tool-result / system 一概不碰；
 * 被打断（interrupted）的助手输出不写 —— 那是半句。
 *
 * **用户侧原文照录，不做任何"这是不是包装"的判断。** 详见下面 cleanUserText。
 */

import { isoLocal } from './writer.mjs'

/* ------------------------------------------------------------ 内容提取 */

/**
 * 从内容块里只取 text（不取 reasoning / tool-call）。
 *
 * 宿主给的内容是块数组：`[{type:'text',text}, {type:'reasoning'...}, ...]`。
 * 我们只认 text —— reasoning 是它的思考过程，不该进日志。
 */
export function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/* ------------------------------------------------------------ 原文照录 */

/**
 * 把一条用户消息变成要写进日志的文本。
 *
 * **原文照录，不判断内容。** 日志的价值就在"原样"二字 ——
 * 一旦开始猜"哪句是包装、哪句是正文"，猜错就把真话删了，而且救不回来；
 * 猜的规则还会绑死别人的实现，对方一改格式，我们不会报错，只会静默记错。
 *
 * 只做三件事，都不涉及"这是什么内容"：
 *   1. 去零宽字符（脏字节，会让搜索和 diff 错乱）
 *   2. CRLF → LF
 *   3. `<user_query>` 只脱标签留正文（DSH 宿主自己的格式，不是别人的插件）
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanUserText(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  return (raw
    // 零宽字符
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    // CRLF → LF
    .replace(/\r\n?/g, '\n')
    /*
     * `<user_query>` 是 DSH 给用户输入加的壳：
     *   <user_query>好的，那我们继续搭</user_query>
     * 只脱标签，里面的字一个不动。
     *
     * 其它 `<...>` 一律**当正文留着** —— 我们不知道那是什么，就不猜。
     */
    .replace(/<\/?user_query\b[^>]*>/gi, '')
  )
    // 行尾空白 + 连续空行压缩（纯排版，不删内容）
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------ 是谁说的 */

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * 用户侧 role —— 配置里怎么称呼这个人。
 *
 * 不按消息里的 mid 判断身份：那需要猜文本格式，配置填错还会把别人标成主人。
 * 需要区分多用户时，按宿主给的明确字段判。
 */
export function resolveUserRole({ config }) {
  const cfg = config ?? {}
  return String(cfg.defaultRole ?? 'tianhai')
}

/** 助手侧 role：读配置里的 selfName，不写死 */
export function resolveSelfName({ sessionId, config }) {
  const cfg = config ?? {}
  const entry = cfg.sessions?.[sessionId]
  if (entry?.selfName) return String(entry.selfName)
  if (cfg.selfName) return String(cfg.selfName)
  return 'assistant'
}

/* ------------------------------------------------------------ 时间/序号 */

function pickTime(data, event) {
  const v =
    pick(data, ['at', 'time', 'timestamp', 'createdAt', 'created_at']) ??
    pick(event, ['at', 'time', 'timestamp'])
  return v ?? new Date()
}

function pickSeq(data, event, session) {
  const v = pick(data, ['seq', 'sequence', 'recordSeq']) ?? pick(event, ['seq', 'sequence']) ?? pick(session, ['seq'])
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* ------------------------------------------------------------ 主体 */

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {{write:Function}} opts.writer
 * @param {(record:object)=>void} [opts.onWrite]
 * @param {(err:Error)=>void} [opts.onError]
 */
export function createHook({ config, writer, onWrite, onError } = {}) {
  const cfg = config ?? {}
  const stats = {
    seen: 0,
    written: 0,
    skipped: 0,
    reasons: Object.create(null),
    lastError: null,
  }
  const sessions = new Set()
  let disposed = false

  const noteSkip = (reason) => {
    stats.skipped += 1
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1
  }

  const report = (err) => {
    stats.lastError = String(err?.message || err)
    if (typeof onError === 'function') {
      try {
        onError(err instanceof Error ? err : new Error(String(err)))
      } catch {
        /* onError 自己炸了，记下就好 */
      }
    }
  }

  /** 事件入口：同步、不 await、绝不把异常抛回宿主 */
  function handle(session, event) {
    try {
      if (disposed || cfg.enabled === false) return
      if (!writer) return

      const sid = String(session?.id ?? session?.sessionId ?? '')
      const type = event?.type
      if (!sid || !type) return
      if (type !== 'user/message' && type !== 'assistant/message') return
      // 只处理"追加"的表面事件，别的（编辑/撤回）不碰
      if (event.surfaceOp && event.surfaceOp !== 'append') return noteSkip('surface-op')

      const data = event.data ?? event.payload
      if (!data) return

      stats.seen += 1

      let text
      let role
      if (type === 'user/message') {
        const raw = textOf(data.content ?? data.message?.content)
        if (!raw) return noteSkip('no-text')
        /*
         * 这两类来源是**宿主明确标出来的**（source.kind），不是我们猜的：
         *   tool       —— 工具结果被包装成 user 消息
         *   developer  —— 开发者指令
         * 它们不是"人说的话"，跳过。除此之外一律原文照录。
         */
        const kind = String(data.source?.kind ?? data.message?.source?.kind ?? '')
        if (['tool', 'developer'].includes(kind)) return noteSkip('tool-source')
        text = cleanUserText(raw)
        if (!text) return noteSkip('empty')
        role = resolveUserRole({ config: cfg })
      } else {
        if (data.interrupted === true) return noteSkip('interrupted')
        text = textOf(data.message?.content ?? data.content)
        if (!text) return noteSkip('no-text')
        role = resolveSelfName({ sessionId: sid, config: cfg })
      }

      const record = {
        sessionId: sid,
        role,
        text,
        seq: pickSeq(data, event, session),
        t: pickTime(data, event),
      }

      const result = writer.write(record)
      if (!result?.ok) {
        if (result?.reason === 'write-failed') noteSkip('write-failed')
        else noteSkip(result?.reason || 'not-written')
        return
      }

      sessions.add(sid)
      stats.written += 1
      // onWrite 由这里统一触发（只此一处，不会重复）
      if (typeof onWrite === 'function') {
        try {
          onWrite({ ...record, t: isoLocal(record.t), path: result.path })
        } catch (err) {
          report(err)
        }
      }
    } catch (err) {
      // 钩子里任何异常都不许冒到宿主去
      noteSkip('error')
      report(err)
    }
  }

  /** 挂到宿主事件总线上；返回解绑函数 */
  function attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('attach 需要 ctx.on')
    const off = ctx.on('session/event', handle)
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* 解绑失败不影响退出 */
      }
    }
  }

  function snapshot() {
    return {
      seen: stats.seen,
      written: stats.written,
      skipped: stats.skipped,
      reasons: { ...stats.reasons },
      sessions: [...sessions],
      lastError: stats.lastError,
    }
  }

  function dispose() {
    disposed = true
  }

  return { handle, attach, snapshot, dispose }
}
