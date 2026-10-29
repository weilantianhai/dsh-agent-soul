#!/usr/bin/env node
/**
 * registry.mjs —— 登记表（system/sessions.json）怎么会是空的
 *
 * 2026-10-28 真机现象：插件三块全绿、接口也活了，但设置页「登记表」一片空白。
 * 两个独立原因，这里各钉一条：
 *
 *   1. **取数形状错了**：以前只读 `agent.session.id`，而宿主的 `Agent` 就是 `{ id }`，
 *      没有 `.session` —— 每个 agent 都"抠不出 id"，只记一条 warning，表就是空的。
 *   2. **只扫一次**：`apply` 跑在启动那一刻，那时一个会话都没有，扫出来必然空，
 *      而且之后再没扫过 —— 只能靠重启。
 *
 * 对的形状（照宿主自己的类型核过）：`sessions.list()` → `Session`（有 `id`）、
 * `agents.list()` → `Agent`（只有 `id`）、`sessionTitle.get(session)` → `{ title }`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlugin, makeCtx, makeTree, today } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const TMP = join(PKG, '.tmp-registry')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const probes = await import(new URL('../src/Sessions/probes.mjs', import.meta.url).href)

const CONFIG = { rootDir: TMP, log: { enabled: true }, inject: { enabled: true } }
const REGISTRY = join(TMP, 'system/sessions.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const registry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'))
const ids = () => Object.keys(registry().sessions || {}).sort()
const teardown = async (ctx) => {
  for (const fn of ctx.effects) await fn()()
}

/**
 * 隔离「用户目录」。
 *
 * probes 会读 ~/.dsh/storages/workspace.json 来只保留"侧边栏能点到的会话"。
 * 在真机上跑测试时它会读到真实文件，把夹具里的假会话全过滤掉 —— 用例就莫名变红。
 * 指向一个空的临时目录，等于"读不到清单"，代码会走"不过滤"分支。
 */
function isolateHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsas-reg-'))
  const prev = { up: process.env.USERPROFILE, home: process.env.HOME }
  process.env.USERPROFILE = dir
  process.env.HOME = dir
  return () => {
    if (prev.up === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev.up
    if (prev.home === undefined) delete process.env.HOME
    else process.env.HOME = prev.home
  }
}

async function main() {
  const restoreHome = isolateHome()
  makeTree(TMP)

  /* ---------------------------------------------- 0. id 抠取：三种形状都认 */
  assert.equal(probes.sessionIdOf({ id: 'session-a' }), 'session-a', '宿主现行形状：Agent 只有 { id }')
  assert.equal(probes.sessionIdOf({ session: { id: 'session-b' } }), 'session-b', '老形状：agent.session.id')
  assert.equal(probes.sessionIdOf({ get id() { return 'session-c' } }), 'session-c', 'Session 的 id getter')
  assert.equal(probes.sessionIdOf({}), '', '抠不出来就返回空串')
  console.log('✓ 会话 id：{id} / .session.id / id getter 三种形状都认')

  /* ------------------------------------ 1. apply 时已经有会话：直接进表 */
  {
    const ctx = makeCtx()
    ctx.newSession('session-live', '拼插件')
    const out = await applyPlugin(mod, ctx, CONFIG)
    assert.equal(out.parts.Sessions, 'on')

    const reg = registry()
    assert.ok(reg.sessions['session-live'], '活着的会话应该进表（真机形状：agent 只有 id）')
    assert.equal(reg.sessions['session-live'].name, '拼插件', '名字应该从 sessionTitle 取到')
    assert.equal(reg.sessions['session-live'].enabled, true)
    assert.equal(reg.archivedKnown, true, '归档名单读到了就该是 true')
    console.log('✓ 启动时就有活会话：直接登记，名字也在')

    await teardown(ctx)
  }

  /* -------------------- 2. 启动时没有会话（真机）→ 之后冒出来要自己补上 */
  {
    rmSync(REGISTRY, { force: true }) // 每段从空表开始，别吃上一段的残留
    const ctx = makeCtx()
    await applyPlugin(mod, ctx, CONFIG)
    assert.deepEqual(ids(), [], '刚启动本来就没会话，空表是对的')

    const session = ctx.newSession('session-later', '后来的会话')
    ctx.emit('session/created', session)
    await sleep(200)

    assert.deepEqual(ids(), ['session-later'], 'session/created 之后应该自己补登记（不用重启）')
    const row = registry().sessions['session-later']
    assert.equal(row.name, '后来的会话')
    assert.equal(row.firstSeen, today())
    console.log('✓ 启动时没会话：后来出现的会话自动补登记（不用重启）')

    await teardown(ctx)
  }

  /* ------------------ 3. 只有事件没有 created（插件晚就绪）→ 事件那条兜底 */
  {
    rmSync(REGISTRY, { force: true })
    const ctx = makeCtx()
    await applyPlugin(mod, ctx, CONFIG)

    const session = ctx.newSession('session-orphan', '')
    ctx.emit('session/event', session, { type: 'user/message', seq: 1, data: { content: [] } })
    await sleep(200)

    assert.deepEqual(ids(), ['session-orphan'], '表里没有的会话发了第一条事件，也该补登记')
    console.log('✓ 插件比会话晚就绪：第一条事件也会补登记（自愈）')

    await teardown(ctx)
  }

  /* ------------------------------------ 4. 重复扫描：不重复、不丢首见日期 */
  {
    rmSync(REGISTRY, { force: true })
    const ctx = makeCtx()
    ctx.newSession('session-keep', '留着的')
    await applyPlugin(mod, ctx, CONFIG)
    const firstSeen = registry().sessions['session-keep'].firstSeen

    // 再冒出来一条，触发第二次扫描
    const another = ctx.newSession('session-new', '新的')
    ctx.emit('agent/created', { agent: { id: 'session-new' } })
    await sleep(200)

    assert.deepEqual(ids(), ['session-keep', 'session-new'], '新会话进表，老会话还在')
    assert.equal(registry().sessions['session-keep'].firstSeen, firstSeen, 'firstSeen 不该被重扫改掉')
    assert.equal(another.id, 'session-new')
    console.log('✓ 重扫：新会话进表，老会话不被冲掉')

    await teardown(ctx)
  }

  /* ------------------- 5. 不该进表的：子代理、空白会话、没名字的兜底 */
  {
    rmSync(REGISTRY, { force: true })
    const ctx = makeCtx()
    ctx.newSession('session-real', '', {
      events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '你好，你是谁呀' }] } }],
    })
    ctx.newSession('session-sub', '', { header: { origin: 'subagent' } })
    ctx.newSession('session-blank', '', { seq: 0 })
    ctx.newSession('session-empty', '')

    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    assert.ok(reg.sessions['session-real'], '真会话要进表')
    assert.equal(reg.sessions['session-real'].name, '你好，你是谁呀', '没标题就拿第一句人话当名字')
    assert.equal(reg.sessions['session-sub'], undefined, '子代理会话不进表（设置页那串 uuid 就是它）')
    /*
     * 2026-10-28 改了语义：**登记表不再决定"设置页列出哪些会话"**。
     * 列表现在直接来自 sessionController.list()，所以空白会话也要能登记 ——
     * 否则用户在侧边栏看得到、在这边配不了人格。
     * 子代理仍然不进（那不是用户能点的会话）。
     */
    assert.ok(reg.sessions['session-blank'], '空白会话也要登记（列表要跟侧边栏一致）')
    assert.ok(reg.sessions['session-empty'], '没名字的也要登记，名字留空即可')
    assert.equal(reg.sessions['session-empty'].name, '', '没名字就是空字符串，不写"（未命名）"')
    console.log('✓ 子代理不进表；空白/没名字的都登记（列表跟侧边栏一致）')

    await teardown(ctx)
  }

  /* ------------------- 5.05 插件自己发的 prompt 不算"名字" */
  {
    rmSync(REGISTRY, { force: true })
    const ctx = makeCtx()
    ctx.newSession('session-machine', '', {
      events: [
        {
          type: 'user/message',
          data: { source: { kind: 'tool' }, content: [{ type: 'text', text: '你是 WeChatAgent 表情池维护器，不要输出多余内容' }] },
        },
      ],
    })
    ctx.newSession('session-human', '', {
      events: [
        { type: 'user/message', data: { source: { kind: 'tool' }, content: [{ type: 'text', text: '系统开的工作会话' }] } },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] } },
      ],
    })
    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    /*
     * 语义更新：这类会话**要登记**（侧边栏里有它），但**不许拿插件 prompt 当名字**。
     * 以前靠"不登记"来避免名字被污染，现在改成"登记但名字留空"。
     */
    assert.ok(reg.sessions['session-machine'], '只有插件 prompt 的会话也要登记')
    assert.equal(reg.sessions['session-machine'].name, '', '但不许拿插件 prompt 当名字')
    assert.equal(reg.sessions['session-human'].name, '在吗', '跳过工具消息，取第一句人话')
    console.log('✓ 名字只认人说过的：插件自己的 prompt 不算（会话本身照样登记）')

    await teardown(ctx)
  }

  /* ------------------- 5.08 只登记 DSH 可见的会话（侧边栏那批） */
  {
    rmSync(REGISTRY, { force: true })
    const ctx = makeCtx()
    ctx.newSession('session-shown', '', {
      events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看得见' }] } }],
    })
    ctx.newSession('session-hidden', '', {
      hidden: true,
      events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看不见' }] } }],
    })
    // 宿主说：只有 session-shown 在侧边栏里（newSession 默认会把会话放进可见列表）

    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    assert.ok(reg.sessions['session-shown'], '可见的要进表')
    assert.equal(reg.sessions['session-hidden'], undefined, '宿主不可见的（工具会话）不进表')
    console.log('✓ 只登记 DSH 会话列表里可见的那些')

    await teardown(ctx)
  }

  /* ------------------- 5.1 久没见过又没名字的旧行，会被清掉 */
  {
    rmSync(REGISTRY, { force: true })
    const stale = {
      version: 1,
      updated: '2026-10-01T00:00:00+08:00',
      archivedKnown: true,
      sessions: {
        'session-ghost': { name: '', firstSeen: '2026-09-01', lastSeen: '2026-09-01', archived: false, enabled: true },
        'session-old-named': { name: '老对话', firstSeen: '2026-09-01', lastSeen: '2026-09-01', archived: false, enabled: true },
      },
    }
    mkdirSync(dirname(REGISTRY), { recursive: true })
    writeFileSync(REGISTRY, JSON.stringify(stale, null, 2))

    const ctx = makeCtx()
    ctx.newSession('session-today', '今天的', { events: [] })
    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    /*
     * 模块契约：**不删，标 missing**。
     *
     * 2026-10-29 恢复。中间试过"直接清掉"（想解决设置页一堆点不开的 uuid），
     * 但那是显示层的问题，不该让存储层担。
     * 现在插件层用 sessionAlive 单独判"哪些显示、哪些算幽灵"，
     * 模块只管如实记录"见过、现在没见到"。
     */
    assert.ok(reg.sessions['session-ghost'], '消失的会话不删行')
    assert.equal(reg.sessions['session-ghost'].missing, true, '要标 missing')
    assert.ok(reg.sessions['session-old-named'], '有名字的消失也算')
    assert.equal(reg.sessions['session-old-named'].missing, true)
    assert.ok(reg.sessions['session-today'], '在场的要留着')
    assert.equal(reg.sessions['session-today'].missing, undefined, '在场的不用标')
    console.log('✓ 清理：消失的标 missing，不删行（显示层自己筛）')

    await teardown(ctx)
  }

  /* --------------------------- 6. 两个服务都没有：要报错，不许静默空表 */
  {
    const live = await probes.probeLiveSessions({ logger: { info() {}, warn() {} } }, {})
    assert.deepEqual(live.list, [], '什么都没有时列表是空的')
    assert.ok(live.errors.length > 0, '两个取数路都没有时必须报错，不能静默返回空表')
    console.log('✓ 取数路全不可用：报错，不是静默空表')
  }

  rmSync(TMP, { recursive: true, force: true })
  /* 冷启动：内存里没有任何活会话，但磁盘上有 —— 必须靠 sessionController 拿到 */
  {
    makeTree(TMP)
    const ctx = makeCtx()
    // 造 5 条"磁盘上有、内存里没有"的会话
    ctx.sessionController.list = async () => [
      { sessionId: 'a1', title: '旧的 A' },
      { sessionId: 'a2' },
      { sessionId: 'a3', blank: true },
      { sessionId: 'a4', title: '旧的 D' },
      { sessionId: 'a5' },
    ]
    // sessions.list() 返回空 —— 模拟插件刚启动、一个 Agent 都没恢复
    ctx.sessions.list = () => []

    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    const got = Object.keys(reg.sessions)
    assert.equal(got.length, 5, `冷启动也该扫到 5 条，实际 ${got.length}：${got.join(',')}`)
    assert.ok(reg.sessions['a1'].name === '旧的 A', '有标题的用标题')
    assert.equal(reg.sessions['a2'].name, '', '没标题的留空，不写「未命名」')
    console.log('✓ 冷启动：内存里没有活会话时，仍能从 sessionController 扫到全部')
    await teardown(ctx)
  }

  /* 宿主 list() 返回的是 { items: [...] }，不是数组 —— 这条曾经让列表整个空 */
  {
    makeTree(TMP)
    const ctx = makeCtx()
    ctx.sessionController.list = async () => ({
      items: [
        { sessionId: 'i1', title: '包在 items 里的' },
        { sessionId: 'i2' },
        { sessionId: 'i3', origin: 'subagent' },
        { sessionId: 'i4', parentSessionId: 'i1' },
      ],
    })
    ctx.sessions.list = () => []

    await applyPlugin(mod, ctx, CONFIG)
    const reg = registry()
    const got = Object.keys(reg.sessions).sort()
    assert.deepEqual(got, ['i1', 'i2'], `items 里该扫出 i1/i2，实际 ${got.join(',')}`)
    assert.equal(reg.sessions['i1'].name, '包在 items 里的')
    console.log('✓ 宿主返回 {items:[...]} 也能扫到（子代理/子会话仍挡掉）')
    await teardown(ctx)
  }

  /* asRows 容忍多种形状 */
  {
    const { asRows } = probes
    assert.deepEqual(asRows([1, 2]), [1, 2], '数组原样')
    assert.deepEqual(asRows({ items: [1] }), [1], 'items')
    assert.deepEqual(asRows({ sessions: [2] }), [2], 'sessions')
    assert.equal(asRows(null), null, 'null → null')
    assert.equal(asRows({}), null, '不认识的形状 → null（不静默当空）')
    console.log('✓ asRows 容忍 数组/{items}/{sessions}，不认识的返回 null')
  }

  restoreHome()
  rmSync(TMP, { recursive: true, force: true }) // 最后一组测试又建了目录，收尾再清一次
  console.log('\n登记表全部通过。')
}

main().catch((err) => {
  console.error('✗ 登记表测试失败：', err)
  process.exitCode = 1
})
