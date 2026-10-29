/**
 * index.mjs —— Daily：晚上定点叫醒，让她当场写日记
 *
 * 依据 `design-tools-daily-prompt.md` §2.2：
 *
 *   > 不是我前面说的"攒稿子等下次"。**是晚上定点叫醒，塞一段上下文，它当场把日记写掉。**
 *
 * 它只做三件：**筛、产稿、叫醒**。写日记的是她本人 —— Daily 不代笔。
 *
 * 叫醒之后**不追**：投递完这一轮就结束，不等着、不重试、不连叫三次
 * （设计文档 §2.2.1：一个天天被催着交日记的 agent，写出来的东西会是应付的）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonObject as readJson } from '../../lib/infra/fs.mjs'

import {
  DEFAULT_CONFIG,
  localDate,
  planSessions,
  buildDraft,
  ensureDiary,
  wakeText,
  draftPath,
  diaryPath,
  addDays,
  readState,
  writeState,
  wokeToday,
  markWoke,
} from './daily.mjs'

const msg = (err) => String((err && err.message) || err)

const state = {
  startedAt: null,
  running: false,
  nextAt: null,
  catchUp: null,
  lastRun: null,
  lastReport: null,
  lastError: null,
  timer: null,
}

/* ------------------------------------------------------------------ 时间 */

/** 把 "23:30" 解析成 { hour, minute }；写错了退回默认 */
export function parseTime(text, fallback = '23:30') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return parseTime(fallback, '23:30')
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return parseTime(fallback, '23:30')
  }
  return { hour, minute }
}

/** 下一次该在什么时候（毫秒时间戳） */
export function nextRunAt(now, timeText) {
  const { hour, minute } = parseTime(timeText)
  const next = new Date(now.getTime())
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/* ------------------------------------------------------------------ 宿主 */

function controllerOf(ctx) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const c = ctx.get('sessionController')
      if (c && typeof c.prompt === 'function') return c
    }
  } catch {
    /* 没 inject 过就当没有 */
  }
  try {
    if (ctx.sessionController && typeof ctx.sessionController.prompt === 'function') return ctx.sessionController
  } catch {
    /* 同上 */
  }
  return null
}


/* ---------------------------------------------------------------- 跑一轮 */

/**
 * 跑一轮。定时器和测试都走这一个入口。
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {object} [opts.config]     { enabled, time, minLines, agents }
 * @param {object} [opts.ownership]  会话 → agent（不给就自己读）
 * @param {object} [opts.registry]   不给就自己读
 * @param {(err:Error)=>void} [opts.onError]
 * @param {string} [opts.date]       默认今天（测试用）
 * @param {Date}   [opts.now]
 * @param {boolean} [opts.force]     忽略"今天已经叫过"
 */
export async function runOnce(ctx, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) }
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {}
  const report = (err) => {
    state.lastError = msg(err)
    try {
      onError(err instanceof Error ? err : new Error(String(err)))
    } catch {
      /* 回调自己炸了不影响任务 */
    }
  }

  const now = opts.now instanceof Date ? opts.now : new Date()
  const date = opts.date || localDate(now)
  const rootDir = String(opts.rootDir || '')
  const stateFile = join(rootDir, 'system', 'daily.state.json')

  if (cfg.enabled === false) return { date, woke: [], skipped: [], reason: 'disabled' }

  const controller = controllerOf(ctx)
  if (!controller) {
    report(new Error('Daily：宿主没有 sessionController，今晚叫不醒她'))
    return { date, woke: [], skipped: [], reason: 'no-session-controller' }
  }

  const st = readState(stateFile)
  const already = wokeToday(st, date)
  // 一天只跑一次：成功叫醒的算，**全部失败也算**（设计文档：失败了不重试）
  const ranToday = Boolean(st.byDate && st.byDate[date] && st.byDate[date].ran)
  if (!opts.force && (already.size || ranToday)) {
    return { date, woke: [], skipped: [], reason: 'already-ran-today' }
  }

  // 1) 问宿主要会话表（谁在跑、谁空、谁最近动过）
  let summaries = []
  try {
    /*
     * signal 必须是**真的 AbortSignal**，否则别传。
     *
     * 2026-10-29 真机踩到：`opts.signal || new AbortController().signal` 看着没问题，
     * 但 start() 传进来的 opts 是整个配置对象，`opts.signal` 有可能是别的东西
     * （或者后来被 spread 进去的任意字段），于是宿主拿到一个没有 throwIfAborted
     * 的对象 → 三个会话全部 wake-failed: signal.throwIfAborted is not a function。
     *
     * 现在先验形状，形状不对就用新的。
     */
    const sig =
      opts.signal && typeof opts.signal.throwIfAborted === 'function'
        ? opts.signal
        : new AbortController().signal
    const value = await controller.list({}, sig)
    summaries = Array.isArray(value && value.items) ? value.items : []
  } catch (err) {
    report(new Error(`Daily：拿不到会话表 → ${msg(err)}`))
    return { date, woke: [], skipped: [], reason: 'list-failed' }
  }

  /*
   * ⚠️ 只保留「侧边栏里能看到」的会话。
   *
   * 为什么（2026-10-29 用户第三次说数字不对）：
   * sessionController.list() 给的是**磁盘上全部会话**（本机 141 个），
   * 而侧边栏另外按工作区过滤过（只剩 77 个）——
   * 那 64 个差额是旧工作区、已删但没清、别人的目录……
   * 用户根本看不到它们，界面上"跳过 141 个"看着就像坏了。
   *
   * 判断口径和设置页的会话数完全一致：
   *   (工作区 sessionIds ∪ 置顶) − 归档
   *
   * 读不到清单就**不过滤**（宁可多露，不能因为读不到就一个都不叫）。
   */
  const sidebarFilter = opts.sidebarSessions
  if (sidebarFilter instanceof Set) {
    const before = summaries.length
    summaries = summaries.filter((x) => sidebarFilter.has(String((x && x.sessionId) || '')))
    state.lastFiltered = { before, after: summaries.length }
  }

  const ownership = opts.ownership || readJson(join(rootDir, 'private', 'agents.json'), {})
  const registry = opts.registry || readJson(join(rootDir, 'system', 'sessions.json'), { sessions: {} })

  // 2) 筛（四重过滤 + 忙就跳过）
  const plan = planSessions({ rootDir, summaries, ownership, registry, config: cfg, date, now })

  const woke = []
  const skipped = plan.skipped.slice()

  /*
   * 诊断：把「宿主给了几条、其中几条有人格、几条今天动过」记下来。
   *
   * 为什么加（2026-10-29 真机）：点手动跑，界面说"跳过 141 个、叫醒 0 个"，
   * 但明明有 3 个会话挂了人格。光看结果猜不出来是哪一步筛掉的，
   * 所以把中间量交出去，一眼定位。
   */
  const diag = {
    hostItems: summaries.length,
    withAgent: 0,
    activeToday: 0,
    readyAfterFilter: plan.ready.length,
    skippedTotal: plan.skipped.length,
  }
  /*
   * 有人格的会话，逐个说清它的下场。
   *
   * 为什么单列（2026-10-29）：界面上"跳过 141、叫醒 0"根本看不出问题在哪 ——
   * 141 里绝大多数是没绑人格的（正常），真正该看的是那几个人格会话
   * 被哪一步筛掉了。把它们单独列出来，一眼定位。
   */
  diag.failed = []
  diag.owned = []
  for (const s0 of summaries) {
    const sid = String((s0 && s0.sessionId) || '')
    if (!sid) continue
    if (ownership && ownership[sid]) diag.withAgent += 1
    const updated = Number(s0 && s0.updatedAt)
    const isToday = Number.isFinite(updated) && localDate(new Date(updated)) === date
    if (isToday) diag.activeToday += 1
    const agent = ownership && ownership[sid]
    if (!agent) continue
    const readyItem = plan.ready.find((r) => r.sessionId === sid)
    const why = readyItem
      ? readyItem.wasBusy
        ? 'ready(queued)' // 它当时在跑，消息排队等这一轮结束
        : 'ready'
      : (plan.skipped.find((x) => x.sessionId === sid) || {}).reason || 'unknown'
    diag.owned.push({
      sessionId: sid,
      agent: String(agent),
      updatedToday: isToday,
      result: why,
    })
  }

  for (const item of plan.ready) {
    /*
     * 第二道拦截：这个会话今天已经叫过了。
     * **force 要能穿透它** —— 手动触发就是用来"再跑一次看看"的，
     * 不穿透的话按了没反应，等于没这个按钮。
     */
    if (!opts.force && already.has(item.sessionId)) {
      skipped.push({ sessionId: item.sessionId, reason: 'already-woke-today' })
      continue
    }
    try {
      // 3a) 产稿（按会话分开，免得两个人格的会话重名）
      const draft = buildDraft({ rootDir, agentId: item.agentId, sessionId: item.sessionId, date })
      const draftFile = draftPath({ rootDir, agentId: item.agentId, sessionId: item.sessionId, date })
      mkdirSync(join(draftFile, '..'), { recursive: true })
      writeFileSync(draftFile, draft.text, 'utf8')

      // 3b) 把日记文件建好并打上会话标签（她自己写过的就一个字不动）
      const ensured = ensureDiary({ rootDir, agentId: item.agentId, sessionId: item.sessionId, date })

      // 3c) 昨天写没写 —— 今天报一句，不补稿、不催、不罚
      const yMissing = !existsSync(diaryPath({ rootDir, agentId: item.agentId, sessionId: item.sessionId, date: addDays(date, -1) }))

      // 3d) 叫醒：投递完就不管了
      const text = wakeText({
        agentId: item.agentId,
        sessionId: item.sessionId,
        date,
        draft: draftFile,
        diary: ensured.file,
        rootDir,
        yesterdayMissing: yMissing,
      })
      // 叫醒用的「来源」：DSH 的 sessionController.prompt(request, source) 第二个参数
      // 决定这条消息在界面上长什么样 ——
      //   {kind:'schedule'} → 「自动化任务」灰卡片，不是一条用户消息
      //   {kind:'user-rpc'} / 不传 → 看起来像主人在说话（我们以前就是这个 bug：
      //                              第二个参数误传了 AbortSignal，形状根本不对）
      /*
       * 单独包一层，只为抓栈 —— 失败时要能看出是**哪一步**抛的。
       * 2026-10-29：只记 message 完全定位不了，白查好几轮。
       */
      /*
       * ⚠️ 第二个参数是 **AbortSignal**，不是 source。
       *
       * 2026-10-29 真机栈定死的（抓了 10 帧）：
       *   at Proxy.prompt (dsh-api-session-controller/lib/index.js:3219:11)
       * 那一行长这样：
       *   async prompt(request, signal) { signal.throwIfAborted(); ... }
       *
       * 所以传 {kind:'schedule'} = 一个没有 throwIfAborted 的对象 = 每个会话都崩。
       *
       * 那 source 去哪了？宿主内部造，kind **写死在 "user"**：
       *   const source = { kind: 'user', rpcId: request.requestId, ... }
       * 也就是说界面上它永远是一条用户消息，**插件改不了**。
       * 之前这里写着"传 {kind:'schedule'} 会显示成自动化任务卡片"—— 那条路不存在。
       *
       * （文件里还有个 SessionCommandController.prompt(request, source)，
       *  那是宿主内部用的，不是 Remote 代理暴露给插件的那一层。别搞混。）
       */
      let promptStack = ''
      try {
        await controller.prompt(
          {
            requestId: `dsh-memory-daily-${date}-${item.sessionId}`,
            sessionId: item.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          // 第二个参数是 signal —— 传个真的
          new AbortController().signal,
        )
      } catch (e) {
        promptStack = String((e && e.stack) || '').split(String.fromCharCode(10)).slice(0, 10).join(' <- ')
        throw Object.assign(e, { __promptStack: promptStack })
      }

      /*
       * ⚠️ prompt() 返回 {accepted:true} **只代表消息进了内存里的 inbox**，
       * 不代表它落盘、更不代表会话真的会跑一轮。
       *
       * 2026-10-29 真机踩到：两次补跑都"成功"了（woke 里有它），
       * 但会话日志里一条记录都没有 —— 消息挂在 inbox 里，没人取。
       *
       * 宿主自己的定时任务（dsh-schedule）投完立刻做了一件事：
       *   agent.followup(message)
       *   if (!await ctx.sessions.flush(agent.session)) throw ...
       * 也就是**必须等持久化确认**。我们也得做。
       */
      let flushed = true
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
        const session = sessions && typeof sessions.get === 'function' ? sessions.get(item.sessionId) : null
        if (session) {
          const ok = await sessions.flush(session)
          flushed = ok !== false
        }
      } catch (err) {
        flushed = false
        report(new Error(`Daily：${item.sessionId} 的消息可能没落盘 → ${msg(err)}`))
      }

      if (flushed) {
        woke.push(item.sessionId)
      } else {
        // 没落盘就别当"叫过了" —— 让它下次还能重试
        skipped.push({ sessionId: item.sessionId, reason: 'wake-unflushed' })
        report(new Error(`Daily：${item.sessionId} 的消息没落盘，这次不算叫过`))
      }
    } catch (err) {
      // 一个叫不醒不影响别的；**不重试**
      /*
       * 记栈，不只记 message。
       * 2026-10-29 踩到：只记了 "signal.throwIfAborted is not a function"，
       * 完全看不出是哪个调用抛的，白查半天。栈里一行就能定位。
       */
      const where = (err && err.__promptStack) || (err && err.stack ? String(err.stack).split(String.fromCharCode(10)).slice(0, 8).join(' | ') : '')
      skipped.push({ sessionId: item.sessionId, reason: `wake-failed:${msg(err)}`, where })
      diag.failed.push({ sessionId: item.sessionId, error: msg(err), where })
      report(new Error(`Daily：叫不醒 ${item.sessionId} → ${msg(err)}`))
    }
  }

  // 4) 记下来：今天这些叫过了
  st.byDate = st.byDate || {}
  for (const sid of woke) markWoke(st, date, sid)
  st.lastRun = new Date(now).toISOString()
  if (!st.byDate[date]) st.byDate[date] = { woke: [] }
  st.byDate[date].ran = true
  /*
   * 存 skipped 时**优先留有人格的会话**。
   *
   * 为什么（2026-10-29 用户问"我这个会话也挂了人格你怎么不说"）：
   * 原来一律 slice(0, 50)，而宿主给的列表里有 140 多个 ——
   * 大部分是没绑人格的（正常的"跳过"），真正有人格的那几个
   * 反而被截掉了，排查时根本看不到它的下场。
   *
   * 现在：有人格的排前面，剩下的按数量补。
   */
  const ownedIds = new Set(Object.keys(ownership || {}).filter((k) => ownership[k]))
  const ownedSkipped = skipped.filter((x) => ownedIds.has(x.sessionId))
  const otherSkipped = skipped.filter((x) => !ownedIds.has(x.sessionId))
  st.byDate[date].skipped = [...ownedSkipped, ...otherSkipped].slice(0, 50)
  // 有人格的总数单独记，不受 50 条限制
  st.byDate[date].skippedOwned = ownedSkipped.length
  writeState(stateFile, st)

  // diag 带出去 —— 界面上能看出是哪一步筛掉的（2026-10-29）
  /*
   * 修正 diag.owned 里的结果 —— 之前它记的是**计划**（ready / 被谁筛掉），
   * 但真正投递可能失败。2026-10-29 用户就撞上了：
   * 界面说"已叫醒"，实际 woke 是空的，因为三个全 wake-failed。
   *
   * 现在按真实结果覆盖：睡着的、失败的、排队的、成功的，各自说清。
   */
  for (const o of diag.owned || []) {
    const wokeIt = woke.includes(o.sessionId)
    const failed = (diag.failed || []).find((f) => f.sessionId === o.sessionId)
    const stillSkipped = skipped.find((x) => x.sessionId === o.sessionId)
    if (wokeIt) {
      o.result = o.result === 'ready(queued)' ? 'ready(queued)' : '已叫醒'
    } else if (failed) {
      o.result = `失败：${failed.error}`
    } else if (stillSkipped) {
      o.result = stillSkipped.reason
    }
  }

  const result = { date, woke, skipped, diag }
  state.lastRun = st.lastRun
  state.lastReport = result
  return result
}

/* ---------------------------------------------------------------- 调度 */

/**
 * 起定时器（每晚一次）+ 启动补跑（23:30 之后才开机的话今晚还要叫）。
 * @returns {{stop:()=>void, run:()=>Promise<any>, status:()=>object}}
 */
export function start(ctx, opts = {}) {
  stop()
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) }
  state.startedAt = new Date().toISOString()
  state.running = cfg.enabled !== false
  state.lastError = null

  if (!state.running) return { stop, run: async () => ({ reason: 'disabled' }), status }

  const schedule = () => {
    if (!state.running) return
    const now = new Date()
    const at = nextRunAt(now, cfg.time)
    state.nextAt = new Date(at).toISOString()
    const ms = Math.max(1000, at - now.getTime())
    state.timer = setTimeout(tick, ms)
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref()
  }

  const tick = async () => {
    if (!state.running) return
    try {
      const r = await runOnce(ctx, opts)
      if (typeof opts.onReport === 'function') {
        try {
          opts.onReport(r)
        } catch {
          /* 回调炸了不管 */
        }
      }
    } catch (err) {
      state.lastError = msg(err)
    }
    schedule()
  }

  schedule()

  /*
   * 补跑：DSH 在设定的时间之后才启动的话，今天那次还得叫一遍。
   *
   * ⚠️ 走的是和定时器**完全一样**的路径（tick），不是裸调 runOnce。
   * 2026-10-29 踩到：以前这里只 `void runOnce(...)`，
   * 于是补跑虽然真的跑了（草稿文件都产出来了），
   * 但 state.lastRun / lastReport 全是 null ——
   * 用户在界面上完全看不出来它跑过，只能猜"是不是没生效"。
   */
  const catchUpMs = Number.isFinite(opts.catchUpMs) ? opts.catchUpMs : 8000
  const now = new Date()
  const { hour, minute } = parseTime(cfg.time)
  const todayAt = new Date(now)
  todayAt.setHours(hour, minute, 0, 0)
  if (now.getTime() >= todayAt.getTime()) {
    const t = setTimeout(() => {
      void tick()
    }, Math.max(0, catchUpMs))
    if (t && typeof t.unref === 'function') t.unref()
    state.catchUp = { at: new Date().toISOString(), scheduledMs: Math.max(0, catchUpMs) }
  } else {
    state.catchUp = null
  }

  /*
   * run(extra) —— 手动触发一轮。
   *
   * 为什么会需要（2026-10-29 用户要求"做个写日记的按钮"）：
   *   定时器一天只跑一次，出问题的时候没法当场验证。
   *   给个手动入口，能把"是不是没生效"变成"立刻看得见"。
   *
   * extra.force  → 忽略"今天已经叫过"
   * extra.tag    → 给这次跑打个记号（比如 'manual-test'），
   *                叫醒词里会注明，会话知道这不是到点自动叫的
   */
  return {
    stop,
    run: (extra = {}) => runOnce(ctx, { ...opts, ...extra }),
    status,
  }
}

export function stop() {
  state.running = false
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
  state.nextAt = null
}

export function status() {
  return {
    enabled: state.running,
    startedAt: state.startedAt,
    nextAt: state.nextAt,
    lastRun: state.lastRun,
    lastReport: state.lastReport,
    lastError: state.lastError,
    /** 启动补跑：{at, scheduledMs} 或 null（说明还没到点，不需要补） */
    catchUp: state.catchUp || null,
  }
}

export { DEFAULT_CONFIG, planSessions, wakeText, buildDraft, ensureDiary, localDate }
