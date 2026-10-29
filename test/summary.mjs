#!/usr/bin/env node
/**
 * summary.mjs —— 上下文到阈值写总结的测试
 *
 * 重点验两件事：
 *   1. 比例算得对（用宿主的 contextPressure 投影，不自己 tokenize）
 *   2. 时机对（正在干活时不发誓，等 idle 才发）
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureSummaryFile, pressureOf, ratioOf, summaryPath, summaryPrompt } from '../lib/summary.mjs'
import { startSummaryWatch } from '../lib/summary-watch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp-summary')

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`  ✓ ${label}`)
}

/** 假 ctx：只给会话控制器和事件总线 */
function makeCtx({ pressureFor = {}, ownership = {} } = {}) {
  const listeners = new Map()
  const prompts = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        // 真的 Session 对象没有 .projections / .projectionValues()
        return { get: () => ({ id: 's-fish' }) }
      }
      if (name === 'sessionProjections') {
        /*
         * 唯一的正确读法（2026-10-29 查宿主源码确认）：
         *   stateOf(session, 'contextPressure')
         * 原来测试 mock 的是 session.projections.values() —— 那个方法不存在，
         * 所以 pressureOf 永远返回 null、看门狗一次没触发，测试却是绿的。
         * 这条 mock 改成真实形状，同类 bug 以后会被测出来。
         */
        return {
          stateOf: (session, key) => {
            if (key !== 'contextPressure') return undefined
            const sid = session && session.id
            const p = pressureFor[sid]
            // 两种写法都兼容：直接给 pressure，或给 {contextPressure: pressure}
            if (!p) return undefined
            return p.contextPressure !== undefined ? p.contextPressure : p
          },
        }
      }
      if (name === 'sessionController') {
        return {
          prompt: async (req, source) => {
            prompts.push({ ...req, __source: source })
            return { accepted: true }
          },
        }
      }
      return null
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
  }
  const fire = async (name, payload) => {
    for (const fn of listeners.get(name) || []) await fn(payload)
  }
  return { ctx, prompts, fire, listeners }
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const ownershipPath = join(TMP, 'private', 'agents.json')
  mkdirSync(dirname(ownershipPath), { recursive: true })
  writeFileSync(ownershipPath, JSON.stringify({ 's-fish': 'xiaoyu' }), 'utf8')

  /* 1. 比例计算 */
  {
    assert.deepEqual(ratioOf({ contextWindow: 100, pressureTokens: 80 }), {
      ratio: 0.8,
      used: 80,
      window: 100,
      source: 'pressureTokens',
    })
    assert.equal(ratioOf({ pressureTokens: 80 }), null, '没有 contextWindow 就返回 null，不许猜')
    assert.equal(ratioOf(null), null)
    assert.equal(ratioOf({}), null)
    // 退到 surfaceTokens
    const r = ratioOf({ contextWindow: 100, surfaceTokens: 50 })
    assert.equal(r.ratio, 0.5)
    assert.equal(r.source, 'surfaceTokens')
    ok('比例：priorityTokens 优先，缺窗口返回 null，退到 surfaceTokens')
  }

  /* 2. 路径 */
  {
    const d = new Date('2026-10-29T14:35:00')
    const p = summaryPath({ rootDir: TMP, agentId: 'xiaoyu', sessionId: 's-1', now: d })
    assert.ok(p.includes('agents'), '要落在 agents/ 下')
    assert.ok(p.includes('summary'), '要有 summary/ 目录')
    assert.ok(p.includes('s-1'), '要按会话分开')
    assert.ok(p.endsWith('2026-10-29-1435.md'), `文件名要带时间，实际 ${p}`)
    ok('路径：agents/<人格>/summary/<会话>/<日期>-<时分>.md')
  }

  /* 3. 骨架 */
  {
    const file = summaryPath({ rootDir: TMP, agentId: 'xiaoyu', sessionId: 's-1' })
    const r = ensureSummaryFile(file, { agentId: 'xiaoyu', sessionId: 's-1', ratio: { ratio: 0.8 }, date: '2026-10-29' })
    assert.equal(r.ok, true)
    assert.ok(existsSync(file), '文件要建出来')
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('会话：s-1'), '要打会话标签')
    assert.ok(text.includes('80%'), '要记触发时的占比')
    ok('骨架：建目录 + 写标签，正文留给它自己')
  }

  /* 4. 提示词要把"总结不是日记"说清楚 */
  {
    const text = summaryPrompt({ ratio: { ratio: 0.83, used: 83000, window: 100000 }, file: 'D:/x/y.md', sessionId: 's-1' })
    assert.ok(text.includes('83%'), '要报出占比')
    assert.ok(text.includes('这不是日记'), '必须和日记区分开')
    assert.ok(text.includes('下一步该干嘛'), '要可执行，不是心情散文')
    ok('叫醒词：报占比、区别于日记、要求可执行')
  }

  /* 5. 到阈值 → 排队，不立即发 */
  {
    const { ctx, prompts, fire } = makeCtx({
      pressureFor: { 's-fish': { contextPressure: { contextWindow: 100000, pressureTokens: 85000 } } },
    })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      // turn 结束 → 只排队
      await fire('agent/turn-stopping', { agent: { id: 's-fish' }, turn: 1 })
      assert.ok(w.pending.has('s-fish'), '超阈值要排队')
      assert.equal(prompts.length, 0, '**不能立即发** —— 它可能还在干活')
      ok('到阈值：先排队，不立即发')
    } finally {
      w.dispose()
    }
  }

  /* 6. idle 时才发 */
  {
    const { ctx, prompts, fire } = makeCtx({
      pressureFor: { 's-fish': { contextPressure: { contextWindow: 100000, pressureTokens: 85000 } } },
    })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      await fire('agent/turn-stopping', { agent: { id: 's-fish' }, turn: 1 })
      assert.equal(prompts.length, 0, '还没 idle')
      // 变 idle → 发
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      assert.equal(prompts.length, 1, 'idle 了就该发')
      const p = prompts[0]
      assert.equal(p.sessionId, 's-fish')
      assert.ok(p.content[0].text.includes('交接总结'), '发的是写总结')
      assert.equal(typeof p.__source?.throwIfAborted, 'function', '第二个参数必须是 AbortSignal')
      assert.equal(w.pending.size, 0, '发完就出队')
      ok('idle 才发：turn 结束时排队 → agent/status=idle 时真发')
    } finally {
      w.dispose()
    }
  }

  /* 7. 没到阈值不打扰 */
  {
    const { ctx, prompts, fire } = makeCtx({
      pressureFor: { 's-fish': { contextPressure: { contextWindow: 100000, pressureTokens: 50000 } } },
    })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      await fire('agent/turn-stopping', { agent: { id: 's-fish' }, turn: 1 })
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      assert.equal(prompts.length, 0, '50% 不该叫')
      assert.equal(w.pending.size, 0)
      ok('没到阈值：不打扰')
    } finally {
      w.dispose()
    }
  }

  /* 8. 没人格的会话不写总结 */
  {
    const { ctx, prompts, fire } = makeCtx({
      pressureFor: { 's-nobody': { contextPressure: { contextWindow: 100000, pressureTokens: 95000 } } },
    })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      await fire('agent/turn-stopping', { agent: { id: 's-nobody' }, turn: 1 })
      await fire('agent/status', { agent: { id: 's-nobody' }, status: 'idle' })
      assert.equal(prompts.length, 0, '没有归属就没有"我"，不写总结')
      ok('没人格的会话：跳过（没地方放，也没有"我"）')
    } finally {
      w.dispose()
    }
  }

  /* 9. 同一次超阈值只叫一次 */
  {
    const { ctx, prompts, fire } = makeCtx({
      pressureFor: { 's-fish': { contextPressure: { contextWindow: 100000, pressureTokens: 90000 } } },
    })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      assert.equal(prompts.length, 1, '反复 idle 不该反复叫')
      ok('只叫一次：同一会话不重复打扰')
    } finally {
      w.dispose()
    }
  }

  /* 10. 拿不到窗口就不猜 */
  {
    const { ctx, prompts, fire } = makeCtx({ pressureFor: { 's-fish': {} } })
    const w = startSummaryWatch(ctx, { rootDir: TMP, ownershipPath, threshold: 0.8 })
    try {
      await fire('agent/status', { agent: { id: 's-fish' }, status: 'idle' })
      assert.equal(prompts.length, 0, '没有 contextWindow 就不叫 —— 不许凭感觉')
      ok('拿不到窗口：不猜、不叫')
    } finally {
      w.dispose()
    }
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n上下文总结 ${pass} 组全过。`)
}

main().catch((err) => {
  console.error('\n✗ 总结测试失败：', err && err.message)
  process.exitCode = 1
})
