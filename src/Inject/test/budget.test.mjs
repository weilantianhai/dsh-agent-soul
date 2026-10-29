/**
 * test/budget.test.mjs —— 超预算会砍、路标不砍
 */

import assert from 'node:assert/strict'

import { buildInjection, reset } from '../index.mjs'
import { applyBudget, chars, shrinkDiary, hardTrim, lastParagraph } from '../budget.mjs'
import { mkRoot, cfgOf, contextOf } from './helpers.mjs'

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
    no: 9,
    name: '超预算会砍：预算调小，输出 ≤ 预算，且报了一次',
    async fn() {
      const root = mkRoot()
      const budget = { total: 300, persona: 1500, diary: 800, signpost: 200 }
      const { out, errors } = await build(root, { budget })
      // 预算管的是 C 层（人格/日记/路标/话板）；B 层说明书不进预算，见 manual.mjs
      assert.ok(out.cChars <= 300, `C 层实际 ${out.cChars} 字，超了`)
      assert.ok(out.manualChars > 0, '说明书应该有，但它不算进预算')
      assert.ok(errors.some((e) => /超预算/.test(e.message)), '砍了必须报，不许默默砍')
      assert.ok(out.cuts.length > 0, '要说明砍了什么')
    },
  },

  {
    no: 10,
    name: '路标不砍：预算调到 100，路标仍在',
    async fn() {
      const root = mkRoot()
      const budget = { total: 100, persona: 1500, diary: 800, signpost: 200 }
      const { out } = await build(root, { budget })
      assert.ok(out.text.includes('INDEX.md'), '路标是最后那根手指，不能砍')
      assert.ok(out.text.includes('agents/xiaoyu/'))
    },
  },

  {
    no: 16,
    name: '附加：砍日记时会把末尾那行路标留住',
    async fn() {
      const diary = '第一段流水账\n\n第二段流水账\n\n（细节：agents/xiaoyu/diary/bili-whale/2026-10-27.md · 人物：agents/xiaoyu/people/）'
      const shrunk = shrinkDiary(diary)
      assert.ok(shrunk.includes('（细节：'), '路标不能跟着正文一起砍')
      assert.ok(!shrunk.includes('第一段'), '正文只留最后一段')
      assert.ok(shrunk.startsWith('第二段流水账'))
    },
  },

  {
    no: 17,
    name: '附加：预算函数本身（单段上限、硬截断、优先级）',
    async fn() {
      // 单段上限
      const long = 'A'.repeat(500)
      const r1 = applyBudget({ persona: long, redline: 'R'.repeat(50), diary: '', signpost: 'S'.repeat(50), limits: { total: 2500, persona: 100, diary: 800, signpost: 200 } })
      assert.ok(chars(r1.persona) <= 100)
      assert.equal(r1.cuts.length, 1)

      // 总预算：先砍日记，再砍人格，路标不动
      const r2 = applyBudget({
        persona: 'P'.repeat(200),
        redline: 'R'.repeat(80),
        diary: 'D'.repeat(200),
        signpost: 'S'.repeat(60),
        limits: { total: 200, persona: 1500, diary: 800, signpost: 200 },
      })
      assert.equal(r2.signpost, 'S'.repeat(60), '路标一个字不许少')
      assert.ok(chars(r2.persona + r2.diary + r2.signpost) <= 200 + 20, '大致要在预算内')
      assert.ok(r2.cuts.length >= 1)

      // 硬截断带省略号
      assert.equal(hardTrim('一二三四五', 3), '一二…')
      assert.equal(lastParagraph('a\n\nb\n\nc'), 'c')
    },
  },
]
