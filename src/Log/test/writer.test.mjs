/**
 * test/writer.test.mjs —— 落盘这一层：判重、换天、建目录、重启后还认得
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createWriter, isoLocal, localDateOf } from '../writer.mjs'
import { tmp, readLog, logFiles, localIso, dateKey } from './helpers.mjs'

const cfgWith = (logs) => ({ enabled: true, sessions: { 'bili-whale': { log: true, dir: logs } }, defaults: { log: false } })

export const tests = [
  {
    no: 5,
    name: '判重：同一个 seq 推两次，只有一行',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const w = createWriter({ config: cfgWith(logs) })
      const at = localIso(2026, 10, 27, 20, 30, 0)
      const a = w.write({ sessionId: 'bili-whale', role: 'tianhai', text: '第一次', seq: 42, t: at })
      const b = w.write({ sessionId: 'bili-whale', role: 'tianhai', text: '第二次（同 seq）', seq: 42, t: at })
      assert.equal(a.ok, true)
      assert.equal(b.ok, false)
      assert.equal(b.reason, 'duplicate')
      const lines = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
      assert.equal(lines.length, 1)
      assert.equal(lines[0].text, '第一次')
      assert.equal(w.stats().duplicates, 1)
    },
  },

  {
    no: 6,
    name: '换天换文件：23:59 和 00:01 落在两个文件里',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const w = createWriter({ config: cfgWith(logs) })
      w.write({ sessionId: 'bili-whale', role: 'tianhai', text: '今天最后一句', seq: 1, t: localIso(2026, 10, 27, 23, 59, 0) })
      w.write({ sessionId: 'bili-whale', role: 'xiaoyu', text: '第二天第一句', seq: 2, t: localIso(2026, 10, 28, 0, 1, 0) })
      assert.deepEqual(logFiles(logs), [`${dateKey(2026, 10, 27)}.jsonl`, `${dateKey(2026, 10, 28)}.jsonl`].sort())
      const day1 = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
      const day2 = readLog(join(logs, `${dateKey(2026, 10, 28)}.jsonl`))
      assert.equal(day1.length, 1)
      assert.equal(day2.length, 1)
      assert.ok(day2[0].t.startsWith(dateKey(2026, 10, 28)))
    },
  },

  {
    no: 9,
    name: '目录不存在：自动建，不报错',
    async fn() {
      const dir = tmp()
      const deep = join(dir, 'a', 'b', 'c', 'logs')
      assert.equal(existsSync(deep), false)
      const w = createWriter({ config: cfgWith(deep) })
      const r = w.write({ sessionId: 'bili-whale', role: 'tianhai', text: '先建目录再写', seq: 7, t: localIso(2026, 10, 27, 12, 0, 0) })
      assert.equal(r.ok, true, '不该失败')
      assert.equal(existsSync(deep), true)
      assert.equal(readLog(join(deep, `${dateKey(2026, 10, 27)}.jsonl`)).length, 1)
      assert.equal(w.stats().failed, 0)
    },
  },

  {
    no: 10,
    name: '附加：重启之后同一个 seq 仍然判重（从文件读回 seq）',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const at = localIso(2026, 10, 27, 9, 0, 0)
      const w1 = createWriter({ config: cfgWith(logs) })
      assert.equal(w1.write({ sessionId: 'bili-whale', role: 'tianhai', text: '重启前', seq: 555, t: at }).ok, true)

      // 换一个 writer = 进程重启后的样子，内存里什么都没有
      const w2 = createWriter({ config: cfgWith(logs) })
      const r = w2.write({ sessionId: 'bili-whale', role: 'tianhai', text: '重启后（同 seq）', seq: 555, t: at })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'duplicate')
      assert.equal(readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`)).length, 1)
    },
  },

  {
    no: 12,
    name: '附加：时间格式与换行转义',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const w = createWriter({ config: cfgWith(logs) })
      const multi = '第一行\n第二行\n\n带空行'
      w.write({ sessionId: 'bili-whale', role: 'xiaoyu', text: multi, seq: 800, t: localIso(2026, 10, 27, 8, 8, 8) })
      const lines = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
      assert.equal(lines.length, 1, '一条消息一行（换行是转义的）')
      assert.equal(lines[0].text, multi, '原文一个字不许改')
      assert.match(lines[0].t, /^2026-10-27T08:08:08([+-]\d{2}:\d{2})$/)
      assert.equal(isoLocal(new Date(2026, 9, 27, 8, 8, 8)).slice(0, 19), '2026-10-27T08:08:08')
      assert.equal(localDateOf(new Date(2026, 9, 27, 8, 8, 8)), dateKey(2026, 10, 27))
    },
  },
]
