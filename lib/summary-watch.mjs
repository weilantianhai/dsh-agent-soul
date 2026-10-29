/**
 * summary-watch.mjs —— 盯着上下文占用，到阈值就在"这一轮干完之后"叫它写总结
 *
 * 这里的核心难点不是算比例，是**时机**：
 *
 *   到了 80% 的时候，它可能正在跑一个长任务（改一堆文件、跑一堆命令）。
 *   这时候插一句话进去，会把它的注意力打断 —— 而且那句话会混进它当下的工具链里。
 *
 * 所以做法是：
 *   1. 检测到超阈值 → **只记一个"待办"**，不立即发
 *   2. 等这个 agent 变 idle（turn 结束、手里没活）→ 这时候才发
 *
 * 用什么检测：
 *   - 占用率：宿主的 `contextPressure` 投影（不自己 tokenize）
 *   - 忙闲：`agent/status` 事件（'running' / 'idle'）—— 宿主自己发的，不是猜的
 *
 * 为什么不自己定时轮询：轮询会有延迟窗口，而且浪费。用事件驱动。
 */

import { summaryPath, ensureSummaryFile, summaryPrompt, pressureOf, ratioOf, DEFAULT_THRESHOLD } from './summary.mjs'
import { readOwnershipFile } from './guard.mjs'
import { sessionControllerOf } from './infra/host.mjs'
import { join } from 'node:path'

const msg = (err) => String((err && err.message) || err)

/**
 * 起一个看门狗。
 *
 * @param {object} ctx        host context
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {string} opts.ownershipPath   agents.json（会话 → 人格）
 * @param {number} [opts.threshold]     0~1，默认 0.8
 * @param {(err:Error)=>void} [opts.onError]
 * @returns {{dispose:()=>void, pending:Set<string>, status:()=>object}}
 */
export function startSummaryWatch(ctx, opts = {}) {
  const rootDir = opts.rootDir
  const ownershipPath = opts.ownershipPath
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {}

  /** 已经排上队、还没发出的会话 */
  const pending = new Set()
  /** 已经写过的（同一次超阈值只叫一次，避免反复打扰） */
  const done = new Set()
  const offs = []

  const report = (err) => {
    try {
      onError(err instanceof Error ? err : new Error(String(err)))
    } catch {
      /* 回调自己炸了不影响 */
    }
  }

  /** 这个会话该不该写总结：算比例，超过就排队 */
  const consider = (sessionId) => {
    if (!sessionId) return
    if (pending.has(sessionId) || done.has(sessionId)) return
    const pressure = pressureOf(ctx, sessionId)
    const r = ratioOf(pressure)
    if (!r) return // 拿不到窗口就不猜
    if (r.ratio < threshold) return
    pending.add(sessionId)
  }

  /** 真的发出去 */
  const fire = async (sessionId) => {
    try {
      const ownership = readOwnershipFile(ownershipPath)
      const agentId = ownership && ownership[sessionId]
      if (!agentId) {
        // 没有归属 = 临时会话，不写总结（没地方放，也没有"我"）
        pending.delete(sessionId)
        done.add(sessionId)
        return
      }
      const pressure = pressureOf(ctx, sessionId)
      const r = ratioOf(pressure) || { ratio: threshold, used: 0, window: 0 }
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const file = summaryPath({ rootDir, agentId, sessionId, now })

      ensureSummaryFile(file, { agentId, sessionId, ratio: r, date })

      const controller = sessionControllerOf(ctx)
      if (!controller || typeof controller.prompt !== 'function') {
        report(new Error('上下文到阈值了，但宿主没有 sessionController，叫不醒它写总结'))
        pending.delete(sessionId)
        return
      }

      await controller.prompt(
        {
          requestId: `dsh-agent-soul-summary-${sessionId}-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: summaryPrompt({ ratio: r, file, sessionId }) }],
        },
        new AbortController().signal,
      )
      pending.delete(sessionId)
      done.add(sessionId)
    } catch (err) {
      pending.delete(sessionId)
      report(new Error(`写总结叫不醒（${sessionId}）：${msg(err)}`))
    }
  }

  /* ── 事件驱动 ── */

  // ① 每轮结束（turn 收尾）：先看要不要排队，再决定发不发
  try {
    const off = ctx.on('agent/turn-stopping', async ({ agent }) => {
      const sid = agent && agent.id ? String(agent.id) : ''
      if (!sid) return
      consider(sid)
    })
    offs.push(off)
  } catch (err) {
    report(new Error(`挂 agent/turn-stopping 失败：${msg(err)}`))
  }

  // ② 状态变 idle：把排队的发出去（这一刻它手里没活）
  try {
    const off = ctx.on('agent/status', async ({ agent, status }) => {
      if (status !== 'idle') return
      const sid = agent && agent.id ? String(agent.id) : ''
      if (!sid) return
      consider(sid) // 万一 turn-stopping 没触发，这里补一次
      if (pending.has(sid)) await fire(sid)
    })
    offs.push(off)
  } catch (err) {
    report(new Error(`挂 agent/status 失败：${msg(err)}`))
  }

  return {
    pending,
    status() {
      return { threshold, pending: [...pending], done: done.size }
    },
    dispose() {
      for (const off of offs) {
        try {
          if (typeof off === 'function') off()
        } catch {
          /* 解绑失败不影响退出 */
        }
      }
      offs.length = 0
      pending.clear()
    },
  }
}
