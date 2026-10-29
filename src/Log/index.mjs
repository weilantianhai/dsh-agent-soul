/**
 * index.mjs —— 模块入口
 *
 * 对外只有三个门：start / stop / status（+ 一个给宿主自己接线的 handle）。
 *
 *   import { start, stop, status } from '<仓库根>/src/Log/index.mjs'
 *   await start({ ctx })              // ctx 是 DSH 的宿主上下文（要能 ctx.on）
 *
 * 没有 ctx 也能 start：那时钩子不挂，谁想用就自己把 handle 接到事件上。
 * 这样测试、补录、单跑都不依赖宿主。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createWriter } from './writer.mjs'
import { createHook } from './hook.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_PATH = join(MODULE_DIR, 'config.json')

/** 兜底配置：不记任何会话，也不崩 */
const FALLBACK_CONFIG = {
  enabled: false,
  baseDir: '',
  selfName: 'assistant',
  ownerMid: '',
  ownerName: 'tianhai',
  defaultRole: 'tianhai',
  sessions: {},
  defaults: { log: false },
}

let state = {
  running: false,
  attached: false,
  config: FALLBACK_CONFIG,
  configPath: DEFAULT_CONFIG_PATH,
  hook: null,
  writer: null,
  off: null,
  startedAt: null,
  written: 0,
  skipped: 0,
  sessions: [],
  lastError: null,
}

function readConfig(configPath, onError) {
  const path = resolve(configPath || DEFAULT_CONFIG_PATH)
  if (!existsSync(path)) {
    return { config: FALLBACK_CONFIG, path, error: `配置文件不存在：${path}` }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置必须是一个 JSON 对象')
    }
    return { config: { ...FALLBACK_CONFIG, ...parsed }, path, error: null }
  } catch (err) {
    const e = new Error(`配置文件读不了（${path}）：${err.message}`)
    if (typeof onError === 'function') {
      try {
        onError(e)
      } catch {
        /* 忽略 */
      }
    }
    return { config: FALLBACK_CONFIG, path, error: e.message }
  }
}

/**
 * 开始监听。
 * @param {object} [opts]
 * @param {object} [opts.ctx]         DSH 宿主上下文（有 ctx.on 就会自动挂 session/event）
 * @param {string} [opts.configPath]  配置文件路径，默认模块目录下的 config.json
 * @param {(record:object)=>void} [opts.onWrite]  每写一条回调
 * @param {(err:Error)=>void} [opts.onError]      出错回调（不会吞）
 * @returns {Promise<{running:boolean, reason?:string}>}
 */
export async function start(opts = {}) {
  await stop()

  const { config, path, error } = readConfig(opts.configPath, opts.onError)
  const onError = typeof opts.onError === 'function' ? opts.onError : null

  state.config = config
  state.configPath = path
  state.lastError = error ?? null

  // enabled: false → 整体不干活，但不报错、不崩
  if (config.enabled === false) {
    state.running = false
    return { running: false, reason: 'disabled' }
  }

  const writer = createWriter({ config })
  const hook = createHook({
    config,
    writer,
    onWrite: opts.onWrite,
    onError: (err) => {
      state.lastError = String(err?.message || err)
      if (onError) {
        try {
          onError(err)
        } catch {
          /* 忽略 */
        }
      }
    },
  })

  state.writer = writer
  state.hook = hook
  state.attached = false
  state.startedAt = new Date().toISOString()
  state.written = 0
  state.skipped = 0
  state.sessions = []
  state.running = true

  if (opts.ctx) {
    try {
      state.off = hook.attach(opts.ctx)
      state.attached = true
    } catch (err) {
      state.running = false
      state.lastError = String(err?.message || err)
      if (onError) {
        try {
          onError(err)
        } catch {
          /* 忽略 */
        }
      }
      return { running: false, reason: 'attach-failed' }
    }
  }

  return { running: true }
}

/** 停止监听。立刻落盘策略下没有缓冲，flush 只是把账对一下 */
export async function stop() {
  if (state.off) {
    try {
      state.off()
    } catch {
      /* 解绑失败不影响退出 */
    }
  }
  if (state.hook) state.hook.dispose()
  if (state.writer) {
    try {
      state.writer.flush()
    } catch {
      /* 忽略 */
    }
  }
  state.off = null
  state.hook = null
  state.writer = null
  state.attached = false
  state.running = false
  return status()
}

/**
 * 现在什么样。
 * @returns {{running:boolean, sessions:string[], written:number, skipped:number, ...}}
 */
export function status() {
  const snap = state.hook ? state.hook.snapshot() : null
  const w = state.writer ? state.writer.stats() : null
  return {
    running: state.running,
    attached: state.attached,
    sessions: snap ? snap.sessions : [],
    written: snap ? snap.written : 0,
    skipped: snap ? snap.skipped : 0,
    reasons: snap ? snap.reasons : {},
    seen: snap ? snap.seen : 0,
    visible: w ? w.written : 0,
    duplicates: w ? w.duplicates : 0,
    failed: w ? w.failed : 0,
    configPath: state.configPath,
    startedAt: state.startedAt,
    lastError: state.lastError ?? (snap ? snap.lastError : null),
  }
}

/** 给宿主自己接线用：没走 ctx 的时候，把事件往这儿塞 */
export function handle(session, event) {
  if (!state.running || !state.hook) return
  state.hook.handle(session, event)
}

/** 换过配置之后重新加载（不重启进程） */
export async function reload(opts = {}) {
  return start({ ...opts, ctx: opts.ctx })
}
