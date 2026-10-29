/**
 * test/hook.test.mjs —— 钩子这一层：收什么、剔什么、什么时候不写
 * 用真的 index.start + 假 ctx，走完整链路（配置 → 钩子 → 落盘）。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'

import { start, stop, status } from '../index.mjs'
import {
  tmp,
  configFile,
  fakeCtx,
  readLog,
  logFiles,
  localIso,
  dateKey,
  userEvent,
  assistantEvent,
  SESSION,
} from './helpers.mjs'

const baseConfig = (dir, logs, extra = {}) => ({
  enabled: true,
  selfName: 'xiaoyu',
  ownerMid: '1000001',
  defaults: { log: false },
  sessions: { 'bili-whale': { log: true, dir: logs } },
  ...extra,
})

export const tests = [
  {
    no: 1,
    name: '能收到消息：推两条事件，文件里两行',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs)) })
        ctx.emit(SESSION, userEvent({ text: '小鱼小鱼我们继续', seq: 8812, at: localIso(2026, 10, 27, 20, 11, 3) }))
        ctx.emit(SESSION, assistantEvent({ text: '好，那我接着搭地基', seq: 8813, at: localIso(2026, 10, 27, 20, 11, 50) }))

        const lines = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
        assert.equal(lines.length, 2, '应该正好两行')
        assert.equal(lines[0].role, 'tianhai')
        assert.equal(lines[0].text, '小鱼小鱼我们继续')
        assert.equal(lines[0].seq, 8812)
        assert.equal(lines[1].role, 'xiaoyu')
        assert.equal(lines[1].text, '好，那我接着搭地基')
        assert.equal(lines[1].seq, 8813)
        // t 必须是带时区的 ISO，精确到秒
        assert.match(lines[0].t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
        assert.equal(status().written, 2)
      } finally {
        await stop()
      }
    },
  },

  {
    no: 2,
    name: '原文照录：一个字都不改',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      const raw = '【主人私信】someone（mid 1000001）刚给你发私信：\n\n小鱼小鱼收到请回复'
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs)) })
        ctx.emit(SESSION, userEvent({ text: raw, seq: 9001, at: localIso(2026, 10, 27, 21, 0, 0) }))

        const lines = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
        assert.equal(lines.length, 1)
        assert.equal(lines[0].text, raw)
        assert.equal(lines[0].role, 'tianhai')
      } finally {
        await stop()
      }
    },
  },

  {
    no: 3,
    name: '不收工具调用：tool-call / tool-result / reasoning 一条不写',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs)) })
        for (const type of ['tool-call', 'tool/result', 'reasoning', 'turn/start', 'turn/end']) {
          ctx.emit(SESSION, { type, data: { content: [{ type: 'text', text: '这是工具参数，不该被记' }] } })
        }
        assert.deepEqual(logFiles(logs), [], '不该产生任何文件')
      } finally {
        await stop()
      }
    },
  },

  {
    no: 4,
    name: '被打断跳过：interrupted 的助手输出不写',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs)) })
        ctx.emit(SESSION, assistantEvent({ text: '我说到一半被', seq: 9100, interrupted: true, at: localIso(2026, 10, 27, 22, 0, 0) }))
        assert.deepEqual(logFiles(logs), [])
        assert.equal(status().reasons.interrupted, 1)
      } finally {
        await stop()
      }
    },
  },

  {
    no: 7,
    name: '配置不记：log: false 的会话推一条不写',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const quiet = join(dir, 'quiet')
      const ctx = fakeCtx()
      const cfg = baseConfig(dir, logs, {
        sessions: {
          'bili-whale': { log: true, dir: logs },
          'xiaoxi-wechat': { log: false, dir: quiet },
        },
      })
      try {
        await start({ ctx, configPath: configFile(dir, cfg) })
        ctx.emit({ id: 'xiaoxi-wechat' }, userEvent({ text: '这条不该被记', seq: 9200 }))
        ctx.emit({ id: 'unknown-session' }, userEvent({ text: '不在表里的也不记', seq: 9201 }))
        assert.deepEqual(logFiles(quiet), [])
        assert.deepEqual(logFiles(logs), [])
        assert.equal(status().reasons['not-configured'], 2)
      } finally {
        await stop()
      }
    },
  },

  {
    no: 8,
    name: '关掉不崩：enabled: false 启动不报错，running 为 false',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      let thrown = null
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs, { enabled: false })) }).catch((e) => {
          thrown = e
        })
        assert.equal(thrown, null, '不许抛异常')
        assert.equal(status().running, false)
        ctx.emit(SESSION, userEvent({ text: '关掉了还能收吗', seq: 9300 }))
        assert.deepEqual(logFiles(logs), [])
      } finally {
        await stop()
      }
    },
  },

  {
    no: 13,
    name: '附加：只脱 user_query 标签，其它原样留',
    async fn() {
      const dir = tmp()
      const logs = join(dir, 'logs')
      const ctx = fakeCtx()
      const raw = [
        '<system-reminder data-role="user-context">',
        '<user_info>',
        'OS Version: win32',
        '</user_info>',
        '</system-reminder>',
        '<user_query>好的，那我们继续搭地基</user_query>',
      ].join('\n')
      try {
        await start({ ctx, configPath: configFile(dir, baseConfig(dir, logs)) })
        ctx.emit(SESSION, userEvent({ text: raw, seq: 9400, at: localIso(2026, 10, 27, 23, 0, 0) }))
        const lines = readLog(join(logs, `${dateKey(2026, 10, 27)}.jsonl`))
        assert.equal(lines.length, 1)
        assert.equal(lines[0].text, raw.replace(/<\/?user_query\b[^>]*>/gi, ''))
      } finally {
        await stop()
      }
    },
  },

  {
    no: 11,
    name: '附加：配置文件坏了也不崩，但要报出来',
    async fn() {
      const dir = tmp()
      const bad = join(dir, 'broken.json')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(bad, '{ 这不是 json', 'utf8')
      const errors = []
      let thrown = null
      try {
        await start({ ctx: fakeCtx(), configPath: bad, onError: (e) => errors.push(e) }).catch((e) => {
          thrown = e
        })
        assert.equal(thrown, null)
        assert.equal(status().running, false)
        assert.equal(errors.length, 1, 'onError 要收到一次')
      } finally {
        await stop()
      }
    },
  },
]
