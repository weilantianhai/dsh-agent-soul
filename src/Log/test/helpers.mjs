/**
 * test/helpers.mjs —— 测试用的小工具（只在 test 里用）
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pad = (n) => String(n).padStart(2, '0')

const created = []

/** 一个干净的临时目录 */
export function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  created.push(dir)
  return dir
}

/** 跑完把临时目录删掉 */
export function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 删不掉就算了，反正在 temp 里 */
    }
  }
}

/** 写一份配置进去，返回路径 */
export function configFile(dir, config) {
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  return path
}

/** 假的宿主 ctx：接住 session/event 的处理器 */
export function fakeCtx() {
  const handlers = new Set()
  return {
    handlers,
    on(event, fn) {
      if (event === 'session/event') {
        handlers.add(fn)
        return () => handlers.delete(fn)
      }
      return () => {}
    },
    emit(session, event) {
      for (const fn of [...handlers]) fn(session, event)
    },
  }
}

/** 读 jsonl，返回解析后的数组（坏行跳过） */
export function readLog(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** 目录里所有 jsonl 文件名 */
export function logFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
}

/**
 * 用本地时间造一个 ISO 串。
 * 这样测试在任何时区都成立：进去是本地 23:59，出来还是本地 23:59。
 */
export function localIso(y, m, d, h, mi, s = 0) {
  return new Date(y, m - 1, d, h, mi, s).toISOString()
}

/** 同一天的 YYYY-MM-DD 字面量 */
export function dateKey(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** 一条用户消息事件 */
export function userEvent({ text, seq, at, mid, kind = 'user' }) {
  return {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      source: { kind, ...(mid ? { mid } : {}) },
      ...(seq !== undefined ? { seq } : {}),
      ...(at !== undefined ? { at } : {}),
    },
  }
}

/** 一条助手消息事件 */
export function assistantEvent({ text, seq, at, interrupted = false }) {
  return {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text }] },
      interrupted,
      ...(seq !== undefined ? { seq } : {}),
      ...(at !== undefined ? { at } : {}),
    },
  }
}

export const SESSION = { id: 'bili-whale', sessionId: 'bili-whale' }
