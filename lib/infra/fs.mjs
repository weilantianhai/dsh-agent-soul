/**
 * infra/fs.mjs —— 文件读写的唯一入口。
 *
 * 为什么要单独一层：
 *   1. `readJson` 原来在 lib/routes.mjs 和 src/Daily/index.mjs 各有一份
 *      （逻辑一致）。两份实现一定会分叉。
 *   2. **写数据前先备份**这条规矩，散在五六个地方各写一遍，
 *      漏掉一处就是"用户的数据没了，而且回不去"。
 *      收在这里之后，只有一种写法，不可能漏。
 *
 * 这一层不认识"人格""会话""配置" —— 它只知道文件和 JSON。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * 读 JSON，坏文件/不存在都返回 fallback。
 *
 * 为什么不抛：配置、登记表、归属表这些，读不到应该走"默认值"，
 * 而不是让整个插件起不来。**但要区分"没有"和"坏了"** —— 需要区分时
 * 用 readJsonStrict。
 */
export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 读 JSON，**但只接受对象**。数组 / 字符串 / 数字 / null 一律当读不到。
 *
 * 为什么单独一个：src/Daily 原来有一份自己的 readJson，比这里多一句
 * `data && typeof data === 'object'`。那是有意的 —— 归属表、登记表
 * 本该是对象，万一读到数组说明文件被别的东西写坏了，应该走默认值，
 * 而不是拿一个数组当表用。合并时保留了这个语义，没有简化掉。
 */
export function readJsonObject(file, fallback = null) {
  const data = readJson(file, null)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback
}

/**
 * 读 JSON，坏了就抛。给"文件必须存在且合法"的场景用。
 * @returns {{ok: true, value: any} | {ok: false, error: string, missing: boolean}}
 */
export function readJsonStrict(file) {
  if (!existsSync(file)) return { ok: false, error: '文件不存在', missing: true }
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), missing: false }
  }
}

/**
 * 原子写：先写临时文件再改名。
 *
 * 为什么不能直接 writeFileSync：写到一半断电/崩溃 = 文件截断 = JSON 坏掉
 * = 下次读出来是 fallback = **用户的数据看起来凭空消失了**。
 * 改名在同一个盘上是原子的，要么是旧的、要么是新的，没有中间态。
 */
export function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}


/**
 * 覆盖前留一份带时间戳的备份。
 *
 * 只备份**已存在**的文件（第一次创建没什么可丢的）。
 * 备份失败不抛 —— 不能让"备份不了"拦住"保存"，那是因小失大。
 *
 * @returns {string|null} 备份文件路径；没备份返回 null
 */
export function withBackup(file) {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.bak-${stamp}`
  try {
    copyFileSync(file, dest)
    return dest
  } catch {
    return null
  }
}

