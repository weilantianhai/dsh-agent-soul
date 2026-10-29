/**
 * summary.mjs —— 上下文快到顶了，叫 agent 自己写一份交接总结
 *
 * 为什么要有这个：上下文的压缩（compaction）是宿主的机制，它压完会丢细节，
 * 而"我这一段干了什么、做到哪、下一步该干嘛"这件事，只有 agent 自己知道。
 * 所以在压缩之前，让它先写一份 —— 下次醒来先读这个，比读被压扁的历史强。
 *
 * 阈值从哪来：**不用自己估**。宿主有个 `contextPressure` 投影，里面有
 * `pressureTokens` / `surfaceTokens` / `contextWindow`，那是宿主自己算的
 * 上下文压力。我们只读它，不自己 tokenize。
 *
 * 触发时机（tianhai 的要求）：
 *   - 到 80% 就想叫，但**如果它正在干活，不能打断**
 *   - 排进队列：这一轮跑完（turn 结束、agent 变 idle）再叫
 *
 * 落地位置：`agents/<人格>/summary/<会话>/<日期>-<时间>.md`
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { sessionsOf, sessionProjectionsOf } from './infra/host.mjs'
import { dirname, join } from 'node:path'

const msg = (err) => String((err && err.message) || err)

/** 默认阈值：到 80% 就写总结 */
export const DEFAULT_THRESHOLD = 0.8

/**
 * 从 `contextPressure` 投影里算出占用率。
 *
 * 宿主的投影长这样（dsh-token-meter 的 contextPressureProjectionDefinition）：
 *   { contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }
 *
 * 三个都要防：
 *   - 没有 contextWindow（模型没报窗口）→ 算不了，返回 null
 *   - pressureTokens 没有 → 退到 surfaceTokens
 *   - 任何一个是 0 或负数 → 算不了
 *
 * @param {object|null} pressure  投影值
 * @returns {{ratio:number, used:number, window:number, source:string}|null}
 */
export function ratioOf(pressure) {
  if (!pressure || typeof pressure !== 'object') return null
  const win = Number(pressure.contextWindow)
  if (!Number.isFinite(win) || win <= 0) return null
  const used =
    Number.isFinite(Number(pressure.pressureTokens)) && Number(pressure.pressureTokens) >= 0
      ? Number(pressure.pressureTokens)
      : Number.isFinite(Number(pressure.surfaceTokens))
        ? Number(pressure.surfaceTokens)
        : NaN
  if (!Number.isFinite(used) || used < 0) return null
  return {
    ratio: used / win,
    used,
    window: win,
    source: Number.isFinite(Number(pressure.pressureTokens)) ? 'pressureTokens' : 'surfaceTokens',
  }
}

/**
 * 读一个会话的 contextPressure 投影。
 *
 * 为什么这么绕：投影挂在 session 上，key 是 'contextPressure'。不同版本
 * 可能给的是 `projections.values()` 或 `projectionValues`，两种都试。
 *
 * @param {object} ctx  host context
 * @param {string} sessionId
 * @returns {object|null}
 */
export function pressureOf(ctx, sessionId) {
  try {
    const sessions = sessionsOf(ctx)
    if (!sessions) return null
    const session = sessions.get(sessionId)
    if (!session) return null

    /*
     * ⚠️ 正确读法只有这一个：
     *     ctx.sessionProjections.stateOf(session, 'contextPressure')
     *
     * 2026-10-29 查出来的根因。原来的写法是**猜的**：
     *     session.projections.values()
     *     session.projectionValues()
     * 这两个方法**在 Session 对象上都不存在**，所以这里永远返回 null，
     * 于是 ratioOf 永远拿到 null，consider() 里 `if (!r) return` 直接放行 ——
     * 看门狗一次都没触发过（真机状态：done: 0、pending: []）。
     *
     * 不是"设计不成立"，是**读数方法一直是错的**。
     *
     * stateOf 会返回宿主的原始 state（含 contextWindow / pressureTokens /
     * surfaceTokens），是 client-visible 的那份 view 的底层数据。
     */
    const projections = sessionProjectionsOf(ctx)
    if (!projections || typeof projections.stateOf !== 'function') return null
    return projections.stateOf(session, 'contextPressure') || null
  } catch {
    return null
  }
}

/**
 * 总结文件落在哪：`agents/<人格>/summary/<会话>/<日期>-<时分>.md`
 *
 * 为什么要按会话分：一个 agent 可能有多个会话同时在想事情，
 * 混在一个文件里会互相覆盖。
 *
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {string} opts.agentId
 * @param {string} opts.sessionId
 * @param {Date}   [opts.now]
 * @returns {string}
 */
export function summaryPath({ rootDir, agentId, sessionId, now }) {
  const d = now || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`
  return join(String(rootDir), 'agents', String(agentId), 'summary', String(sessionId), `${date}-${time}.md`)
}

/**
 * 叫醒词：让它写一份交接总结。
 *
 * 和日记的区别：日记写"我过了一天"，总结写"我干到哪了、下一步接什么"。
 * 所以总结要**具体、可执行**，日记要**有温度**。这个区别必须写在提示里，
 * 否则它会写成一篇心情散文，对下一次醒来毫无用处。
 *
 * @param {object} opts
 * @param {object} opts.ratio      {ratio, used, window}
 * @param {string} opts.file       总结文件路径
 * @param {string} opts.sessionId
 * @returns {string}
 */
export function summaryPrompt({ ratio, file, sessionId }) {
  const pct = Math.round((ratio && ratio.ratio ? ratio.ratio : 0) * 100)
  const rel = String(file).replaceAll('\\', '/')
  return [
    `【上下文到 ${pct}% 了，写一份交接总结】`,
    '',
    `这个会话的上下文快满了（${ratio ? Math.round(ratio.used) : '?'} / ${ratio ? ratio.window : '?'} tokens）。`,
    '压缩之后细节会丢掉 —— 所以在压缩之前，先把"这段干了什么"记下来。',
    '',
    '**这不是日记。** 日记写"我过了一天"，总结写"我干到哪了、下一步接什么"。',
    '具体、可执行，别写心情散文。',
    '',
    '写这几件事：',
    '',
    '1. **这段在做什么** —— 一句话说清任务是什么。',
    '2. **做到哪了** —— 已经完成什么，哪些还没做。',
    '3. **关键决定和原因** —— 为什么这么选，试过什么不行的。',
    '4. **下一步该干嘛** —— 具体到能直接动手，不是"继续优化"。',
    '5. **踩过的坑** —— 有什么是"下次别再犯"的。',
    '',
    `写到 \`${rel}\`（目录已经建好）。`,
    '',
    `（会话 ${sessionId}）`,
  ].join('\n')
}

/**
 * 建目录 + 写骨架。不写正文 —— 正文是让它自己写的。
 *
 * @param {string} file
 * @param {object} meta  {agentId, sessionId, ratio, date}
 * @returns {{ok:boolean, error?:string}}
 */
export function ensureSummaryFile(file, meta = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) return { ok: true }
    const head = [
      `# 交接总结 · ${meta.date || ''}`,
      '',
      `> 会话：${meta.sessionId || ''} · 归属：${meta.agentId || ''}`,
      `> 触发：上下文到 ${Math.round((meta.ratio && meta.ratio.ratio ? meta.ratio.ratio : 0) * 100)}%`,
      '',
      '',
    ].join('\n')
    writeFileSync(file, head, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: msg(err) }
  }
}
