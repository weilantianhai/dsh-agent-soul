#!/usr/bin/env node
/**
 * test/run.js —— 工具区验收（不起 DSH，不开浏览器）
 *
 *   cd <仓库根>/src/Search && node test/run.js
 *
 * 验的是四只手到底能不能伸出去、伸到哪儿为止：
 *   能找、能开、能读日记、能翻原文 —— 但**只碰得到自己的目录**。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { findMemory, openMemory, readDiary, readTranscript, summaryOf } from '../read.mjs'
import { buildTools, formatFind, register, TOOL_KEYS } from '../index.mjs'
import { agentForSession } from '../paths.mjs'

/* ------------------------------------------------------------------ 素材 */

const created = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-search-'))
  created.push(dir)
  return dir
}
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

const DAY = '2026-10-27'

function fixture() {
  const root = tmp()
  write(
    join(root, 'private', 'agents.json'),
    JSON.stringify({ 'sess-a': 'xiaoyu', 'sess-b': 'xiaoxi', 'sess-d': 'xiaoyu' }, null, 2),
  )
  write(join(root, 'system', 'sessions.json'), JSON.stringify({ sessions: { 'sess-a': { name: '小鱼' } } }))

  const yu = join(root, 'agents', 'xiaoyu')
  write(join(yu, 'INDEX.md'), '# 小鱼的目录\n\n- 人格.md\n- people/\n')
  write(join(yu, '人格.md'), '# 小鱼\n\n## 一、你是谁\n\n你是小鱼。\n')
  write(join(yu, 'people', 'tianhai.md'), '# tianhai\n\n- 主人，B 站那个 —— 出处 · 记于 2026-10-27\n')
  write(join(yu, '经验.md'), '## 2026-10-23 · 发评论被吞\n\n发一次失败就停手。\n')
  write(
    join(yu, 'diary', 'bili-whale', `${DAY}.md`),
    ['# 2026-10-27', '', '## 总结', '今天在搭记忆系统的地基。', '', '## 20:11 · 记忆系统', '【不该出现的正文】流水账。', ''].join('\n'),
  )
  write(
    join(yu, 'diary', 'bili-whale', '私房日记.md'),
    ['# 私房日记', '', '## 2026-10-25 · 旧的一天', '那天很累。', '', '## 2026-10-26 中午', '四毛钱那座故宫。', ''].join('\n'),
  )

  const xi = join(root, 'agents', 'xiaoxi')
  write(join(xi, '人格.md'), '# 小汐\n\n我是小汐，小鱼不认识我。\n')
  write(join(xi, 'people', 'secret.md'), '# 秘密\n\n小汐的私事。\n')

  write(
    join(root, 'sessions', 'sess-a', 'logs', `${DAY}.jsonl`),
    [
      { t: `${DAY}T20:11:03+08:00`, role: 'tianhai', text: '小鱼小鱼我们继续', seq: 1 },
      { t: `${DAY}T20:11:50+08:00`, role: 'xiaoyu', text: '好，那我接着搭地基', seq: 2 },
      { t: `${DAY}T20:12:10+08:00`, role: 'tianhai', text: '今天晚上吃什么', seq: 3 },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )

  write(
    join(root, 'sessions', 'sess-d', 'logs', `${DAY}.jsonl`),
    JSON.stringify({ t: `${DAY}T09:00:00+08:00`, role: 'tianhai', text: '早上好', seq: 1 }) + '\n',
  )

  write(join(root, 'shared', 'board.md'), '# 话板\n\n**2026-10-27 · 小汐**\n好。\n')
  return root
}

/* ------------------------------------------------------------------ 跑 */

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push({ ok: true, name })
  } catch (err) {
    results.push({ ok: false, name, err })
  }
}

const root = fixture()
const deps = { rootDir: root, maxChars: 4000 }

await check('1. find：按关键词找到人，给 id + 一句摘要', async () => {
  const r = findMemory({ rootDir: root, agentId: 'xiaoyu', query: '主人' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].id, 'people/tianhai')
  assert.match(r.hits[0].excerpt, /B 站那个/)
})

await check('2. find：不扫日记（日记有专门的工具）', async () => {
  const r = findMemory({ rootDir: root, agentId: 'xiaoyu', query: '地基' })
  assert.equal(r.hits.length, 0, '日记里的词不该被 find 命中')
})

await check('3. find：找不到就明说，不编', async () => {
  const r = findMemory({ rootDir: root, agentId: 'xiaoyu', query: '不存在的东西' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 0)
  assert.match(formatFind(r), /没找到/)
})

await check('4. find：空 query 直接拒', async () => {
  const r = findMemory({ rootDir: root, agentId: 'xiaoyu', query: '   ' })
  assert.equal(r.ok, false)
})

await check('5. open：读全文，.md 可省', async () => {
  const a = openMemory({ rootDir: root, agentId: 'xiaoyu', id: 'people/tianhai' })
  assert.ok(a.ok)
  assert.match(a.text, /主人，B 站那个/)
  const b = openMemory({ rootDir: root, agentId: 'xiaoyu', id: 'people/tianhai.md' })
  assert.ok(b.ok)
})

await check('6. open：../ 和绝对路径都挡下来', async () => {
  assert.equal(openMemory({ rootDir: root, agentId: 'xiaoyu', id: '../xiaoxi/人格' }).ok, false)
  assert.equal(openMemory({ rootDir: root, agentId: 'xiaoyu', id: 'D:/etc/passwd' }).ok, false)
  const r = openMemory({ rootDir: root, agentId: 'xiaoyu', id: '../xiaoxi/人格' })
  assert.match(r.error, /不接受/)
})

await check('7. 红线：小鱼的会话读不到小汐的任何东西', async () => {
  const r = openMemory({ rootDir: root, agentId: 'xiaoyu', id: 'people/secret' })
  assert.equal(r.ok, false, '别的 agent 的文件必须打不开（路径都不在 xiaoyu 目录下）')
  const f = findMemory({ rootDir: root, agentId: 'xiaoyu', query: '小汐' })
  assert.equal(f.hits.length, 0, '小鱼的 find 里不许出现小汐的字')
})

await check('8. diary：只给「总结」，不给正文；按日期倒序', async () => {
  const r = readDiary({ rootDir: root, agentId: 'xiaoyu', days: 10 })
  assert.ok(r.ok)
  const dates = r.entries.map((e) => e.date)
  assert.deepEqual(dates, ['2026-10-27', '2026-10-26', '2026-10-25'])
  const today = r.entries.find((e) => e.date === DAY)
  assert.match(today.summary, /记忆系统的地基/)
  assert.equal(JSON.stringify(r).includes('不该出现的正文'), false, '日记正文不许进工具输出')
})

await check('9. diary：days 能限天数', async () => {
  const r = readDiary({ rootDir: root, agentId: 'xiaoyu', days: 1 })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].date, DAY)
})

await check('10. diary：单文件日记（私房日记.md）也能按日期取到', async () => {
  const r = readDiary({ rootDir: root, agentId: 'xiaoyu', days: 10, session: 'bili-whale' })
  assert.ok(r.entries.some((e) => e.date === '2026-10-26' && /四毛钱/.test(e.summary)))
})

await check('11. recall：给最后几条原文，正文一个字不改', async () => {
  const r = readTranscript({ rootDir: root, sessionId: 'sess-a', date: DAY })
  assert.ok(r.ok)
  assert.equal(r.total, 3)
  assert.equal(r.lines.at(-1).text, '今天晚上吃什么')
})

await check('12. recall：limit 和 query 都能用', async () => {
  const lim = readTranscript({ rootDir: root, sessionId: 'sess-a', date: DAY, limit: 1 })
  assert.equal(lim.lines.length, 1)
  assert.equal(lim.truncated, true)
  const q = readTranscript({ rootDir: root, sessionId: 'sess-a', date: DAY, query: '地基' })
  assert.equal(q.lines.length, 1)
  assert.match(q.lines[0].text, /搭地基/)
})

await check('13. recall：那天没日志就明说', async () => {
  const r = readTranscript({ rootDir: root, sessionId: 'sess-a', date: '2000-01-01' })
  assert.equal(r.ok, false)
  assert.match(r.error, /没有日志/)
})

await check('13.5 recall：默认就返回这个人格所有会话的日志（不串别的 agent）', async () => {
  const tools = buildTools({ ...deps, sessionIdOf: (exec) => exec?.agent?.id ?? null })
  const exec = { agent: { id: 'sess-a' } }

  // 不传 session：默认就是"这个人的所有会话"
  const r = await tools.memory_recall.execute({ date: DAY }, exec)
  assert.equal(r.ok, true)
  assert.equal(r.sessions, 2, 'xiaoyu 名下两个会话')
  assert.match(r.text, /#1 tianhai: 小鱼小鱼我们继续/)
  assert.match(r.text, /#2 tianhai: 早上好/)
  assert.match(r.text, /会话：.*sess-a/, '要给一张"#几 是哪个会话"的对照')
  assert.equal(r.text.includes('sess-b'), false, '别的 agent 的会话不许进来')
  assert.ok(r.text.indexOf('早上好') < r.text.indexOf('我们继续'), '按时间排')

  // 写 this：只看当前这个
  const one = await tools.memory_recall.execute({ date: DAY, session: 'this' }, exec)
  assert.equal(one.text.includes('早上好'), false, 'this = 只看当前会话')
  assert.match(one.text, /我们继续/)

  // 写具体 id：只看那一个
  const pinned = await tools.memory_recall.execute({ date: DAY, session: 'sess-d' }, exec)
  assert.match(pinned.text, /早上好/)
  assert.equal(pinned.text.includes('我们继续'), false)
})

await check('13.6 recall：只在日记目录里出现过的会话，也算这个人格的', async () => {
  // 只给 sess-e 建了日记，归属表里没有它 —— 也要算进来
  write(join(root, 'agents', 'xiaoyu', 'diary', 'sess-e', `${DAY}.md`), '# 2026-10-27\n\n## 总结\n\n今天很好。\n')
  write(
    join(root, 'sessions', 'sess-e', 'logs', `${DAY}.jsonl`),
    JSON.stringify({ t: `${DAY}T07:00:00+08:00`, role: 'tianhai', text: '一早的问候', seq: 1 }) + '\n',
  )
  const tools = buildTools({ ...deps, sessionIdOf: (exec) => exec?.agent?.id ?? null })
  const r = await tools.memory_recall.execute({ date: DAY }, { agent: { id: 'sess-a' } })
  assert.equal(r.sessions, 3, '归属表 + 日记目录 取并集')
  assert.match(r.text, /一早的问候/)
})

await check('14. 归属：会话 → agent 走 agents.json，找不到就是没有', async () => {
  assert.equal(agentForSession({ rootDir: root, sessionId: 'sess-a' }).agentId, 'xiaoyu')
  assert.equal(agentForSession({ rootDir: root, sessionId: 'sess-b' }).agentId, 'xiaoxi')
  assert.equal(agentForSession({ rootDir: root, sessionId: 'nobody' }).agentId, null)
})

await check('15. 工具定义：五个都在，schema 和描述齐', async () => {
  const tools = buildTools({ ...deps, sessionIdOf: () => 'sess-a' })
  /*
   * 不再硬编码工具清单 —— 2026-10-29 加了 memory_index 之后，
   * 这里还在比"四个"，于是明明是对的也被判失败。
   * 改成跟 TOOL_KEYS 对齐：新加工具只要改了 TOOL_KEYS，这条自动跟上。
   */
  const expected = Object.keys(TOOL_KEYS).sort()
  assert.deepEqual(
    Object.keys(tools).sort(),
    expected,
    `工具清单要和 TOOL_KEYS 一致（实际 ${Object.keys(TOOL_KEYS).join(',')}）`,
  )
  for (const [name, def] of Object.entries(tools)) {
    assert.equal(def.name, name)
    assert.ok(def.description.length > 30, `${name} 的描述要说清什么时候用`)
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
  }
  assert.match(tools.memory_recall.description, /只在两个场合用/, 'recall 必须写明别乱用')
})

await check('16. 真调 execute：走 exec.agent.id 找到自己的 agent', async () => {
  const tools = buildTools({
    ...deps,
    sessionIdOf: (exec) => exec?.agent?.id ?? null,
  })
  const exec = { agent: { id: 'sess-a' } }
  const r = await tools.memory_find.execute({ query: '主人' }, exec)
  assert.ok(r.ok)
  assert.match(r.text, /people\/tianhai/)
  assert.equal(tools.memory_find.output.render({}, r)[0].type, 'text')
})

await check('17. 真调 execute：没有 agent 的会话，工具明说读不到', async () => {
  const tools = buildTools({ ...deps, sessionIdOf: (exec) => exec?.agent?.id ?? null })
  const r = await tools.memory_open.execute({ id: 'INDEX' }, { agent: { id: 'nobody' } })
  assert.equal(r.ok, false)
  assert.match(r.text, /没有认领的人格/)
})

await check('18. register：全部挂上，关掉的挂不上，没服务要报', async () => {
  const registered = []
  const fakeTools = { register: (def) => (registered.push(def.name), () => {}) }
  const ctx = { get: (n) => (n === 'tools' ? fakeTools : undefined) }
  const r = register(ctx, { rootDir: root, config: { enabled: true } })
  // 数量跟 TOOL_KEYS 走，不写死
  assert.equal(registered.length, Object.keys(TOOL_KEYS).length)
  assert.deepEqual(r.names.sort(), Object.keys(TOOL_KEYS).sort())
  r.dispose()

  registered.length = 0
  register(ctx, { rootDir: root, config: { enabled: true, recall: false } })
  assert.equal(registered.includes('memory_recall'), false, '关掉的工具不该挂')
  // 总数减一（关掉 recall），不写死
  assert.equal(registered.length, Object.keys(TOOL_KEYS).length - 1)

  const errors = []
  register({}, { rootDir: root, config: { enabled: true }, onError: (e) => errors.push(e) })
  assert.equal(errors.length, 1, '没有 tools 服务要报一次，不许静默')
})

await check('19. register：总开关关掉，一个都不挂也不报错', async () => {
  const registered = []
  const ctx = { get: () => ({ register: (d) => (registered.push(d.name), () => {}) }) }
  register(ctx, { rootDir: root, config: { enabled: false } })
  assert.equal(registered.length, 0)
})

await check('20. summaryOf：只认 ## 总结 那一节', async () => {
  const s = summaryOf('# 2026-10-27\n\n## 总结\n\n今天很好。\n\n## 20:11 · 别的\n\n正文。\n')
  assert.equal(s, '今天很好。')
  assert.equal(summaryOf('没有总结的日记'), '')
})

/* ---------------------------------------------------------------- 收尾 */

for (const dir of created) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 在 temp 里，删不掉也没事 */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n工具区验收 · ${results.length} 条\n${'─'.repeat(62)}`)
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
