/**
 * test/registry.test.mjs —— 登记表落盘层
 *
 * 对应任务单第六节：第 5、6、7、8、10 条，另有 3 条附加。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { getRegistry, isEnabled, register } from '../index.mjs'
import { DEFAULT_REGISTRY_PATH, REGISTRY_PATH_SYSTEM } from '../registry.mjs'
import {
  discoverSpy,
  errorSpy,
  fileExists,
  makeCtx,
  noWorkspaceFile,
  readJson,
  tempRegistry,
  writeRaw,
} from './helpers.mjs'

const D1 = new Date(2026, 9, 20, 10, 0, 0) // 2026-10-20
const D2 = new Date(2026, 9, 27, 21, 20, 0) // 2026-10-27

const ctxOf = (ids, archived = []) =>
  makeCtx({ live: ids.map((id) => ({ id })), archivedIds: archived })

export const tests = [
  {
    no: 5,
    name: 'firstSeen 不变：连跑两次，还是第一次那天',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()
      const ctx = ctxOf(['a'])

      const r1 = await register(ctx, { registryPath: path, now: D1, workspacePath: ws })
      assert.equal(r1.sessions.a.firstSeen, '2026-10-20')

      const r2 = await register(ctx, { registryPath: path, now: D2, workspacePath: ws })
      assert.equal(r2.sessions.a.firstSeen, '2026-10-20', 'firstSeen 被改了')
      assert.equal(readJson(path).sessions.a.firstSeen, '2026-10-20')
    },
  },
  {
    no: 6,
    name: 'lastSeen 会更新：第二次跑变成第二天',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()
      const ctx = ctxOf(['a'])

      await register(ctx, { registryPath: path, now: D1, workspacePath: ws })
      const r2 = await register(ctx, { registryPath: path, now: D2, workspacePath: ws })

      assert.equal(r2.sessions.a.lastSeen, '2026-10-27')
      assert.equal(r2.updated, '2026-10-27T21:20:00+08:00')
      const onDisk = readJson(path)
      assert.equal(onDisk.sessions.a.lastSeen, '2026-10-27')
      assert.equal(onDisk.version, 1)
    },
  },
  {
    no: 7,
    name: '新会话被发现：表里多一行，onDiscover 被调用',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()

      await register(ctxOf(['a']), { registryPath: path, now: D1, workspacePath: ws })

      const spy = discoverSpy()
      const r2 = await register(ctxOf(['a', 'b']), {
        registryPath: path,
        now: D2,
        workspacePath: ws,
        onDiscover: spy,
      })

      assert.deepEqual(Object.keys(r2.sessions).sort(), ['a', 'b'])
      assert.deepEqual(r2.discovered, ['b'])
      assert.equal(spy.calls.length, 1)
      assert.equal(spy.calls[0].sid, 'b')
      assert.equal(spy.calls[0].info.firstSeen, '2026-10-27')
      assert.equal(r2.sessions.b.enabled, true)
    },
  },
  {
    no: 8,
    name: '消失的会话不删：那行还在，标 missing: true',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()

      await register(ctxOf(['a', 'b']), { registryPath: path, now: D1, workspacePath: ws })
      const r2 = await register(ctxOf(['a']), { registryPath: path, now: D2, workspacePath: ws })

      assert.deepEqual(Object.keys(r2.sessions).sort(), ['a', 'b'], '不许删行')
      assert.equal(r2.sessions.b.missing, true)
      assert.equal(r2.sessions.b.firstSeen, '2026-10-20', '消失的行也要留着原来的 firstSeen')
      assert.deepEqual(r2.missing, ['b'])
      assert.equal(r2.sessions.a.missing, undefined, '在场的行不该带 missing')

      // 再出现时 missing 要清掉
      const r3 = await register(ctxOf(['a', 'b']), { registryPath: path, now: D2, workspacePath: ws })
      assert.equal(r3.sessions.b.missing, undefined)
    },
  },
  {
    no: 10,
    name: '写坏了能恢复：坏文件先备份，再按空表重建，不崩',
    async fn() {
      const path = tempRegistry()
      writeRaw(path, '{ 这不是 json ,,,')
      const spy = errorSpy()

      const r = await register(ctxOf(['a']), {
        registryPath: path,
        now: D2,
        workspacePath: noWorkspaceFile(),
        onError: spy,
      })

      assert.equal(r.wrote, true)
      assert.deepEqual(Object.keys(r.sessions), ['a'])
      assert.ok(r.backupPath, '必须留一份坏文件备份')
      assert.ok(fileExists(r.backupPath))
      assert.ok(spy.count() >= 1, '坏了要报，不能悄悄重建')

      const backups = readdirSync(dirname(path)).filter((f) => f.includes('.bak-'))
      assert.equal(backups.length, 1)

      const rebuilt = readJson(path)
      assert.equal(rebuilt.version, 1)
      assert.deepEqual(Object.keys(rebuilt.sessions), ['a'])
    },
  },

  // ── 附加 ─────────────────────────────────────────────
  {
    no: 15,
    name: '附加：isEnabled —— 归档的 false、未知的 true、表坏了 true',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()

      await register(ctxOf(['a', 'b'], ['b']), { registryPath: path, now: D1, workspacePath: ws })

      assert.equal(isEnabled('a', { registryPath: path }), true)
      assert.equal(isEnabled('b', { registryPath: path }), false, '归档的不记日志')
      assert.equal(isEnabled('从来没有过的会话', { registryPath: path }), true, '不认识 → 宁可多记')

      const bad = writeRaw(tempRegistry('bad'), 'not json at all')
      assert.equal(isEnabled('a', { registryPath: bad }), true, '表不可信 → 宁可多记')
    },
  },
  {
    no: 16,
    name: '附加：登记表版本比我新，不许覆盖',
    async fn() {
      const path = tempRegistry()
      const original = JSON.stringify({ version: 99, sessions: { future: { name: '别动我' } } }, null, 2)
      writeRaw(path, original)
      const spy = errorSpy()

      const r = await register(ctxOf(['a']), {
        registryPath: path,
        now: D2,
        workspacePath: noWorkspaceFile(),
        onError: spy,
      })

      assert.equal(r.wrote, false)
      assert.equal(r.reason, 'version-too-new')
      assert.equal(readFile(path), original, '文件必须原封不动')
      assert.ok(spy.count() >= 1)
    },
  },
  {
    no: 17,
    name: '附加：归档名单不可信时，不许把原有 archival/enabled 状态冲掉',
    async fn() {
      const path = tempRegistry()
      await register(ctxOf(['a'], ['a']), {
        registryPath: path,
        now: D1,
        workspacePath: noWorkspaceFile(),
      })
      assert.equal(readJson(path).sessions.a.enabled, false)

      // 第二次：归档名单拿不到（服务没给 + 文件不在）
      const r2 = await register(makeCtx({ live: [{ id: 'a' }], archivedMode: 'none' }), {
        registryPath: path,
        now: D2,
        workspacePath: noWorkspaceFile(),
      })

      assert.equal(r2.archivedKnown, false)
      assert.equal(r2.sessions.a.archived, true, '拿不准就别改')
      assert.equal(r2.sessions.a.enabled, false, '拿不准就别把它重新打开')

      // 而这时 getRegistry 读回来的 archivedKnown 是 false（提醒下游别信）
      assert.equal(getRegistry({ registryPath: path }).archivedKnown, false)
    },
  },
  {
    no: 18,
    name: '附加：默认路径指到 memory/system（v4 目录改版后不许再写回 shared）',
    async fn() {
      assert.ok(
        REGISTRY_PATH_SYSTEM.endsWith(join('memory', 'system', 'sessions.json')),
        `新位置算错了：${REGISTRY_PATH_SYSTEM}`,
      )
      assert.equal(basename(DEFAULT_REGISTRY_PATH), 'sessions.json')
      const dir = basename(dirname(DEFAULT_REGISTRY_PATH))
      // system = 新位置；shared = 旧位置还有数据时的兜底。除此之外都算跑偏
      assert.ok(dir === 'system' || dir === 'shared', `默认路径落在了 ${DEFAULT_REGISTRY_PATH}`)
    },
  },
  {
    no: 19,
    name: '实战：这次扫到 0 个但表里原有数据 → 不许覆盖（98 条被清空的教训）',
    async fn() {
      const path = tempRegistry()
      const ws = noWorkspaceFile()
      await register(ctxOf(['a', 'b']), { registryPath: path, workspacePath: ws, now: D1 })
      assert.equal(Object.keys(getRegistry({ registryPath: path }).sessions).length, 2)

      // 再来一次「什么都没扫到」——运行时没起来就是这样
      const r = await register(ctxOf([]), { registryPath: path, workspacePath: ws, now: D2 })
      assert.equal(r.wrote, false, '扫到 0 个还敢写')
      assert.equal(r.reason, 'scan-empty')

      // 旧数据必须还在
      const after = getRegistry({ registryPath: path })
      assert.equal(Object.keys(after.sessions).length, 2, '98 条就是这么没的')
      assert.ok(after.sessions.a, 'a 没了')
    },
  },
]

function readFile(path) {
  return readFileSync(path, 'utf8')
}
