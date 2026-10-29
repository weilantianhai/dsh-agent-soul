/**
 * test/assemble.test.mjs —— 拼的内容对不对：人格只取摘要、红线必须在、日记只取总结、不许串 agent
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'

import { buildInjection, reset } from '../index.mjs'
import { mkRoot, cfgOf, contextOf, writeFile } from './helpers.mjs'

const build = async (root, overrides = {}) => {
  reset()
  const errors = []
  const out = await buildInjection(contextOf('bili-whale'), {
    config: cfgOf(root, overrides),
    onError: (e) => errors.push(e),
  })
  return { out, errors }
}

export const tests = [
  {
    no: 4,
    name: '人格只取摘要：没有「三、怎么说话」的正文',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root)
      assert.ok(out.text.includes('你是**小鱼**'), '开头那段要在')
      assert.ok(!out.text.includes('说话要短'), '§三 正文不许进来')
      assert.ok(!out.text.includes('不用到处提他'), '§九 正文不许进来')
      assert.ok(!/##\s*三、怎么说话/.test(out.text), '§三 标题也不许进来')
    },
  },

  {
    no: 5,
    name: '红线必须在：输出里有红线那一节',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root)
      assert.ok(/红线/.test(out.text), '红线标题要在')
      assert.ok(out.text.includes('不泄露隐私'), '红线正文要在')
    },
  },

  {
    no: 6,
    name: '日记只取总结：没有日记正文小节',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root)
      assert.ok(out.text.includes('搭记忆系统的地基'), '总结要在')
      assert.ok(!out.text.includes('这一段是流水账'), '日记正文不许进来')
      assert.ok(!out.text.includes('20:11'), '小节标题也不许进来')
      assert.ok(!out.text.includes('昨天的总结'), '只取最近一篇，不许拿旧的')
    },
  },

  {
    no: 7,
    name: '有路标：输出里有 INDEX.md 和 agents/xiaoyu/',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root)
      assert.ok(out.text.includes('INDEX.md'))
      assert.ok(out.text.includes('agents/xiaoyu/'))
      assert.ok(out.text.includes('别凭着印象说'))
    },
  },

  {
    no: 8,
    name: '不许串 agent：agents/xiaoxi 里的字一个都搜不到',
    async fn() {
      const root = mkRoot()
      // 造一个小汐的目录，里面写满她的东西
      writeFile(join(root, 'agents', 'xiaoxi', '人格.md'), '# 小汐 · 人格\n\n## 十二、红线\n\n我是小汐，不许串台。\n')
      writeFile(
        join(root, 'agents', 'xiaoxi', 'diary', 'bili-whale', '2026-10-27.md'),
        '# 2026-10-27\n\n## 总结\n\n小汐的秘密总结。\n',
      )
      const { out } = await build(root)
      assert.ok(out.text.length > 0)
      assert.ok(!out.text.includes('小汐'), '一个小汐的字都不许出现')
      assert.ok(!out.text.includes('不许串台'))
    },
  },

  {
    no: 11,
    name: '没日记不崩：删掉 diary 目录，其余照常',
    async fn() {
      const root = mkRoot({ withDaily: false, withBook: false })
      const { out, errors } = await build(root)
      assert.ok(!out.text.includes('最近的日记：'), '不该有日记段（注意「最近的日记」四个字在碎碎念正文里也会出现，这里要认段头）')
      assert.ok(out.text.includes('不泄露隐私'), '人格还在')
      assert.ok(out.text.includes('INDEX.md'), '路标还在')
      assert.deepEqual(errors, [], '没日记不是错误，不许报')
    },
  },

  {
    no: 12,
    name: '找不到 agent 要报：报一次，且不塞一段假的',
    async fn() {
      const root = mkRoot({ skipAgentDir: true })
      const { out, errors } = await build(root)
      assert.equal(errors.length, 1, 'onError 要收到一次')
      assert.match(errors[0].message, /找不到对应的 agent/)
      assert.equal(out.text, '', '不许凭空塞一段')
      assert.equal(out.sections.length, 0)
    },
  },

  {
    no: 14,
    name: '附加：单文件日记形态（私房日记.md 里的日期小节）也能取到最新那节',
    async fn() {
      const root = mkRoot({ withDaily: false, withBook: true })
      const { out } = await build(root)
      assert.ok(out.text.includes('四毛钱'), '要取到 2026-10-27 那节')
      assert.ok(!out.text.includes('旧小节正文'), '不许取旧的那节')
      assert.ok(out.text.includes('私房日记.md'), '路标里要指出细节在哪')
    },
  },

  {
    no: 15,
    name: '附加：只关一段，别的段照常',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root, { sections: { persona: false, diarySummary: true, signpost: true } })
      assert.ok(!out.text.includes('不泄露隐私'), '人格关了就不许有')
      assert.ok(out.text.includes('搭记忆系统的地基'), '日记还在')
      assert.ok(out.text.includes('INDEX.md'), '路标还在')
    },
  },

  {
    no: 18,
    name: '附加：includeFirstSection=false 时只取开头（按约定：只要开头那一段）',
    async fn() {
      const root = mkRoot()
      const { out } = await build(root, { persona: { includeFirstSection: false } })
      assert.ok(out.text.includes('这是我自己'), '开头那段要留')
      assert.ok(!out.text.includes('家人型朋友'), '§一 关掉就不该有')
      assert.ok(out.text.includes('不泄露隐私'), '红线永远在')
    },
  },
]
