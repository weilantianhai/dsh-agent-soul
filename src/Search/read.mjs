/**
 * read.mjs —— 四个工具真正干活的地方（**纯函数，只读，不碰 DSH**）
 *
 *   findMemory   按关键词找人/找事 → id + 一句摘要
 *   openMemory   打开一本，读全文
 *   readDiary    最近 N 天的日记，只给「总结」
 *   readTranscript 某天的原始对话（只在写日记前拿稿子、或回查时用）
 *
 * 这样分开的好处：工具定义（index.mjs）只负责"跟宿主说话"，
 * 逻辑可以不起 DSH 单独测。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { listObjectFiles, readTextCapped, resolveInside } from './paths.mjs'

const DAY_RE = /^(\d{4}-\d{2}-\d{2})/

const oneLine = (s, max = 90) => {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
  const arr = [...t]
  return arr.length <= max ? t : `${arr.slice(0, max - 1).join('')}…`
}

/** 把查询拆成关键词（空格分隔，任一命中即算） */
export function termsOf(query) {
  return String(query || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ------------------------------------------------------------ memory_find */

/**
 * 按关键词找「对象」：people/、经验.md、INDEX.md、MEMORY.md、人格.md。
 * **不扫 diary/** —— 那是 `memory_diary` 的活。
 *
 * @returns {{ok:true, query:string, hits:Array, scanned:number} | {ok:false, error:string}}
 */
export function findMemory({ rootDir, agentId, query, limit = 10 } = {}) {
  const terms = termsOf(query)
  if (!terms.length) return { ok: false, error: 'query 不能是空的（给个词，中文词就行）' }
  const agentDir = join(String(rootDir), 'agents', String(agentId))
  if (!existsSync(agentDir)) return { ok: false, error: `没有这个 agent 目录：${agentId}` }

  const cap = Math.min(Math.max(1, Number(limit) || 10), 30)
  const files = listObjectFiles(agentDir).filter((f) => !f.rel.startsWith('diary/'))
  const hits = []
  let scanned = 0

  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file.path, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < cap; i += 1) {
      const line = lines[i]
      if (!line.trim()) continue
      scanned += 1
      const low = line.toLowerCase()
      if (!terms.some((t) => low.includes(t.toLowerCase()))) continue
      hits.push({
        id: file.rel.replace(/\.md$/i, ''),
        file: file.rel,
        line: i + 1,
        excerpt: oneLine(line.replace(/^[-*#>\s]+/, '')),
      })
    }
    if (hits.length >= cap) break
  }

  return { ok: true, query: String(query), agent: String(agentId), hits, scanned, truncated: hits.length >= cap }
}

/* ------------------------------------------------------------ memory_open */

/**
 * 打开一本读全文。id 只认 `agents/<agent>/` 里面的。
 * @returns {{ok:true, id:string, file:string, chars:number, text:string, truncated:boolean} | {ok:false, error:string}}
 */
export function openMemory({ rootDir, agentId, id, maxChars } = {}) {
  const agentDir = join(String(rootDir), 'agents', String(agentId))
  if (!existsSync(agentDir)) return { ok: false, error: `没有这个 agent 目录：${agentId}` }
  const found = resolveInside(agentDir, id)
  if (!found.ok) return { ok: false, error: found.error }
  const read = readTextCapped(found.path, maxChars)
  if (!read.ok) return { ok: false, error: read.error }
  return {
    ok: true,
    id: found.rel.replace(/\.md$/i, ''),
    file: found.rel,
    chars: [...read.text].length,
    text: read.text,
    truncated: read.truncated,
  }
}

/* ----------------------------------------------------------- memory_diary */

/** 取 `## 总结` 那一节（没有就取第一个正文段落） */
export function summaryOf(raw) {
  const text = String(raw || '')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^##\s*总结\s*$/.test(l.trim()))
  if (start < 0) return ''
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n').trim()
}

/** 单文件日记里按 `## 2026-10-27 …` 切出来的当天那一节 */
function datedSections(raw) {
  const lines = String(raw || '').split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    const m = /^#{2,6}\s+(\d{4}-\d{2}-\d{2})(.*)$/.exec(line.trim())
    if (m) {
      if (cur) out.push(cur)
      cur = { date: m[1], heading: line.trim(), body: [] }
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 最近 N 天的日记，**只给「总结」段**。
 *
 * @param {object} opts
 * @param {number} [opts.days]    默认 10
 * @param {string} [opts.session] 只看某个会话的日记目录；不给就看这个 agent 的全部（同一个人的日子）
 * @returns {{ok:true, agent:string, days:number, entries:Array<{date,session,summary}>} | {ok:false, error:string}}
 */
export function readDiary({ rootDir, agentId, days = 10, session } = {}) {
  const diaryRoot = join(String(rootDir), 'agents', String(agentId), 'diary')
  if (!existsSync(diaryRoot)) return { ok: false, error: `这个 agent 还没有日记目录（${agentId}/diary）` }

  const want = Math.min(Math.max(1, Number(days) || 10), 60)
  const entries = []

  const dirs = []
  if (typeof session === 'string' && session.trim()) {
    dirs.push({ name: session.trim(), path: join(diaryRoot, session.trim()) })
  } else {
    for (const name of readdirSync(diaryRoot)) {
      const full = join(diaryRoot, name)
      try {
        if (statSync(full).isDirectory()) dirs.push({ name, path: full })
      } catch {
        /* 跳过读不到的 */
      }
    }
  }

  for (const dir of dirs) {
    if (!existsSync(dir.path)) continue
    for (const name of readdirSync(dir.path)) {
      const m = DAY_RE.exec(name)
      if (!m || !/\.md$/i.test(name)) continue
      const read = readTextCapped(join(dir.path, name), 20000)
      if (!read.ok) continue
      const summary = summaryOf(read.text)
      if (!summary) continue
      entries.push({ date: m[1], session: dir.name, summary })
    }
    // 单文件日记（私房日记.md 那种）
    for (const name of readdirSync(dir.path)) {
      if (DAY_RE.test(name) || !/\.md$/i.test(name)) continue
      const read = readTextCapped(join(dir.path, name), 40000)
      if (!read.ok) continue
      for (const sec of datedSections(read.text)) {
        const summary = sec.body.join('\n').trim()
        if (!summary) continue
        entries.push({ date: sec.date, session: dir.name, summary: oneLine(summary, 400), from: basename(name) })
      }
    }
  }

  const byDate = new Map()
  for (const e of entries) if (!byDate.has(e.date)) byDate.set(e.date, e)
  const list = [...byDate.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, want)
  return { ok: true, agent: String(agentId), days: want, entries: list }
}

/* --------------------------------------------------------- memory_recall */

/**
 * 某天的原始对话。
 *
 * @param {object} opts
 * @param {string} [opts.date]   `YYYY-MM-DD`，默认今天
 * @param {number} [opts.limit]  取最后几条，默认 40，最多 200
 * @param {string} [opts.query]  只看包含这个词的行
 * @returns {{ok:true, session:string, date:string, file:string, total:number, lines:Array}|{ok:false,error:string}}
 */
export function readTranscript({ rootDir, sessionId, date, limit = 40, query } = {}) {
  const sid = String(sessionId || '').trim()
  if (!sid) return { ok: false, error: '不知道是哪个会话：没有 sessionId' }
  const day = String(date || new Date().toISOString().slice(0, 10)).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: `date 要写成 YYYY-MM-DD，收到的是 ${day}` }

  const file = join(String(rootDir), 'sessions', sid, 'logs', `${day}.jsonl`)
  if (!existsSync(file)) return { ok: false, error: `那天没有日志：sessions/${sid}/logs/${day}.jsonl` }

  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: `日志读不了：${String((err && err.message) || err)}` }
  }

  const terms = termsOf(query)
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const text = String(rec.text || '')
    if (!text) continue
    if (terms.length && !terms.some((t) => text.toLowerCase().includes(t.toLowerCase()))) continue
    rows.push({ t: String(rec.t || ''), role: String(rec.role || ''), text, seq: rec.seq ?? null })
  }

  const cap = Math.min(Math.max(1, Number(limit) || 40), 200)
  return {
    ok: true,
    session: sid,
    date: day,
    file: `sessions/${sid}/logs/${day}.jsonl`,
    total: rows.length,
    lines: rows.slice(-cap),
    truncated: rows.length > cap,
  }
}
