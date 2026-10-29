/**
 * writer.mjs —— 落盘：一条记录一行，追加进当天的 jsonl
 *
 * 只干三件事：算路径、判重、写。
 * 不判断"哪句重要"，不摘要，不改字。
 *
 * 设计取舍：
 *   · 每次写完立刻 close（不攒批）—— 进程崩了也不丢已经写过的行；
 *   · 判重靠内存里的 seq 集合，第一次碰某个文件时**从文件里把已有的 seq 读回来**，
 *     所以重启之后同一个 seq 也不会写第二遍；
 *   · 写失败不吞：抛给调用方（hook 会转成 onError），但绝不写坏已有内容（只 append）。
 */

import { mkdirSync, openSync, writeSync, closeSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/* ------------------------------------------------------------------ 时间 */

const pad = (n) => String(n).padStart(2, '0')

/** 本地时区的 ISO8601（带 +08:00 这种偏移），精确到秒 */
export function isoLocal(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return isoLocal(new Date())
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** ISO 串（或 epoch 毫秒）→ 本地日期 YYYY-MM-DD；认不出来就用现在 */
export function localDateOf(when) {
  const iso = isoLocal(when ?? new Date())
  return iso.slice(0, 10)
}

/* ------------------------------------------------------------------ 判重 */

/** 一条记录在文件里的"身份"：有 seq 用 seq，没 seq 用内容指纹 */
function dedupeKey(record) {
  if (record.seq !== null && record.seq !== undefined && record.seq !== '') {
    return `s:${record.seq}`
  }
  return `h:${record.t}|${record.role}|${record.text}`
}

/** 从已有文件里把 key 读回来（坏行跳过，不因为一行坏了就整体失败） */
function readKeys(file) {
  const keys = new Set()
  if (!existsSync(file)) return keys
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return keys
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t)
      if (obj && typeof obj === 'object') keys.add(dedupeKey(obj))
    } catch {
      /* 坏行只跳过，不修、不删 */
    }
  }
  return keys
}

/* ------------------------------------------------------------------ 写 */

/**
 * 建一个 writer。
 * @param {object} opts
 * @param {object} opts.config  已解析的配置（见 config.json）
 * @param {(record:object)=>void} [opts.onWrite] 每真写进一行回调一次
 * @param {(err:Error)=>void}     [opts.onError]
 */
export function createWriter({ config, onWrite, onError } = {}) {
  const cfg = config ?? {}
  const seen = new Map() // 文件路径 -> Set<key>
  let written = 0
  let duplicates = 0
  let failed = 0
  let lastError = null
  let lastPath = null

  const report = (err) => {
    failed += 1
    lastError = err instanceof Error ? err : new Error(String(err))
    if (typeof onError === 'function') {
      try {
        onError(lastError)
      } catch {
        /* 回调自己炸了不能连累写盘 */
      }
    }
  }

  /** 这个会话要不要记、记到哪个目录 */
  function targetOf(sessionId) {
    const sid = String(sessionId ?? '')
    if (!sid) return { log: false, reason: 'no-session-id' }
    const table = cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {}
    const entry = table[sid] ?? null
    const defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {}
    const log = entry && typeof entry.log === 'boolean' ? entry.log : defaults.log === true
    if (!log) return { log: false, reason: 'not-configured' }

    // 目录优先级：会话自己的 dir > baseDir/<sid> > baseDir/<sid>/logs
    let dir = typeof entry?.dir === 'string' && entry.dir.trim() ? entry.dir.trim() : null
    if (!dir && typeof cfg.baseDir === 'string' && cfg.baseDir.trim()) {
      dir = join(cfg.baseDir.trim(), sid, cfg.logsSubdir || 'logs')
    }
    if (!dir) return { log: false, reason: 'no-dir' }
    return { log: true, dir }
  }

  /**
   * 写一条。
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.role
   * @param {string} input.text   原文，一个字不改
   * @param {number|null} [input.seq]
   * @param {string|number|Date} [input.t] 事件时间，不传就用现在
   * @returns {{ok:boolean, path?:string, reason?:string}}
   */
  function write(input) {
    const { sessionId, role, text } = input ?? {}
    if (typeof text !== 'string' || !text) return { ok: false, reason: 'empty-text' }

    const target = targetOf(sessionId)
    if (!target.log) return { ok: false, reason: target.reason }

    const t = isoLocal(input.t ?? new Date())
    const record = {
      t,
      role: String(role || 'unknown'),
      text,
      seq: Number.isFinite(Number(input.seq)) && input.seq !== null ? Number(input.seq) : null,
    }

    const file = join(target.dir, `${t.slice(0, 10)}.jsonl`)
    try {
      // 目录不存在就建（目录不存在就自动建 —— 这里报错会把整个日志链路拖死）
      if (!existsSync(target.dir)) mkdirSync(target.dir, { recursive: true })

      let keys = seen.get(file)
      if (!keys) {
        keys = readKeys(file)
        seen.set(file, keys)
      }

      const key = dedupeKey(record)
      if (keys.has(key)) {
        duplicates += 1
        return { ok: false, reason: 'duplicate', path: file }
      }

      const fd = openSync(file, 'a')
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`)
      } finally {
        closeSync(fd)
      }

      keys.add(key)
      written += 1
      lastPath = file

      const out = { ...record, sessionId: String(sessionId), path: file, date: t.slice(0, 10) }
      if (typeof onWrite === 'function') {
        try {
          onWrite(out)
        } catch (err) {
          // 接的人自己炸了，不影响已经落盘的行
          report(err)
        }
      }
      return { ok: true, path: file }
    } catch (err) {
      report(err)
      return { ok: false, reason: 'write-failed', path: file, error: err }
    }
  }

  /** 立刻落盘策略下没有缓冲；留着是为了接口一致（stop 时调用） */
  function flush() {
    return written
  }

  function stats() {
    return { written, duplicates, failed, lastError: lastError ? String(lastError.message || lastError) : null, lastPath }
  }

  return { write, flush, stats, targetOf }
}
