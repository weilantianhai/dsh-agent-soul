/**
 * assemble.mjs —— 拼内容：找人格、找日记、拼路标
 *
 * 三条底线：
 *   1. 所有路径都从 `agents/<当前 agent>/` 出发，**绝不拼别人的目录**（红线）
 *   2. 找不到就不塞，不猜一个顶上去
 *   3. 只读，不写任何文件
 *
 * ⚠️ 现实和任务单不完全一样，这里按**两种形态都认**来写：
 *   · 人格：任务单说取「开头到第一个 ---」+「九、红线」。
 *     实际 `人格.md` 的红线在 **§十二**（§九 是「对外怎么提 tianhai」），
 *     所以红线按**标题关键字**找，不按编号找。
 *   · 日记：任务单说 `diary/<会话>/YYYY-MM-DD.md` 取 `## 总结`。
 *     实际是 `公开日记.md` / `私房日记.md`，没有 `## 总结`。
 *     所以先按任务单的形态找；找不到，再找**标题里带日期的最新那一节**。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/* ------------------------------------------------------------------ 小工具 */

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

/** 从 markdown 里切出一节：标题命中 keyword 的那节，到下一个同级或更高级标题为止 */
export function extractSection(raw, keyword) {
  const lines = String(raw || '').split('\n')
  const isHeading = (l) => /^(#{1,6})\s+(.*)$/.exec(l)
  for (let i = 0; i < lines.length; i += 1) {
    const m = isHeading(lines[i])
    if (!m) continue
    if (!keyword.test(m[2])) continue
    const level = m[1].length
    const body = [lines[i]]
    for (let j = i + 1; j < lines.length; j += 1) {
      const n = isHeading(lines[j])
      if (n && n[1].length <= level) break
      body.push(lines[j])
    }
    return body.join('\n').trim()
  }
  return ''
}

/* ------------------------------------------------------------------ 归属 */

/**
 * 这个会话归哪个 agent。三种来源，按优先级：
 *   ① `private/agents.json`（人定的归属表）
 *   ② `sessions.json` 里的 `name` 恰好等于 `agents/` 下某个目录名（任务单的模型）
 *   ③ 配置里的 `fallbackAgent`（人填的，不是代码猜的）
 * 都没有 → null，调用方负责报错。
 */
export function resolveAgentId({ sessionId, rootDir, fallbackAgent = null }) {
  const agentsRoot = join(rootDir, 'agents')
  const has = (id) => Boolean(id) && existsSync(join(agentsRoot, id))
  const empty = { agentId: null, source: 'unresolved' }

  if (!sessionId) {
    if (has(fallbackAgent)) return { agentId: fallbackAgent, source: 'config.fallbackAgent' }
    return empty
  }

  const table = readOwnership(rootDir)
  // 显式"不要人格"：这条会话就空着，不许回落到默认
  if (sessionId in table && table[sessionId] === null) {
    return { agentId: null, source: 'agents.json:none' }
  }
  if (table[sessionId] && has(table[sessionId])) {
    return { agentId: table[sessionId], source: 'agents.json' }
  }

  const name = readSessionName(rootDir, sessionId)
  if (name && has(name)) return { agentId: name, source: 'sessions.json:name' }

  if (has(fallbackAgent)) return { agentId: fallbackAgent, source: 'config.fallbackAgent' }

  return { ...empty, lookedUp: { table: table[sessionId] ?? null, name: name ?? null } }
}

/** 读归属表，容忍几种常见形状；读坏了就当没有（调用方会报） */
export function readOwnership(rootDir) {
  const file = join(rootDir, 'private', 'agents.json')
  if (!existsSync(file)) return {}
  let data
  try {
    data = JSON.parse(readText(file) || '{}')
  } catch {
    return {}
  }
  const out = {}
  /**
   * 归属表里一条记录的含义（2026-10-28 定）：
   *   "xiaoyu"   → 这个会话用这个人格
   *   ""         → **显式不要人格**（临时会话），宁可空着也不用默认
   *   记录不存在 → 没设置过，走默认人格
   * 所以空串要保留成 null，不能像以前那样直接丢掉 —— 丢掉就分不清
   * "我不要" 和 "我没选" 了。
   */
  const put = (sid, id) => {
    if (typeof sid !== 'string' || !sid) return
    if (id === '') out[sid] = null
    else if (typeof id === 'string') out[sid] = id
  }
  if (!data || typeof data !== 'object') return out

  // 形状 A：{ "bili-whale": "xiaoyu" }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') put(k, v)
  }
  // 形状 B：{ sessions: { "bili-whale": "xiaoyu" | { agent: "xiaoyu" } } }
  if (data.sessions && typeof data.sessions === 'object') {
    for (const [sid, v] of Object.entries(data.sessions)) {
      if (typeof v === 'string') put(sid, v)
      else if (v && typeof v === 'object' && typeof v.agent === 'string') put(sid, v.agent)
    }
  }
  // 形状 C：{ agents: { xiaoyu: { sessions: ["bili-whale"] } } }
  if (data.agents && typeof data.agents === 'object') {
    for (const [agentId, v] of Object.entries(data.agents)) {
      const list = Array.isArray(v) ? v : Array.isArray(v?.sessions) ? v.sessions : []
      for (const sid of list) put(sid, agentId)
    }
  }
  return out
}

/** 读 sessions.json 里这个会话的显示名 */
export function readSessionName(rootDir, sessionId) {
  const file = join(rootDir, 'system', 'sessions.json')
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readText(file) || '{}')
    const entry = data?.sessions?.[sessionId]
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    return name || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 人格 */

/**
 * 人格摘要 = 开头那段（第一个 `---` 之前）+ 第一个正文章节 + 红线那一节。
 *
 * 为什么多拿「第一个正文章节」：
 *   实际 `人格.md` 里第一个 `---` 之后紧跟的是「一、你是谁」，
 *   只取 `---` 之前的话，注入到上下文里只有标题和三行引言，
 *   **连"你是小鱼"都没有** —— 那就白注入了。
 *   所以默认把第一小节一起带上（`persona.includeFirstSection` 可关）。
 * 中间那些「怎么说话」「评论区怎么回」故意不塞 —— DSH 的 AGENTS.md 本来就会读。
 */
export function readPersona(agentDir) {
  const file = join(agentDir, '人格.md')
  if (!existsSync(file)) return null
  const raw = readText(file)
  const lines = raw.split('\n')

  let cut = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (cut < 0) cut = lines.findIndex((l, i) => i > 0 && /^##\s/.test(l)) // 没有分隔线就切到第一个二级标题
  if (cut < 0) cut = Math.min(lines.length, 20)

  const intro = lines.slice(0, cut).join('\n').trim()
  // 第一个正文章节（通常是「一、你是谁」）
  const firstSection = extractSection(lines.slice(cut + 1).join('\n'), /.*/)
  // 红线按**关键字**找，不按编号找（实际在 §十二，不是 §九）
  const redline = extractSection(raw, /红线/)
  return { file, intro, firstSection, redline }
}

/** 拼成注入用的人格段 */
export function personaText({ intro, firstSection, redline, includeFirstSection = true }) {
  return [intro, includeFirstSection ? firstSection : '', redline].filter(Boolean).join('\n\n').trim()
}

/* ------------------------------------------------------------------ 日记 */

const DATE_RE = /(\d{4}-\d{2}-\d{2})/

/** 一部日记里所有「标题带日期」的小节 */
function datedSections(raw) {
  const lines = String(raw || '').split('\n')
  const out = []
  const isHeading = (l) => /^(#{2,6})\s+(.*)$/.exec(l)
  for (let i = 0; i < lines.length; i += 1) {
    const m = isHeading(lines[i])
    if (!m) continue
    const date = DATE_RE.exec(m[2])
    if (!date) continue
    const level = m[1].length
    const body = [lines[i]]
    for (let j = i + 1; j < lines.length; j += 1) {
      const n = isHeading(lines[j])
      if (n && n[1].length <= level) break
      body.push(lines[j])
    }
    const text = body.join('\n').trim()
    if (text) out.push({ date: date[1], text })
  }
  return out
}

/**
 * 这个会话最近一篇日记。
 *   ① 任务单形态：`diary/<会话>/YYYY-MM-DD.md` 里的 `## 总结`（取最近一天）
 *   ② 现实形态：`公开日记.md` / `私房日记.md` 里**标题带日期**的最新一节
 *   ③ 都没有 → null（调用方不塞，不报错）
 */
export function readDiary({ agentDir, sessionId }) {
  const dir = join(agentDir, 'diary', sessionId)
  if (!existsSync(dir)) return null

  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }

  // ① 一天一个文件 + ## 总结
  const dated = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse()
  for (const f of dated) {
    const raw = readText(join(dir, f))
    const sec = extractSection(raw, /^总结\s*$/)
    if (sec) {
      const body = sec.split('\n').slice(1).join('\n').trim() // 去掉 `## 总结` 这行标题
      if (body) return { text: body, source: join(dir, f), kind: 'daily-summary', date: f.slice(0, 10) }
    }
  }

  // ② 单文件里的「日期小节」
  let best = null
  for (const f of files) {
    const file = join(dir, f)
    for (const sec of datedSections(readText(file))) {
      if (!best || sec.date > best.date) best = { ...sec, source: file }
    }
  }
  if (best) return { text: best.text, source: best.source, kind: 'dated-section', date: best.date }

  return null
}

/** 日记总结后面的路标（故意留缺口：不写全，让她自己去翻） */
export function diaryTrail({ memoryRoot, agentId, diary }) {
  const rel = (p) => String(p).replace(/\\/g, '/').replace(new RegExp(`^${memoryRoot.replace(/\\/g, '/')}/?`), '')
  const parts = []
  if (diary?.source) parts.push(`细节：${rel(diary.source)}`)
  parts.push(`人物：agents/${agentId}/people/`)
  return `（${parts.join(' · ')}）`
}

/* ------------------------------------------------------------------ 路标 */

/**
 * 4.3 那句话。字是写死的，只有目录跟着 agent 走。
 * 这是注入里唯一不砍的东西 —— 它是最后那根指路的手指。
 */
export function buildSignpost({ memoryRoot, agentId }) {
  const root = String(memoryRoot).replace(/\\/g, '/').replace(/\/$/, '')
  return [
    `你的记忆在 ${root}/agents/${agentId}/ —— 人格、认识的人、日记都在那儿。`,
    '忘了什么先翻 INDEX.md，要细节自己去读，别凭着印象说。',
  ].join('\n')
}
