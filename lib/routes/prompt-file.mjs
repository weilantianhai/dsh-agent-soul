/**
 * routes/prompt-file.mjs —— 读插件自带的提示词文件。
 *
 * 这些文件在 `<包根>/prompts/` 里，是**用户可以直接编辑的**。
 * 读不到就返回空串，调用方退回内置文案 —— 一个文件坏了不该让整个功能没了。
 *
 * 为什么单独一个文件：找包根的逻辑（往上走、认 package.json.name）
 * 很容易写错，而且位置变过好几次（modules/ → lib/vendor/ → src/）。
 * 收在一处，只可能错一次。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 往上找这个包的根：认 `package.json` 里的 `name === 'dsh-agent-soul'`。
 *
 * 为什么不数层数：同一份文件在仓库里、在 node_modules 里、在打包后，
 * 层数都不一样。认包名最稳。
 */
export function findPackageRoot(from) {
  let dir = from ? resolve(String(from)) : dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8'))
        if (j && j.name === 'dsh-agent-soul') return dir
      } catch {
        /* 坏文件，继续往上 */
      }
    }
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return ''
}

/**
 * 读一个提示词文件，替换 `{{占位}}`。
 *
 * @param {string} rel   相对 `prompts/` 的路径，如 `'daily/00-wake'`
 * @param {object} [vars] 占位符的值
 * @returns {string} 内容；找不到返回空串
 */
export function readPrompt(rel, vars) {
  try {
    const pkgRoot = findPackageRoot()
    if (!pkgRoot) return ''
    const file = join(pkgRoot, 'prompts', rel.endsWith('.md') ? rel : `${rel}.md`)
    if (!existsSync(file)) return ''
    const raw = readFileSync(file, 'utf8')
    return raw.replace(/\{\{([^}]+)\}\}/g, (m, key) => {
      const k = String(key).trim()
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m
    })
  } catch {
    return ''
  }
}
