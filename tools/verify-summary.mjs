/**
 * verify-summary.mjs —— 真 cordis 下验证"上下文压力读得到"。
 *
 * 为什么单独留一份：这个功能曾经**一次都没触发过**，而测试是绿的 ——
 * 因为 mock 的形状和宿主对不上（假的是 session.projections.values()，
 * 真的在 ctx.sessionProjections.stateOf()）。测试骗过了自己。
 *
 * 这个脚本用真 cordis 挂插件，只断言一件事：
 * pressureOf 能读到宿主的 contextPressure，ratioOf 能算出 85%。
 *
 * 跑：node tools/verify-summary.mjs
 */
// 真 · cordis 4.0.5（从宿主 app.asar 里原样取出来的）+ 我们的插件
// 目的：不靠假宿主，看两件事：
//   1. 宿主会不会在 apply 之后把插件拆掉（返回值契约）
//   2. 启动之后冒出来的会话，能不能自己进登记表（watch）
//
// 服务形状照宿主自己的类型：
//   ctx.sessions.list() → Session[]     Session 有 id
//   ctx.agents.list()   → Agent[]       Agent 只有 { id }
//   ctx.sessionTitle.get(session) → { title }
import { Context } from 'file:///D:/ProgramData/dsh/tmp/repro/cordis.js'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const ROOT = join(import.meta.dirname, '..', '.tmp-verify-memory')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

const routes = new Map()
const hostLog = []
const liveSessions = []
const liveAgents = []
const titles = new Map()
const registeredTools = new Map()

const ctx = new Context()
ctx.logger = {
  info: (m) => hostLog.push(['info', String(m)]),
  warn: (m) => hostLog.push(['warn', String(m)]),
  error: (e) => hostLog.push(['error', String((e && e.stack) || e)]),
}

ctx.provide('webServer', {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
})
ctx.provide('agents', { list: () => liveAgents })
ctx.provide('sessions', { list: () => liveSessions, get: (id) => liveSessions.find((s) => s.id === id) })
ctx.provide('sessionTitle', { get: (session) => titles.get(session.id) })
/*
 * 会话投影（2026-10-29 加）：验证 summary 能不能真读到上下文压力。
 * 形状照宿主：stateOf(session, key) → 该 key 的 state。
 */
const pressureState = new Map()
ctx.provide('sessionProjections', {
  stateOf: (session, key) => (key === 'contextPressure' ? pressureState.get(session && session.id) : undefined),
})
ctx.provide('tools', {
  register(def) {
    registeredTools.set(def.name, def)
    return () => registeredTools.delete(def.name)
  },
})

const read = () => JSON.parse(readFileSync(`${ROOT}/system/sessions.json`, 'utf8'))
const errors = () => hostLog.filter(([l]) => l === 'error')

ctx.plugin(plugin, { rootDir: ROOT })
await new Promise((r) => setTimeout(r, 400))

console.log('=== 1) 启动那一刻（还没有任何会话，真机就是这样） ===')
console.log('宿主错误   :', errors().length ? errors() : '(没有)')
console.log('parts      :', JSON.stringify(plugin.status().parts))
console.log('路由       :', routes.size, '条')
console.log('工具       :', [...registeredTools.keys()].join(', '))
console.log('登记表     :', JSON.stringify(read().sessions))

console.log('\n=== 2) 启动之后冒出一个会话 ===')
const session = { id: 'session-6d824748', title: '登记表是空的' }
liveSessions.push(session)
liveAgents.push({ id: session.id })
titles.set(session.id, { title: session.title })
ctx.emit('session/created', session)
await new Promise((r) => setTimeout(r, 400))

const reg = read()
console.log('登记表     :', JSON.stringify(reg.sessions))
console.log('宿主错误   :', errors().length ? errors() : '(没有)')

const parts = plugin.status().parts
const alive = parts.Log === 'on' && parts.Privacy === 'on' && parts.Summary === 'on' && routes.size > 0 && errors().length === 0
const registered = Boolean(reg.sessions[session.id])
const toolsOk = registeredTools.size === 5

/* ── 上下文摘要：压力到底读不读得到 ──
 * 这一段是 2026-10-29 加的，专门验证 pressureOf。
 * 原来它读 session.projections.values()（不存在的方法），
 * 所以压力永远是 null、摘看门狗一次没触发。
 */
pressureState.set(session.id, { contextWindow: 100000, pressureTokens: 85000, surfaceTokens: 85000 })
const { pressureOf, ratioOf } = await import('../lib/summary.mjs')
const pv = pressureOf(ctx, session.id)
const rt = ratioOf(pv)
const pressureOk = Boolean(rt && Math.abs(rt.ratio - 0.85) < 0.001)

console.log('上下文压力 :', pv ? JSON.stringify(pv) : '(读不到)')
console.log('占用率     :', rt ? (rt.ratio * 100).toFixed(0) + '%' : '(算不出)')

console.log('\n=== 结论 ===')
console.log(alive ? '✅ 插件活着，宿主没报错' : '❌ 插件被拆或有宿主错误')
console.log(registered ? '✅ 新会话自动进了登记表（名字也在）' : '❌ 新会话没进登记表')
console.log(toolsOk ? '✅ 五个工具都挂上了' : `❌ 工具只挂了 ${registeredTools.size} 个`)
console.log(pressureOk ? '✅ 上下文压力读得到（摘要看门狗不再是瞎的）' : '❌ 上下文压力读不到 —— 摘要看门狗还是瞎的')
process.exit(alive && registered && toolsOk && pressureOk ? 0 : 1)
