/**
 * paths.mjs —— 工具区的路径与归属（只读，绝不越界）
 *
 * 两条红线（抄自设计文档 §1.4 / §3.2.2）：
 *   1. **只读 `agents/<当前 agent>/`**：别人的目录拼都别拼，
 *      所有路径都从当前 agent 的目录出发，再挡一层 `..` 和绝对路径。
 *   2. **不写任何文件**：这是"伸手去够记忆"的手，不是手。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const msg = (err) => String((err && err.message) || err)

/** 读 JSON，坏了就是 null（工具不该因为一个坏文件就整体失败） */
export function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/**
 * agent 目录：先看人定的归属表（`private/agents.json`），
 * 再看会话登记表里的名字（`system/sessions.json`），最后才用配置里的兜底。
 *
 * @returns {{agentId:string|null, source:string}}
 */
export function agentForSession({ rootDir, sessionId, fallbackAgent = null } = {}) {
  const root = String(rootDir || '')
  const table = readJsonSafe(join(root, 'private', 'agents.json')) || {}
  if (sessionId && typeof table[sessionId] === 'string' && table[sessionId].trim()) {
    return { agentId: table[sessionId].trim(), source: 'agents.json' }
  }
  const reg = readJsonSafe(join(root, 'system', 'sessions.json'))
  const name = reg?.sessions?.[sessionId]?.name
  if (typeof name === 'string' && name.trim() && existsSync(join(root, 'agents', name.trim()))) {
    return { agentId: name.trim(), source: 'sessions.json' }
  }
  if (typeof fallbackAgent === 'string' && fallbackAgent.trim()) {
    return { agentId: fallbackAgent.trim(), source: 'config.fallbackAgent' }
  }
  return { agentId: null, source: 'none' }
}

/**
 * 这个 agent 有哪些会话 —— **"一个人格的所有会话"**，三个来源取并集：
 *
 *   1. `private/agents.json`（人定的归属表，最准）
 *   2. `agents/<agent>/diary/<会话>/`（这个人给哪个会话写过日记）
 *   3. `agents/<agent>/diary/.draft/<会话>/`（Daily 产过稿的会话）
 *   4. `system/sessions.json` 里名字正好等于这个 agent 的（老数据兜底）
 *
 * 日志在磁盘上仍然一条会话一个文件 —— 这里只回答"哪些会话属于这一个人"。
 */
export function sessionsOfAgent({ rootDir, agentId } = {}) {
  const root = String(rootDir || '')
  const agent = String(agentId || '')
  const out = new Set()

  const table = readJsonSafe(join(root, 'private', 'agents.json')) || {}
  for (const [sid, who] of Object.entries(table)) {
    if (typeof who === 'string' && who.trim() === agent) out.add(String(sid))
  }

  const diaryRoot = join(root, 'agents', agent, 'diary')
  const addDirs = (dir, skip) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (skip && skip.has(name)) continue
      try {
        if (statSync(join(dir, name)).isDirectory()) out.add(String(name))
      } catch {
        /* 读不到就算了 */
      }
    }
  }
  addDirs(diaryRoot, new Set(['.draft']))
  addDirs(join(diaryRoot, '.draft'))

  const registry = readJsonSafe(join(root, 'system', 'sessions.json')) || {}
  for (const [sid, row] of Object.entries(registry.sessions || {})) {
    if (row && typeof row.name === 'string' && row.name.trim() === agent) out.add(String(sid))
  }

  return [...out].sort()
}

/**
 * 把一个"记忆 id"解析成 `agents/<agent>/` 下面的真实路径。
 * 拒绝 `..`、绝对路径、和跑出 agent 目录的任何东西。
 *
 * @param {string} agentDir
 * @param {string} id  例如 `people/tianhai`、`经验`、`diary/bili-whale/2026-10-27`
 * @returns {{ok:true, path:string, rel:string} | {ok:false, error:string}}
 */
export function resolveInside(agentDir, id) {
  const raw = String(id || '').trim().replace(/\\/g, '/')
  if (!raw) return { ok: false, error: 'id 不能是空的' }
  if (isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) return { ok: false, error: '不接受绝对路径' }
  if (raw.split('/').some((seg) => seg === '..')) return { ok: false, error: '不接受 ..' }

  const base = resolve(agentDir)
  const candidates = /\.md$/i.test(raw) ? [raw] : [`${raw}.md`, raw]
  for (const rel of candidates) {
    const full = resolve(base, rel)
    if (full !== base && !full.startsWith(base + sep)) return { ok: false, error: '不接受跑到目录外面的路径' }
    if (existsSync(full) && statSync(full).isFile()) return { ok: true, path: full, rel: relative(base, full).replace(/\\/g, '/') }
  }
  return { ok: false, error: `找不到：${raw}` }
}

/** 列出 agent 目录下所有 md（people/ 和根目录，日记走 diary.mjs 自己的规则） */
export function listObjectFiles(agentDir) {
  const out = []
  const push = (dir, rel) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const r = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) push(full, r)
      else if (/\.md$/i.test(name)) out.push({ rel: r, path: full })
    }
  }
  push(agentDir, '')
  return out
}

/** 读文本，超长就截（工具的输出会进上下文，不能无限） */
export function readTextCapped(file, maxChars) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: `读不了：${msg(err)}` }
  }
  const arr = [...text]
  if (arr.length <= cap) return { ok: true, text, truncated: false }
  return { ok: true, text: `${arr.slice(0, cap - 1).join('')}…`, truncated: true }
}

export const errText = msg
