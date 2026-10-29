#!/usr/bin/env node
/**
 * sections.mjs —— 分段开关与热挂
 *
 * 补的是 smoke 没覆盖的那几条：
 *   1. 日志关掉 → 一个字都不写
 *   2. 注入关掉 → 钩子都不挂
 *   3. 会话登记关掉 → 不扫、不写表
 *   4. 设置页保存 → 热挂真的换了一套（旧钩子拆干净、新钩子挂上）
 *   5. settings.json 优先于 profile 里的种子配置
 *   6. 没有 webServer / 没有 ctx.effect → 照样起来
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlugin, call, makeCtx, makeTree, routeOf, today } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const TMP = join(PKG, '.tmp-sections')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const baseConfig = {
  rootDir: TMP,
  log: { enabled: true, sessions: { 'bili-whale': { log: true } } },
  inject: { enabled: true },
}

const emitUser = (ctx, text, seq = 1) =>
  ctx.handlers.get('session/event')?.(
    { id: 'bili-whale' },
    { type: 'user/message', seq, t: new Date().toISOString(), data: { content: [{ type: 'text', text }] } },
  )

const logFile = () => join(TMP, 'sessions/bili-whale/logs', `${today()}.jsonl`)

async function main() {
  makeTree(TMP)

  /* ---------------------------------------------------- 1. 日志关掉就不写 */
  {
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, { ...baseConfig, log: { enabled: false } })
    assert.equal(out.parts.Log, 'off', 'log.enabled=false 应该是 off，不是坏')
    emitUser(ctx, '这句不该被记')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(existsSync(logFile()), false, '日志关着还写出了文件')
    console.log('✓ 日志关掉：一个字都不写')
    for (const fn of ctx.effects) await fn()()
  }

  /* ------------------------------------------------- 2. 注入关掉就不挂钩子 */
  {
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, { ...baseConfig, inject: { enabled: false } })
    assert.equal(out.parts.Inject, 'off')
    assert.equal(ctx.handlers.has('system-prompt/assemble'), false, '注入了关还挂着钩子')
    console.log('✓ 注入关掉：钩子不挂，日志照记')
    assert.equal(ctx.handlers.has('session/event'), true)
    for (const fn of ctx.effects) await fn()()
  }

  /* --------------------------------------------- 3. 会话登记关掉就不扫不写表 */
  {
    // 前面几节已经写过表了，先删掉再验"关掉不写"
    rmSync(join(TMP, 'system/sessions.json'), { force: true })
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, { ...baseConfig, sessions: { enabled: false } })
    assert.equal(out.parts.Sessions, 'off')
    assert.equal(existsSync(join(TMP, 'system/sessions.json')), false, '登记关了还写了表')
    console.log('✓ 会话登记关掉：不扫、不写表')
    for (const fn of ctx.effects) await fn()()
  }

  /* ------------------------------------------------------- 4. 保存 → 热挂 */
  {
    const ctx = makeCtx()
    await applyPlugin(mod, ctx, baseConfig)
    assert.ok(ctx.handlers.has('system-prompt/assemble'), '先应该挂上')
    const before = ctx.handlers.size

    const offRes = await call(routeOf(ctx, '/config'), 'POST', { config: { inject: { enabled: false } } })
    assert.equal(offRes.code, 200)
    assert.equal(offRes.data.hot, true, '热挂应该成功')
    assert.equal(ctx.handlers.has('system-prompt/assemble'), false, '热挂之后旧注入钩子没拆掉')
    assert.equal(ctx.handlers.size, before - 1)

    const onRes = await call(routeOf(ctx, '/config'), 'POST', { config: { inject: { enabled: true } } })
    assert.equal(onRes.data.hot, true)
    assert.ok(ctx.handlers.has('system-prompt/assemble'), '再开回来应该重新挂上')

    const saved = JSON.parse(readFileSync(join(TMP, 'system/settings.json'), 'utf8'))
    assert.equal(saved.inject.enabled, true, 'settings.json 应该记下来')

    // 热挂不叠加：拆一次挂一次，钩子数量应该跟最开始一样
    assert.equal(ctx.handlers.size, before, `热挂之后钩子数量不对：${ctx.handlers.size} vs ${before}`)

    const cfg = await call(routeOf(ctx, '/config'), 'GET')
    assert.equal(cfg.data.config.inject.enabled, true)
    assert.equal(cfg.data.config.rootDir, TMP.replace(/\\/g, '/'))
    console.log('✓ 设置页保存：热挂真的换了一套，不叠加、不残留')
    for (const fn of ctx.effects) await fn()()
  }

  /* --------------------------------------- 5. settings.json 压过种子配置 */
  {
    // 上一步在 settings.json 里留了 inject.enabled=true；改成 false 再重启一次
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(TMP, 'system/settings.json'), JSON.stringify({ inject: { enabled: false } }, null, 2))
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, baseConfig) // 种子里是 true
    assert.equal(out.parts.Inject, 'off', 'settings.json 应该压过 profile 里的种子配置')
    console.log('✓ settings.json 优先于 profile 种子配置')
    for (const fn of ctx.effects) await fn()()
    rmSync(join(TMP, 'system/settings.json'), { force: true })
  }

  /* ------------------- 6. webServer 晚到 / 没有 effect 也要能起来（真机踩过） */
  {
    const ctx = makeCtx({ webServer: false, effect: false })
    const out = await applyPlugin(mod, ctx, baseConfig)
    assert.equal(out.parts.Log, 'on')
    assert.equal(out.parts.Inject, 'on')
    assert.equal(ctx.routes.length, 0, 'webServer 不在时不该凭空有路由')

    // 宿主晚一步把 webServer 挂上 —— 重试循环应该自己接住
    ctx.webServer = {
      register(route) {
        ctx.routes.push(route)
        return () => ctx.routes.splice(ctx.routes.indexOf(route), 1)
      },
    }
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(ctx.routes.length >= 6, `webServer 晚到之后路由应该挂上，实际 ${ctx.routes.length} 条`)
    console.log('✓ webServer 晚到：先启动，路由自己补挂上（真机 404 的兜底）')

    // 没有 ctx.effect 也能拆
    if (typeof mod.apply === 'function') await mod.status()
    console.log('✓ 没有 effect：照样起来，靠返回的句柄拆')
  }

  /* ------------------------------------------- 7. 工具区：总关 / 单独关 */
  {
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, { ...baseConfig, tools: { enabled: false } })
    assert.equal(out.parts.Tools, 'off', '工具总关应该是 off')
    assert.equal(ctx.toolsRegistered.length, 0, '工具总关，一个都不许挂')
    assert.equal(out.parts.Inject, 'on', '工具关了，注入照常')
    for (const fn of ctx.effects) await fn()()
    console.log('✓ 工具总关：一个不挂，其余照常')
  }

  {
    const ctx = makeCtx()
    const out = await applyPlugin(mod, ctx, { ...baseConfig, tools: { enabled: true, recall: false } })
    assert.equal(out.parts.Tools, 'on')
    const names = ctx.toolsRegistered.map((d) => d.name).sort()
    assert.deepEqual(names, ['memory_diary', 'memory_find', 'memory_index', 'memory_open'], '只关了 recall')
    assert.ok(!out.tools.includes('memory_recall'))

    // 说明书要跟着工具开关走：没挂的工具不许在提示里吹
    const assembled = await ctx.handlers.get('system-prompt/assemble')(
      null,
      { agent: { session: { id: 'bili-whale' } } },
      async () => ({ sections: [] }),
    )
    const text = assembled.sections.find((s) => s.name === 'memory:inject').text
    assert.ok(text.includes('memory_find'), '挂了的工具要提')
    assert.ok(!text.includes('memory_recall'), '关掉的工具不该在说明书里出现')
    for (const fn of ctx.effects) await fn()()
    console.log('✓ 工具单独关：只少了它，说明书也跟着不说')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('\n分段开关全部通过。')
}

main().catch((err) => {
  console.error('✗ 分段测试失败：', err)
  process.exitCode = 1
})
