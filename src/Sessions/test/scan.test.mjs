/**
 * test/scan.test.mjs —— 扫描层（不落盘）
 *
 * 对应任务单第六节：第 1、2、3、4、9 条，另有 4 条附加。
 */

import assert from 'node:assert/strict'

import { scan } from '../index.mjs'
import { errorSpy, makeCtx, noWorkspaceFile, writeWorkspace } from './helpers.mjs'

const D = new Date(2026, 9, 27, 21, 20, 0) // 本地时间 2026-10-27 21:20

export const tests = [
  {
    no: 1,
    name: '扫得到：两个假会话都进表',
    async fn() {
      const ctx = makeCtx({ live: [{ id: 'a' }, { id: 'b' }], archivedIds: [] })
      const r = await scan(ctx, { now: D, workspacePath: noWorkspaceFile() })

      assert.equal(r.archivedKnown, true)
      assert.deepEqual(Object.keys(r.sessions).sort(), ['a', 'b'])
      assert.equal(r.sessions.a.enabled, true)
      assert.equal(r.sessions.a.archived, false)
      assert.equal(r.sessions.a.lastSeen, '2026-10-27')
    },
  },
  {
    no: 2,
    name: '名字取不到不崩：照样进表，name 是空串',
    async fn() {
      // ① 标题服务返回 null
      const r1 = await scan(makeCtx({ live: [{ id: 'a' }], archivedIds: [] }), {
        now: D,
        workspacePath: noWorkspaceFile(),
      })
      assert.deepEqual(Object.keys(r1.sessions), ['a'])
      assert.equal(r1.sessions.a.name, '')

      // ② 标题服务直接抛错
      const r2 = await scan(makeCtx({ live: [{ id: 'b' }], archivedIds: [], titleThrows: true }), {
        now: D,
        workspacePath: noWorkspaceFile(),
      })
      assert.deepEqual(Object.keys(r2.sessions), ['b'])
      assert.equal(r2.sessions.b.name, '')
      assert.ok(
        r2.notes.some((n) => n.includes('标题')),
        '标题失败要留痕（warnings/notes），不能一点痕迹都没有',
      )

      // ③ 有名字就取到
      const r3 = await scan(makeCtx({ live: [{ id: 'c' }], archivedIds: [], titles: { c: '小鱼' } }), {
        now: D,
        workspacePath: noWorkspaceFile(),
      })
      assert.equal(r3.sessions.c.name, '小鱼')
    },
  },
  {
    no: 3,
    name: '归档拿不到要报警：archivedKnown === false，且照常列出来',
    async fn() {
      const ctx = makeCtx({ live: [{ id: 'a' }, { id: 'b' }], archivedMode: 'none' })
      const r = await scan(ctx, { now: D, workspacePath: noWorkspaceFile() })

      assert.equal(r.archivedKnown, false, '两条路都失败时必须交回 false，不许当成「没有归档」')
      assert.equal(r.archivedSource, null)
      // 宁可多露：两条都还在，enabled 都是 true
      assert.deepEqual(Object.keys(r.sessions).sort(), ['a', 'b'])
      assert.equal(r.sessions.a.enabled, true)
      assert.equal(r.sessions.b.enabled, true)
      assert.ok(r.errors.length >= 1)
    },
  },
  {
    no: 4,
    name: '不许静默：那两种情况 onError 必须被调用（且只报一次）',
    async fn() {
      const spy = errorSpy()
      const ctx = makeCtx({ live: [{ id: 'a' }], archivedMode: 'none' })
      await scan(ctx, { now: D, workspacePath: noWorkspaceFile(), onError: spy })

      assert.equal(spy.count(), 1, `onError 应该正好叫一次，实际 ${spy.count()} 次`)
      assert.ok(spy.text().includes('归档'), '报错要说清是归档名单拿不到')
    },
  },
  {
    no: 9,
    name: '归档的自动关：archived=true 时 enabled=false',
    async fn() {
      const ctx = makeCtx({
        live: [{ id: 'a' }, { id: 'b' }],
        archivedIds: ['b'],
      })
      const r = await scan(ctx, { now: D, workspacePath: noWorkspaceFile() })

      assert.equal(r.archivedKnown, true)
      assert.equal(r.sessions.a.archived, false)
      assert.equal(r.sessions.a.enabled, true)
      assert.equal(r.sessions.b.archived, true)
      assert.equal(r.sessions.b.enabled, false, '归档了就不记日志')
    },
  },

  // ── 附加 ─────────────────────────────────────────────
  {
    no: 11,
    name: '附加：ctx 整个是空的也不崩，只是报错 + 一张空表',
    async fn() {
      const spy = errorSpy()
      const r = await scan(undefined, { now: D, workspacePath: noWorkspaceFile(), onError: spy })

      assert.deepEqual(r.sessions, {})
      assert.equal(r.archivedKnown, false)
      assert.ok(spy.count() >= 1, 'ctx 都没了必须报')
    },
  },
  {
    no: 12,
    name: '附加：服务坏但存储文件在 → 兜底成功，不用报警',
    async fn() {
      const ws = writeWorkspace(noWorkspaceFile(), ['session-b'])
      const spy = errorSpy()
      const ctx = makeCtx({ live: [{ id: 'a' }, { id: 'b' }], archivedMode: 'not-array' })
      const r = await scan(ctx, { now: D, workspacePath: ws, onError: spy })

      assert.equal(r.archivedKnown, true)
      assert.equal(r.archivedSource, 'file')
      assert.equal(spy.count(), 0, '兜底成功了就不算失败，别乱报警')
      assert.equal(r.sessions.b.archived, true)
      assert.equal(r.sessions.b.enabled, false)
    },
  },
  {
    no: 13,
    name: '附加：归档 id 带 session- 前缀也认（服务写 session-xxx，agent 报 xxx）',
    async fn() {
      const ctx = makeCtx({ live: [{ id: 'abc' }], archivedIds: ['session-abc'] })
      const r = await scan(ctx, { now: D, workspacePath: noWorkspaceFile() })
      assert.equal(r.sessions.abc.archived, true)
      assert.equal(r.sessions.abc.enabled, false)
    },
  },
  {
    no: 14,
    name: '附加：sessions.list 抛错不崩，报错并交回空表',
    async fn() {
      const spy = errorSpy()
      const ctx = makeCtx({ live: [{ id: 'a' }], listThrows: true, archivedIds: [] })
      const r = await scan(ctx, { now: D, workspacePath: noWorkspaceFile(), onError: spy })

      assert.deepEqual(r.sessions, {})
      assert.ok(spy.count() >= 1)
      assert.ok(spy.text().includes('sessions.list'))
    },
  },
]
