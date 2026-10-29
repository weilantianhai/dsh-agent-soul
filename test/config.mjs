#!/usr/bin/env node
/**
 * test/config.mjs —— 换台机器也能跑：根目录怎么定、第一次跑会不会自己建
 *
 * 背景：以前 DEFAULT_ROOT 写死 `D:/ProgramData/dsh/memory`，
 * 别人 clone 下来不改配置就直接指到一个不存在的盘 —— 插件起得来，但什么都不记。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeCtx } from './helpers.mjs'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-memory-config-'))
const FRESH = join(TMP, 'fresh-memory').replace(/\\/g, '/')

// 一定要在 import 之前设：DEFAULT_ROOT 是在模块加载时算出来的
process.env.DSH_MEMORY_ROOT = FRESH

const { resolveRootDir, normalizeConfig, isHhMm } = await import('../lib/config.mjs')
const mod = await import('../lib/index.js')

let pass = 0
const ok = (name) => {
  pass += 1
  console.log(`✓ ${name}`)
}

/* 1. 根目录的选法 */

assert.equal(resolveRootDir({ DSH_MEMORY_ROOT: 'E:/m' }, () => false), 'E:/m', '环境变量最优先')
assert.equal(resolveRootDir({}, () => true), 'D:/ProgramData/dsh/memory', '老位置存在就用它（这台机器不变）')
assert.equal(resolveRootDir({ DSH_HOME: 'C:/u/.dsh' }, () => false), 'C:/u/.dsh/memory', '新机器落到 $DSH_HOME/memory')
ok('根目录：DSH_MEMORY_ROOT > 老位置 > $DSH_HOME/memory')

/* 2. 没配 rootDir 时，默认值就是解析出来的那个，并标记为"默认" */

const auto = normalizeConfig({})
assert.equal(auto.config.rootDir, FRESH, '没配就用解析值')
assert.equal(auto.config.rootIsDefault, true, '要标记成默认位置（这样才敢替人建）')

const explicit = normalizeConfig({ rootDir: 'D:/some/where' })
assert.equal(explicit.config.rootDir, 'D:/some/where')
assert.equal(explicit.config.rootIsDefault, false, '自己配的路径不许被"帮忙"建出来')

const bad = normalizeConfig({ rootDir: 'relative/path' })
assert.equal(bad.config.rootIsDefault, true, '写错了也退回默认')
assert.ok(bad.issues.some((e) => /rootDir/.test(e.message)), '写错要报')
ok('配置：默认位置可识别，显式路径与写错路径分开处理')

/* 2.5 时间格式：HH:mm 要真校验（25:99 这种别放过去） */

assert.equal(isHhMm('22:15'), true, '22:15 合法')
assert.equal(isHhMm('9:05'), true, '9:05 也认')
assert.equal(isHhMm('25:99'), false, '小时超范围要拒')
assert.equal(isHhMm('22:60'), false, '分钟超范围要拒')
assert.equal(normalizeConfig({ daily: { time: '25:99' } }).config.daily.time, '23:30', '写错退回默认')
assert.equal(normalizeConfig({ daily: { time: '22:15' } }).config.daily.time, '22:15', '写对就保留')
ok('daily.time：HH:mm 真校验，越界退回默认')

/* 3. 第一次跑：默认位置不存在 → 自己建；显式路径不存在 → 不建、只报 */

{
  assert.equal(existsSync(FRESH), false, '先确认这个目录还不存在')
  const ctx = makeCtx()
  await mod.apply(ctx, {}) // 什么都不配 = 默认位置
  assert.ok(existsSync(FRESH), '默认位置要能自己建出来（别人 clone 下来就能用）')
  assert.ok(existsSync(join(FRESH, 'sessions')), '子目录也要建好')
  assert.ok(existsSync(join(FRESH, 'system')), '登记表目录也要建好')
  const errors = mod.status().errors.map((e) => e.text)
  assert.ok(
    errors.some((t) => /已按默认位置建好/.test(t)),
    '建了要说一句，别悄悄建',
  )
  for (const fn of ctx.effects) await fn()()
  ok('首次运行：默认位置自动建（并报一句）')
}

{
  const explicitRoot = join(TMP, 'nope').replace(/\\/g, '/')
  const ctx = makeCtx()
  await mod.apply(ctx, { rootDir: explicitRoot })
  assert.equal(existsSync(explicitRoot), false, '自己配的路径不存在就不建')
  const errors = mod.status().errors.map((e) => e.text)
  assert.ok(
    errors.some((t) => /记忆根目录不存在/.test(t)),
    '显式路径不存在要报，而不是替人建',
  )
  for (const fn of ctx.effects) await fn()()
  ok('显式路径：不存在就只报，不替人建')
}

  /* summary.threshold：默认 0.8，能改，越界退回 */
  {
    const a = normalizeConfig({})
    assert.equal(a.config.summary.threshold, 0.8, '默认 0.8')

    const b2 = normalizeConfig({ summary: { threshold: 0.65 } })
    assert.equal(b2.config.summary.threshold, 0.65, '能改')

    const c = normalizeConfig({ summary: { threshold: 5 } })
    assert.equal(c.config.summary.threshold, 0.8, '越界退回 0.8')
    assert.ok(c.issues.some((e) => /summary\.threshold/.test(e.message)), '越界要报出来，不许静默')

    const d = normalizeConfig({ summary: { threshold: 0 } })
    assert.equal(d.config.summary.threshold, 0.8, '0 也不行（会每轮都触发）')
    console.log('✓ summary.threshold：默认 0.8、能改、越界报错并退回')
  }

rmSync(TMP, { recursive: true, force: true })
delete process.env.DSH_MEMORY_ROOT
console.log(`\n配置验收 · ${pass} 组全过\n`)
