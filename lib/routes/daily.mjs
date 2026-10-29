/**
 * routes/daily.mjs —— 手动触发一轮写日记。
 *
 * 这个按钮是把"是不是没生效"变成"立刻看得见"的唯一手段：
 * 定时器一天只跑一次，出问题的时候没法当场验证。
 *
 * 走的还是**同一个 runOnce**，不是另写一条假路径 —— 它测的是真链路。
 *
 * 不给会话打"测试"标记（2026-10-29 用户定的）：这个按钮关键时刻
 * 也用来真的补写日记，叫它"测试"，会话就会敷衍。
 */

import { json, readBody } from './http.mjs'
import { readSidebarSessions } from '../domain/session.mjs'

const msg = (err) => String((err && err.message) || err)

/**
 * @param {Function} route      registerRoutes 给的注册函数
 * @param {object}   getRuntime 取当前运行时（dailyHandle 在里面）
 */
export function registerDailyRoutes(route, { getRuntime }) {
  route('POST', '/daily/run', async (req, res) => {
    await readBody(req)
    const handle = typeof getRuntime === 'function' ? (getRuntime() || {}).dailyHandle : null

    if (!handle || typeof handle.run !== 'function') {
      json(res, 503, { ok: false, error: '日记任务没起来（Daily 未启用或挂载失败）' })
      return
    }

    try {
      /*
       * 把侧边栏可见集传下去 —— 不然 Daily 会拿磁盘全部会话（本机 141 个），
       * 那 60 多个差额用户根本看不到，界面上全是噪音。
       */
      const r = await handle.run({ force: true, sidebarSessions: readSidebarSessions() })
      json(res, 200, {
        ok: true,
        date: r && r.date,
        woke: (r && r.woke) || [],
        skipped: (r && r.skipped) || [],
        reason: (r && r.reason) || null,
        diag: (r && r.diag) || null,
        note: '手动触发，和到点自动叫走同一条链路',
      })
    } catch (err) {
      json(res, 500, { ok: false, error: `跑不起来：${msg(err)}` })
    }
  })
}
