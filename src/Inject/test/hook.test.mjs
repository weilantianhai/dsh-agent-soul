/**
 * test/hook.test.mjs —— 钩子契约：塞进去、关了不塞、不污染别人
 */

import assert from 'node:assert/strict'

import { register, reset } from '../index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkRoot, cfgOf, fakeCtx, callHook, contextOf, injectedText, PERSONA } from './helpers.mjs'

export const tests = [
  {
    no: 1,
    name: '能塞进去：跑一遍钩子，sections 里多一段 memory:inject',
    async fn() {
      reset()
      const root = mkRoot()
      const ctx = fakeCtx()
      const errors = []
      const dispose = register(ctx, { config: cfgOf(root), onError: (e) => errors.push(e) })
      try {
        const assembled = await callHook(ctx, contextOf('bili-whale'))
        const seg = assembled.sections.find((s) => s.name === 'memory:inject')
        assert.ok(seg, '必须有 memory:inject 这一段')
        assert.ok(seg.text.length > 0)
        assert.equal(assembled.sections.length, 1)
        assert.deepEqual(errors, [], '不该报错')
      } finally {
        dispose()
      }
    },
  },

  {
    no: 2,
    name: '关了不塞：sections 长度不变，且没被改动（frozen）',
    async fn() {
      reset()
      const root = mkRoot()
      const ctx = fakeCtx()
      const sections = Object.freeze([])
      const assembly = Object.freeze({ sections })
      const dispose = register(ctx, { config: cfgOf(root, { enabled: false }) })
      try {
        const out = await callHook(ctx, contextOf('bili-whale'), assembly)
        assert.equal(out.sections.length, 0, '一个字都不许塞')
        assert.equal(injectedText(out), '')
      } finally {
        dispose()
      }
    },
  },

  {
    no: 3,
    name: '不许污染别人：关了的时候 return 的就是 next() 给的那个对象',
    async fn() {
      reset()
      const root = mkRoot()
      const ctx = fakeCtx()
      const assembly = { sections: [] }
      const dispose = register(ctx, { config: cfgOf(root, { enabled: false }) })
      try {
        const out = await callHook(ctx, contextOf('bili-whale'), assembly)
        assert.equal(out, assembly, '必须是同一个对象，不是新建的')
      } finally {
        dispose()
      }
    },
  },

  {
    no: 13,
    name: '附加：context 是空的也不抛错（报一次，一个字段不塞）',
    async fn() {
      reset()
      const root = mkRoot()
      const ctx = fakeCtx()
      const errors = []
      const dispose = register(ctx, { config: cfgOf(root), onError: (e) => errors.push(e) })
      try {
        const handler = [...ctx.handlers.get('system-prompt/assemble')][0]
        const assembly = { sections: [] }
        const out = await handler(null, {}, async () => assembly)
        assert.equal(out, assembly, '要原样交回去')
        assert.equal(out.sections.length, 0)
        assert.equal(errors.length, 1, '拿不到会话要报一次')
        assert.match(errors[0].message, /context\.agent\.session/)
      } finally {
        dispose()
      }
    },
  },
  {
    no: 99,
    name: '中途换人格要重新注入全量人格段',
    async fn() {
      const root = mkRoot()
      // 造两个人格
      mkdirSync(join(root, 'agents', 'A'), { recursive: true })
      mkdirSync(join(root, 'agents', 'B'), { recursive: true })
      writeFileSync(join(root, 'agents', 'A', '人格.md'), PERSONA.replaceAll('小鱼', 'A'), 'utf8')
      writeFileSync(join(root, 'agents', 'B', '人格.md'), PERSONA.replaceAll('小鱼', 'B'), 'utf8')
      writeFileSync(join(root, 'private', 'agents.json'), JSON.stringify({ 'bili-whale': 'A' }, null, 2), 'utf8')

      reset()
      const ctx = fakeCtx()
      const dispose = register(ctx, { config: cfgOf(root) })
      try {
        // ① 第一次：给 A 的全量人格
        const first = injectedText(await callHook(ctx, contextOf('bili-whale')))
        assert.ok(first.includes('A'), '第一次要给人格段')

        // ② 同人格第二轮：不该重复给人格段
        const second = injectedText(await callHook(ctx, contextOf('bili-whale')))
        assert.equal(second.includes('我是 A'), false, '同人格的第二轮不该再给全量人格段')

        // ③ 换成 B：必须重新给
        writeFileSync(join(root, 'private', 'agents.json'), JSON.stringify({ 'bili-whale': 'B' }, null, 2), 'utf8')
        const third = injectedText(await callHook(ctx, contextOf('bili-whale')))
        assert.ok(third.includes('B'), '换人格后要重新给全量人格段（这就是那个 bug）')
        return 'A → 省略 → B，换人时重新注入'
      } finally {
        dispose()
      }
    },
  },

]
