#!/usr/bin/env node
/**
 * host-contract.mjs —— 钉死宿主对 `apply` 返回值的解释方式
 *
 * 2026-10-28 真机事故：插件装好、apply 跑完、三块全绿、6 条路由挂上，
 * 2 毫秒后宿主把整个插件作用域拆了，接口 404，而插件自己的 errors 是空的。
 *
 * 根因不在宿主：`apply` 返回了 `{ parts, errors }`，而 cordis 4 把返回值当作
 * 「这次挂载的 effect」来解释。下面这段判定是从宿主自带的
 * `@deepseek-ai/cordis@4.0.5` `lib/index.js` 的 `Fiber._execute` / `safeCollect`
 * 一比一抄下来的：
 *
 *   函数             → disposer，收下
 *   null / undefined → 什么也不做（唯一"什么都不挂"的合法写法）
 *   有 then 的对象   → 等它，等到的东西再按同一套规则判一遍
 *   可迭代对象       → 逐个当 disposer 收
 *   其余             → TypeError('Invalid effect')
 *
 * 抛出来之后 `Fiber._reload` 记 _error、把 epoch 置 INACTIVE，再 `_unload()` ——
 * 这会跑掉本次挂载注册的**所有** ctx.effect 清理函数（我们的 teardown），
 * 插件当场下线。所以这个文件的作用是：**返回值一变坏，测试立刻红**。
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeCtx, makeTree } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const TMP = join(PKG, '.tmp-contract')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/* --------------------------------------------------- 宿主的判定（照抄） */

function classify(value) {
  if (typeof value === 'function') return 'disposer'
  if (value === null || value === undefined) return 'none'
  if (typeof value !== 'object') return 'invalid'
  if ('then' in value) return 'thenable'
  if (Symbol.iterator in value) return 'iterable'
  if (Symbol.asyncIterator in value) return 'async-iterable'
  return 'invalid'
}

/** 一路拆开 then，得到最终的判定结果 */
async function verdict(value) {
  let current = value
  for (let guard = 0; guard < 8; guard++) {
    const kind = classify(current)
    if (kind === 'thenable') {
      current = await current
      continue
    }
    if (kind === 'invalid') return 'invalid'
    if (kind === 'none' || kind === 'disposer') return kind
    return 'ok:disposers' // 可迭代：逐个收下
  }
  return 'invalid'
}

/* ---------------------------------------------- 模仿 Fiber._reload 的宿主 */

/**
 * @param applyFn  (ctx) => 插件 apply 的返回值
 * @returns 这次"挂载"的结局：alive / teardown，以及宿主的判定
 */
async function mountLikeHost(applyFn, ctx) {
  const events = []
  let thrown = null
  let returned

  try {
    returned = await applyFn(ctx)
  } catch (err) {
    thrown = err
  }

  const kind = thrown ? 'threw' : await verdict(returned)

  if (thrown || kind === 'invalid') {
    // _reload 的 catch 分支 + _unload()：本次挂载的 effect 清理全部跑掉
    for (const fn of ctx.effects) {
      const disposer = fn()
      if (typeof disposer === 'function') await disposer()
    }
    events.push('teardown')
  } else {
    events.push('alive')
  }
  return { events, kind, returned, thrown }
}

/* -------------------------------------------------------------- 跑 */

async function main() {
  makeTree(TMP)
  const config = { rootDir: TMP, log: { enabled: true }, inject: { enabled: true } }

  /* 1. 判定函数本身要有牙：坏返回值必须被认成 invalid */
  assert.equal(classify({ parts: { Log: 'on' }, errors: 0 }), 'invalid', '普通对象应该被认成非法 effect')
  assert.equal(classify(() => {}), 'disposer')
  assert.equal(classify(undefined), 'none')
  assert.equal(await verdict(Promise.resolve({ ok: true })), 'invalid', 'async 解析出来的对象也要再判一次')
  assert.equal(await verdict(Promise.resolve(undefined)), 'none')
  console.log('✓ 宿主的判定规则复刻住了：普通对象 = Invalid effect')

  /* 2. 我们的 apply 必须落在合法那一侧 */
  const ctx = makeCtx()
  const run = await mountLikeHost((c) => mod.apply(c, config), ctx)
  assert.equal(run.thrown, null, `apply 不该抛：${run.thrown && run.thrown.message}`)
  assert.equal(run.returned, undefined, `apply 不能返回值（宿主会当 effect 拆插件），实际是 ${typeof run.returned}`)
  assert.equal(run.kind, 'none', `apply 返回值的判定应该是 none，实际 ${run.kind}`)
  assert.deepEqual(run.events, ['alive'], '宿主不该拆掉插件')
  console.log('✓ apply 返回值 = undefined → 宿主什么都不当，插件活着')

  /* 3. 活着的意思是：三块还在跑、6 条路由还在 */
  const status = mod.status()
  assert.equal(status.parts.Sessions, 'on')
  assert.equal(status.parts.Log, 'on')
  assert.equal(status.parts.Inject, 'on')
  assert.equal(ctx.routes.length, 17, `路由应该还挂着，实际 ${ctx.routes.length} 条`)
  assert.equal(status.diag.routes, 17)
  console.log('✓ 十七个接口还挂着，四块都还在跑（真机上这三条一断就是 404）')

  /* 4. 反证：真返回一个普通对象时，同一台宿主会拆掉插件 —— 模拟器不是摆设 */
  const bad = makeCtx()
  const badRun = await mountLikeHost(async (c) => {
    c.effect(() => () => {})
    return { parts: { Log: 'on' }, errors: 0 }
  }, bad)
  assert.deepEqual(badRun.events, ['teardown'], '返回普通对象时必须被拆（否则这台模拟器是摆设）')
  assert.equal(badRun.kind, 'invalid')
  console.log('✓ 反证：同样的宿主遇到 { parts, errors } 会拆 —— 这台模拟器不是摆设')

  /* 收尾：真拆的时候要拆干净 */
  for (const fn of ctx.effects) {
    const d = fn()
    if (typeof d === 'function') await d()
  }
  assert.equal(ctx.routes.length, 0, '真拆的时候路由要拆干净')
  rmSync(TMP, { recursive: true, force: true })
  console.log('\n宿主契约全部通过。')
}

main().catch((err) => {
  console.error('✗ 宿主契约失败：', err)
  process.exitCode = 1
})
