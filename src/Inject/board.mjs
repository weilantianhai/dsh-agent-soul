/**
 * board.mjs —— 共享话板：只读解析 + 「有新留言」那一句
 *
 * 依据：`design-tools-daily-prompt.md` §3.5。
 *
 *   **只注"有新留言"，不注内容。**
 *   理由：注内容的话，消息一多每轮都占字数；只给个由头，她想看自己去看。
 *
 * 话板是**唯一**一个 agent 之间能互相看见的地方（`memory/shared/board.md`），
 * 按「页」排，不按时间线：
 *
 *   ```
 *   ## 第一页
 *
 *   **2026-10-27 · 小鱼**
 *   你可以慢，但别一直用力。
 *   ```
 *
 * 这个文件只读，绝不写 —— 话板是她们俩的事，注入器不代笔。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const msg = (err) => String((err && err.message) || err)

/** 一条留言的标题行：`**2026-10-27 · 小鱼**` */
const ENTRY_RE = /^\*\*\s*(\d{4}-\d{2}-\d{2})\s*[·・]\s*([^*]{1,24}?)\s*\*\*\s*$/

/** 话板路径 */
export function boardPath(rootDir) {
  return join(String(rootDir || '.'), 'shared', 'board.md')
}

/**
 * 解析话板。
 * @param {string} rootDir memory 根目录
 * @returns {{ok:boolean, path:string, count:number, pages:number,
 *            newest:{date:string, who:string}|null, error:string|null}}
 */
export function readBoard(rootDir) {
  const path = boardPath(rootDir)
  const empty = { ok: false, path, count: 0, pages: 0, newest: null, error: null }
  if (!existsSync(path)) return empty
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { ...empty, error: `话板读不了：${msg(err)}` }
  }

  let count = 0
  let pages = 0
  let newest = null
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (/^##\s/.test(t)) {
      pages += 1
      continue
    }
    const m = ENTRY_RE.exec(t)
    if (m) {
      count += 1
      newest = { date: m[1], who: m[2] }
    }
  }
  return { ok: true, path, count, pages, newest, error: null }
}

/**
 * 「有新留言」那一句。**没新留言就返回空串** —— 不给字数，也不给噪音。
 *
 * @param {object} opts
 * @param {{count:number, newest:{date:string,who:string}|null, ok:boolean}} opts.board
 * @param {number} opts.seen  上次看到几条（调用方记着）
 * @returns {string}
 */
/**
 * 读插件自带的 prompts/ 下的文件。
 *
 * 加这层（2026-10-28 tianhai 提的）：像"话板有新留言"这种要反复调语气的话，
 * 不该硬编码在代码里。存 md，改完存盘下一轮生效。
 *
 * @param {string} rel  相对 prompts/ 的路径
 * @param {object} vars 占位符
 * @returns {string} 读不到返回 ''
 */
export function readPromptFile(rel, vars) {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    let root = ''
    for (let i = 0; i < 10; i += 1) {
      const pkg = join(dir, 'package.json')
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, 'utf8'))
          if (j && j.name === 'dsh-agent-soul') {
            root = dir
            break
          }
        } catch {
          /* 继续往上 */
        }
      }
      const up = resolve(dir, '..')
      if (up === dir) break
      dir = up
    }
    if (!root) return ''
    const file = join(root, 'prompts', rel.endsWith('.md') ? rel : rel + '.md')
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8').replace(/\{\{([^}]+)\}\}/g, (m, key) => {
      const k = String(key).trim()
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m
    })
  } catch {
    return ''
  }
}

export function boardHint({ board, seen }) {
  if (!board || !board.ok || board.count <= 0) return ''
  const last = Number.isFinite(seen) ? seen : 0
  if (board.count <= last) return ''
  const fresh = board.count - last
  const who = board.newest ? `${board.newest.who} · ${board.newest.date.slice(5)}` : '有人'

  // 优先用 prompts/inject/20-board.md（可编辑），读不到退回内置那句
  const fromFile = readPromptFile('inject/20-board', { 新留言数: fresh, 谁: who })
  if (fromFile.trim()) return fromFile.trim()

  return `共享话板有 ${fresh} 条新留言（最近：${who}）。要看的自己翻 shared/board.md。`
}
