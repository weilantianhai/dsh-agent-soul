#!/usr/bin/env node
/**
 * test/run.js —— Daily 验收（不起 DSH）
 *
 *   cd <仓库根>/src/Daily && node test/run.js
 *
 * 验的是设计文档 §2.1 那四条筛子 + §2.2.1 的"叫醒不追"：
 *   没归档 / 有人格 / 开了日记 / 当天有料 / 不忙；叫一次；不重试；不催。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  planSessions,
  buildDraft,
  ensureDiary,
  wakeText,
  localDate,
  addDays,
  readState,
  DEFAULT_CONFIG,
} from '../daily.mjs'
import { runOnce, nextRunAt, parseTime, stop } from '../index.mjs'

const created = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsh-daily-'))
  created.push(d)
  return d
}
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}
const read = (file) => readFileSync(file, 'utf8')

const TODAY = localDate()
const YDAY = addDays(TODAY, -1)

function logLines(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    out.push(JSON.stringify({ t: `${TODAY}T20:${String(i).padStart(2, '0')}:00+08:00`, role: i % 2 ? 'xiaoyu' : 'tianhai', text: `第 ${i} 句`, seq: i }))
  }
  return out.join('\n') + '\n'
}

function fixture() {
  const root = tmp()
  write(join(root, 'private', 'agents.json'), JSON.stringify({ 's-a': 'xiaoyu', 's-b': 'xiaoyu', 's-c': 'xiaoxi' }, null, 2))
  write(
    join(root, 'system', 'sessions.json'),
    JSON.stringify({ sessions: { 's-a': { archived: false }, 's-z': { archived: true } } }, null, 2),
  )
  write(join(root, 'agents', 'xiaoyu', '人格.md'), '# 小鱼\n')
  write(join(root, 'agents', 'xiaoxi', '人格.md'), '# 小汐\n')
  write(join(root, 'sessions', 's-a', 'logs', `${TODAY}.jsonl`), logLines(8))
  write(join(root, 'sessions', 's-b', 'logs', `${TODAY}.jsonl`), logLines(2))
  write(join(root, 'sessions', 's-c', 'logs', `${TODAY}.jsonl`), logLines(10))
  return root
}

/*
 * 测试里的"某天几点"一律用 TODAY 那天，**不写死日期**。
 * 2026-10-29 踩到：这里原来写死 new Date(2026, 9, 28, ...)，
 * 而 TODAY 取的是"今天" —— 日期一过，日志文件名和 now 就对不上，
 * 所有用例集体报 too-quiet(0)。
 */
const at = (hour, minute = 0) => {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d
}

function fakeCtx({ fail = false } = {}) {
  const prompts = []
  const controller = {
    async list() {
      return {
        items: [
          { sessionId: 's-a', running: false, blank: false, updatedAt: at(20).getTime() },
          { sessionId: 's-b', running: false, blank: false, updatedAt: at(20).getTime() }, // 只有 2 句
          { sessionId: 's-c', running: false, blank: false, updatedAt: at(18).getTime() },
          { sessionId: 's-busy', running: true, blank: false, updatedAt: at(21).getTime() },
          { sessionId: 's-blank', running: false, blank: true, updatedAt: at(21).getTime() },
          { sessionId: 's-sub', running: false, blank: false, origin: 'subagent', updatedAt: at(21).getTime() },
          { sessionId: 's-old', running: false, blank: false, updatedAt: at(9).getTime() - 3 * 86400_000 },
          { sessionId: 's-nobody', running: false, blank: false, updatedAt: at(21).getTime() },
          { sessionId: 's-z', running: false, blank: false, updatedAt: at(21).getTime() }, // 归档
        ],
      }
    },
    async prompt(req, source) {
      if (fail) throw new Error('宿主不收')
      prompts.push({ ...req, __source: source })
      return { accepted: true }
    },
  }
  return { ctx: { get: (n) => (n === 'sessionController' ? controller : undefined) }, prompts }
}

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push({ ok: true, name })
  } catch (err) {
    results.push({ ok: false, name, err })
  }
}

/* ------------------------------------------------------------------ 测 */

await check('1. 时间解析与下一次触发', async () => {
  assert.deepEqual(parseTime('23:30'), { hour: 23, minute: 30 })
  assert.deepEqual(parseTime('写错了'), { hour: 23, minute: 30 })
  /*
   * 不写死日期 —— 用"今天/明天"自己算，否则过一天就红。
   * 2026-10-29 踩到过：这里原来是 28 / 29。
   */
  const today = new Date().getDate()
  const nextDay = new Date(Date.now() + 86400000).getDate()
  assert.equal(new Date(nextRunAt(at(22), '23:30')).getDate(), today, '没到点就是今天晚上')
  assert.equal(new Date(nextRunAt(at(23, 45), '23:30')).getDate(), nextDay, '过了点就是明天晚上')
})

await check('2. 四重过滤：只留"今天动过、有人格、有料"的（忙不忙都发）', async () => {
  const root = fixture()
  const { ctx } = fakeCtx()
  const items = (await ctx.get('sessionController').list()).items
  const plan = planSessions({
    rootDir: root,
    summaries: items,
    ownership: { 's-a': 'xiaoyu', 's-b': 'xiaoyu', 's-c': 'xiaoxi' },
    registry: { sessions: { 's-z': { archived: true } } },
    config: { minLines: 6 },
    now: at(20),
  })
  const ready = plan.ready.map((r) => r.sessionId).sort()
  assert.deepEqual(ready, ['s-a', 's-c'], `该叫的只有 s-a / s-c，实际 ${ready}`)
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.sessionId, s.reason]))
  assert.equal(reasons['s-b'].startsWith('too-quiet'), true, '只有两句不写')
  /*
   * 忙也发（2026-10-29 用户定的）——
   * prompt 用的是 mode:'queue'，本来就排队；跳过只会让
   * "在对话里点按钮 → 自己永远收不到"这种事发生。
   * s-busy 没有日志，所以它应该因为 too-quiet 被跳过，
   * 而不是因为 busy。
   */
  assert.equal(reasons['s-busy'] === 'busy', false, '不该再因为"忙"跳过')
  // s-busy 没绑人格、也没日志 —— 被别的条件挡掉都行，只要不是 busy
  assert.ok(reasons['s-busy'], 's-busy 还是会被别的条件挡')
  assert.equal(reasons['s-blank'], 'blank')
  assert.equal(reasons['s-sub'], 'subagent')
  assert.equal(reasons['s-old'], 'not-active-today')
  assert.equal(reasons['s-nobody'], 'no-agent', '没有认领的人格 = 临时会话')
  assert.equal(reasons['s-z'], 'archived', '归档不写')
})

await check('3. 产稿：按会话分开，只收真说的话', async () => {
  const root = fixture()
  const d = buildDraft({ rootDir: root, agentId: 'xiaoyu', sessionId: 's-a', date: TODAY })
  assert.match(d.text, /第 0 句/)
  assert.match(d.text, /s-a/, '稿子上要带会话')
  const file = join(root, 'agents', 'xiaoyu', 'diary', '.draft', 's-a', `${TODAY}.md`)
  assert.equal(existsSync(file), false, 'buildDraft 只产不写')
})

await check('4. 日记壳子带会话标签，已存在的不动', async () => {
  const root = fixture()
  const a = ensureDiary({ rootDir: root, agentId: 'xiaoyu', sessionId: 's-a', date: TODAY })
  assert.equal(a.created, true)
  const text = read(a.file)
  assert.match(text, new RegExp(`会话：s-a`), '打上自己会话的标签')
  assert.match(text, /## 总结/, '骨架里要有总结那一节')

  write(a.file, '# 她自己写的\n\n## 总结\n\n今天很好。\n')
  const b = ensureDiary({ rootDir: root, agentId: 'xiaoyu', sessionId: 's-a', date: TODAY })
  assert.equal(b.created, false, '她自己写过的就别碰')
  assert.match(read(b.file), /今天很好/, '一个字都不许改')
})

await check('5. 叫醒词：稿子、目标、会话号、三件事都在', async () => {
  const t = wakeText({
    agentId: 'xiaoyu',
    sessionId: 's-a',
    date: TODAY,
    draft: 'D:/x/agents/xiaoyu/diary/.draft/s-a/2026-10-28.md',
    diary: 'D:/x/agents/xiaoyu/diary/s-a/2026-10-28.md',
  })
  /*
   * 2026-10-29 改：叫醒词从"只写日记"扩成"全面记忆归档"。
   * 所以标题从「日记时间」变成「每日复盘时间」，也多出了四件事。
   */
  assert.match(t, /【每日复盘时间】/)
  assert.match(t, /\.draft\/s-a/, '要告诉她稿子在哪')
  assert.match(t, /diary\/s-a\//, '要告诉她写到哪')
  assert.match(t, /s-a/, '要带上会话号')
  assert.match(t, /稿子只是引子/)

  /* 四件事都得在 —— 否则又退回"只写日记" */
  assert.match(t, /## 1\. 写今天的日记/, '第一件：写日记')
  assert.match(t, /## 2\. 更新你认识的人/, '第二件：people/')
  assert.match(t, /## 3\. 更新你的经验库/, '第三件：经验')
  assert.match(t, /## 4\. 维护你的大脑地图/, '第四件：INDEX / MEMORY')

  assert.equal(t.includes('你没写'), false, '昨天写了就不提')
})

await check('6. 跑一轮：产稿 + 建壳 + 叫醒两个人，话术带会话号', async () => {
  const root = fixture()
  const { ctx, prompts } = fakeCtx()
  const r = await runOnce(ctx, { rootDir: root, config: { ...DEFAULT_CONFIG, minLines: 6 }, now: at(23, 30) })
  assert.deepEqual(r.woke.sort(), ['s-a', 's-c'])
  assert.equal(prompts.length, 2, '两条叫醒')

  const sa = prompts.find((p) => p.sessionId === 's-a')
  assert.equal(sa.mode, 'queue')
  assert.match(sa.requestId, /dsh-memory-daily-/)
  // 第二个参数是「来源」，决定界面上是灰卡片还是一条用户消息
  // 第二个参数必须是 AbortSignal（真机栈：Proxy.prompt 第一行 signal.throwIfAborted()）
  assert.equal(typeof sa.__source?.throwIfAborted, 'function', '第二个参数必须是 AbortSignal')
  assert.match(sa.content[0].text, /s-a/)

  assert.ok(existsSync(join(root, 'agents', 'xiaoyu', 'diary', '.draft', 's-a', `${TODAY}.md`)), '稿子要落盘')
  assert.ok(existsSync(join(root, 'agents', 'xiaoyu', 'diary', 's-a', `${TODAY}.md`)), '日记壳子要建好')
  assert.ok(existsSync(join(root, 'agents', 'xiaoxi', 'diary', 's-c', `${TODAY}.md`)), '另一个 agent 也有自己的')
})

await check('7. 一天只叫一次：再跑就被挡（成功/失败都算跑过）', async () => {
  const root = fixture()
  const { ctx } = fakeCtx()
  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30) })
  const again = await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 31) })
  assert.equal(again.reason, 'already-ran-today')
  assert.equal(again.woke.length, 0)

  const st = readState(join(root, 'system', 'daily.state.json'))
  assert.ok(st.byDate[TODAY].ran, '要记下"今天跑过了"')
  assert.ok(st.byDate[TODAY].woke.length >= 1)
})

await check('8. 叫不醒：记一笔，不重试，也不带崩别的', async () => {
  const root = fixture()
  const { ctx } = fakeCtx({ fail: true })
  const errors = []
  const r = await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30), onError: (e) => errors.push(e) })
  assert.equal(r.woke.length, 0)
  assert.ok(r.skipped.some((s) => String(s.reason).startsWith('wake-failed')))
  assert.ok(errors.length >= 1, '失败要报，不许静默')

  const again = await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 31) })
  assert.equal(again.reason, 'already-ran-today', '失败了也不当天重试')
})

await check('9. 昨天没写：只在今天说一句，不补稿', async () => {
  const root = fixture()
  const { ctx, prompts } = fakeCtx()
  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30) })
  const sa = prompts.find((p) => p.sessionId === 's-a')
  assert.match(sa.content[0].text, /昨天/, '昨天没写要提一句')
  assert.match(sa.content[0].text, /不催/, '提了但不催')
})

await check('10. 没有 sessionController：明说，不静默', async () => {
  const root = fixture()
  const errors = []
  const r = await runOnce({}, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30), onError: (e) => errors.push(e) })
  assert.equal(r.reason, 'no-session-controller')
  assert.equal(errors.length, 1)
})

await check('11. 关掉就什么都不做', async () => {
  const root = fixture()
  const { ctx, prompts } = fakeCtx()
  const r = await runOnce(ctx, { rootDir: root, config: { ...DEFAULT_CONFIG, enabled: false }, now: at(23, 30) })
  assert.equal(r.reason, 'disabled')
  assert.equal(prompts.length, 0)
})

await check('13. 手动触发：force 能再叫一次，且和自动叫完全一样', async () => {
  const root = fixture()
  const { ctx, prompts } = fakeCtx()

  // 先正常跑一次，把这天占掉
  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30) })
  const again = await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 31) })
  assert.equal(again.reason, 'already-ran-today', '不 force 就该被挡')

  // 手动触发：force
  prompts.length = 0
  const manual = await runOnce(ctx, {
    rootDir: root,
    config: DEFAULT_CONFIG,
    now: at(23, 32),
    force: true,
  })
  assert.equal(manual.woke.length, 2, 'force 要能再叫一次')
  assert.equal(prompts.length, 2, '真的投了两条')

  /*
   * 关键：**不许给会话打"测试"标记**（2026-10-29 用户定的）。
   * 这个按钮关键时刻也用来真的补写日记 ——
   * 叫它"测试"，会话就会敷衍：写坏了没关系、随便凑两句。
   * 所以对会话来说，这就是一次正常的写日记，和到点自动叫没区别。
   */
  const text = prompts[0].content[0].text
  assert.equal(text.includes('测试'), false, '不许出现"测试"字样，会话会敷衍')
  assert.match(text, /【每日复盘时间】/, '和正常叫醒一样开头')
})

await check('14. 手动触发和自动触发产出的叫醒词完全一致', async () => {
  const root = fixture()
  const { ctx, prompts } = fakeCtx()

  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30) })
  const auto = prompts[0].content[0].text

  prompts.length = 0
  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30), force: true })
  const manual = prompts[0].content[0].text

  assert.equal(manual, auto, '两份叫醒词必须一字不差 —— 会话分不出来哪个是手动点的')
})

await check('12. 稿子和日记分目录：同一 agent 两个会话不重名', async () => {
  const root = fixture()
  const { ctx } = fakeCtx()
  await runOnce(ctx, { rootDir: root, config: DEFAULT_CONFIG, now: at(23, 30) })
  const a = join(root, 'agents', 'xiaoyu', 'diary', 's-a', `${TODAY}.md`)
  const c = join(root, 'agents', 'xiaoxi', 'diary', 's-c', `${TODAY}.md`)
  assert.ok(existsSync(a) && existsSync(c))
  assert.match(read(a), /会话：s-a/)
  assert.match(read(c), /会话：s-c/)
})

stop()
for (const d of created) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* temp 里，删不掉没事 */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\nDaily 验收 · ${results.length} 条\n${'─'.repeat(62)}`)
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
console.log('─'.repeat(62))
console.log(`  通过 ${results.length - failed.length} / ${results.length}`)

if (failed.length) {
  console.log('\n  失败详情：')
  for (const f of failed) console.log(`\n  [${f.name}]\n${String(f.err?.stack || f.err).split('\n').map((l) => `    ${l}`).join('\n')}`)
  console.log('\n  没过。\n')
  process.exit(1)
}
console.log('\n  全绿。\n')
