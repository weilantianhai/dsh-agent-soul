/**
 * routes/board.mjs —— 共享话板（跨 agent 留言）。
 *
 * 两个接口：读内容、在资源管理器里打开。
 * 话板是 `shared/board.md`，所有 agent 都能看 —— 这是唯一一个"共享"的地方。
 *
 * ⚠️ 行为必须和从 routes.mjs 搬出来之前**一字不差**：
 * 返回字段是 `dir`（不是 path）、`/board/open` 会先建 shared 目录、
 * 打开失败返回 500 而不是 200。这些都是前端在用的。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { json } from './http.mjs'
import { cleanPath } from '../config.mjs'

const msg = (err) => String((err && err.message) || err)

/** 在资源管理器里打开一个目录。只有后端能起进程，浏览器碰不到本地路径 */
export function openInFileManager(dir) {
  try {
    const cmd =
      process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
    if (child && typeof child.unref === 'function') child.unref()
    return null
  } catch (err) {
    return msg(err)
  }
}

/**
 * @param {Function} route  registerRoutes 给的注册函数
 * @param {object} paths    derivePaths 的结果
 */
export function registerBoardRoutes(route, { paths }) {
  route('GET', '/board', async (_req, res) => {
    const boardPath = join(paths.rootDir, 'shared', 'board.md')
    try {
      const text = existsSync(boardPath) ? readFileSync(boardPath, 'utf8') : ''
      json(res, 200, { ok: true, text, path: cleanPath(boardPath) })
    } catch (err) {
      json(res, 200, { ok: true, text: '', path: cleanPath(boardPath), error: msg(err) })
    }
  })

  route('POST', '/board/open', async (_req, res) => {
    const shared = join(paths.rootDir, 'shared')
    try {
      mkdirSync(shared, { recursive: true })
    } catch {
      /* 建不出来就退回根目录 */
    }
    const dir = existsSync(shared) ? shared : paths.rootDir
    const error = openInFileManager(dir)
    if (error) {
      json(res, 500, { ok: false, error, dir: cleanPath(dir) })
      return
    }
    json(res, 200, { ok: true, dir: cleanPath(dir) })
  })
}
