#!/usr/bin/env node
/**
 * smoke.mjs —— 不装进 DSH 也能验拼装
 *
 * 用一个假 ctx 把 apply() 跑起来，检查：
 *   1. 三块都挂上了，钩子事件真的能收到
 *   2. 用户消息真的落进 logs/<会话>/<今天>.jsonl
 *   3. system-prompt/assemble 真的塞进了人格/日记/路标
 *   4. 设置页的接口：读配置、选人格
 *   5. 一个模块文件没了 → 只有它缺席，其余照常（验收第 8 条）
 *   6. dispose 之后钩子拆干净（验收第 6 条）
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

import { makeCtx } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const TMP = join(PKG, '.tmp-smoke')

/* ------------------------------------------------------------------ 工具 */

function memoryTree() {
  rmSync(TMP, { recursive: true, force: true })
  const dirs = ['agents/xiaoyu/diary/bili-whale', 'private', 'system', 'shared', 'sessions']
  for (const d of dirs) mkdirSync(join(TMP, d), { recursive: true })
  writeFileSync(
    join(TMP, 'agents/xiaoyu/人格.md'),
    [
      '# 小鱼',
      '',
      '## 一、你是谁',
      '你叫小鱼，住在 DSH 里。',
      '',
      '---',
      '',
      '## 三、怎么说话',
      '短句。',
      '',
      '## 十二、红线',
      '不编。',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(TMP, 'agents/xiaoyu/diary/bili-whale/2026-10-27.md'),
    ['# 2026-10-27', '', '## 总结', '今天把三个模块拼成了一个插件。', '', '## 23:00 · 拼装', '很顺。', ''].join('\n'),
  )
  writeFileSync(
    join(TMP, 'private/agents.json'),
    // bili-whale 是真的；ghost-x 是幽灵（磁盘没日志、登记表没有、宿主不认）
    JSON.stringify({ 'bili-whale': 'xiaoyu', 'ghost-x': 'xiaoyu' }, null, 2),
  )
  writeFileSync(join(TMP, 'shared/board.md'), '# 话板\n\n## 第一页\n\n**2026-10-27 · 小汐**\n好。\n')
}

const day = new Date()
const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`

function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:63104' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      res.headers[k] = v
    },
    end(text) {
      res.body = text || ''
    },
  }
  return res
}

async function call(route, method, body) {
  const req = fakeReq(method, body)
  const res = fakeRes()
  await route.handler(req, res)
  return { code: res.statusCode, data: res.body ? JSON.parse(res.body) : null }
}

/* ------------------------------------------------------------------ 跑 */

const baseConfig = {
  rootDir: TMP,
  log: { enabled: true, sessions: { 'bili-whale': { log: true } } },
  inject: { enabled: true },
}

/**
 * 把「用户目录」指向临时空目录。
 *
 * 为什么：这些用例会在真机上跑，而代码会去读
 *   ~/.dsh/storages/workspace.json  （侧边栏里有哪些会话）
 *   ~/.dsh/storages/session_projcache.json（会话标题）
 * 读到真机的，夹具里的假会话就被过滤掉了，测试会莫名变红。
 */
function isolateHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsas-home-'))
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

  /*
   * 判死活现在只看"侧边栏里有没有"。隔离后的 HOME 是空的，
   * 得给它造一份工作区清单，否则所有会话都会被判成"不在"。
   * 把夹具里的会话都放进一个工作区。
   */
  {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const storages = join(home, '.dsh', 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { workspaceIds: ['w1'], pinnedSessionIds: [], archivedSessionIds: [] },
        tables: {
          workspaces: {
            w1: {
              path: TMP,
              title: 'TMP',
              sessionIds: [
                'bili-whale',
                'session-quiet',
                'cached-cool',
                'cached-empty',
                'no-cache',
              ],
            },
          },
        },
      }),
    )
  }
  memoryTree()
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)

  /* 1. 挂上 */
  const ctx = makeCtx()
  const returned = await mod.apply(ctx, baseConfig)
  // 宿主的契约：apply 不能返回普通对象（会被当成非法 effect，插件当场被拆）
  assert.equal(returned, undefined, `apply 不能返回值，实际返回 ${typeof returned}`)
  const out = mod.status()
  assert.equal(out.parts.Sessions, 'on', 'Sessions 应该起来')
  assert.equal(out.parts.Log, 'on', 'Log 应该起来')
  assert.equal(out.parts.Inject, 'on', 'Inject 应该起来')
  assert.equal(out.parts.Tools, 'on', '工具区应该起来')
  assert.equal(out.parts.Daily, 'on', '日记任务应该起来')
  assert.ok(out.daily && out.daily.nextAt, '日记任务要报出下次叫醒时间')
  assert.ok(ctx.handlers.has('session/event'), '应该挂了 session/event')
  assert.ok(ctx.handlers.has('system-prompt/assemble'), '应该挂了 system-prompt/assemble')

  const toolNames = ctx.toolsRegistered.map((d) => d.name).sort()
  assert.deepEqual(
    toolNames,
    ['memory_diary', 'memory_find', 'memory_index', 'memory_open', 'memory_recall'],
    `四个工具没挂全：${toolNames.join(',')}`,
  )
  assert.deepEqual(out.tools.slice().sort(), toolNames, 'status() 里也要报出这几个工具')
  console.log('✓ 四块都挂上了（含四个记忆工具）')

  /* 1.05 隐私边界必须挂上 —— 这一层挂了等于没有，所以要钉死 */
  {
    assert.equal(out.parts.Privacy, 'on', '隐私边界要挂上（Privacy=on）')
    // 钩子真的注册进 ctx.on 了吗（夹具的 handlers.get 给的是调度函数）
    assert.ok(ctx.handlers.has('tools/pre-execute'), 'tools/pre-execute 上要有监听器')
    const dispatch = ctx.handlers.get('tools/pre-execute')

    // 而且它真的会拦：伪造一次跨 agent 读取
    const own = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
    const sids = Object.keys(own)
    assert.ok(sids.length > 0, '夹具里该有归属')
    const decision = await dispatch(
      {
        name: 'ops_read_files',
        arguments: { files: [{ path: join(TMP, 'agents', 'goutoujunshi', '人格.md') }] },
        agent: { id: 'bili-whale' },
      },
      async () => ({ kind: 'allow' }),
    )
    /*
     * 假 ctx 没有 approval 服务 → canAsk() 为 false → deny。
     * 这是对的行为：没有弹窗渠道时不许假装能弹，得把理由直接说出来。
     * （真机上有 approval 服务时是 ask，见 test/privacy.mjs）
     */
    assert.equal(decision.kind, 'deny', '没有审批渠道时直接 deny，不假装能弹窗')
    assert.ok(decision.reason.includes('goutoujunshi'), '理由要说是谁的目录')
    console.log('✓ 隐私边界挂上，而且真的会拦（跨 agent → 拒绝并说清原因）')
  }

  /* 1.06 memory_index：读自己的 INDEX.md；没有就告诉他怎么建 */
  {
    const idx = ctx.toolsRegistered.find((d) => d.name === 'memory_index')
    assert.ok(idx, 'memory_index 要注册')
    assert.ok(idx.description.includes('什么时候用'), 'description 要有「什么时候用」')
    assert.ok(idx.description.includes('认知版图'), '要有那句"这是你自己画的"')
    assert.deepEqual(idx.parameters.properties, {}, '它不收参数')

    const exec = { agent: { id: 'bili-whale' } }

    // ① 没有 INDEX.md 时给建议，不是只说"没有"
    const miss = await idx.execute({}, exec)
    assert.equal(miss.ok, false, '没有文件时 ok=false')
    assert.ok(miss.text.includes('INDEX.md'), '要点名缺的是哪个文件')
    assert.ok(miss.text.includes('人格.md') || miss.text.includes('people'), '要告诉它该写什么')

    // ② 有就原样返回
    const agentDir = join(TMP, 'agents', 'xiaoyu')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'INDEX.md'), '# 我的地图\n\n- 人格.md 我是谁\n', 'utf8')
    const hit = await idx.execute({}, exec)
    assert.equal(hit.ok, true)
    assert.ok(hit.text.includes('我的地图'), '要读到内容')
    assert.ok(hit.chars > 0, '要报字数')
    console.log('✓ memory_index：读 INDEX.md；没有就给建法建议')
  }

  /* 1.1 日志配置里"谁说的话"要按归属表记 */
  const logCfg = JSON.parse(readFileSync(join(TMP, 'system/log.config.json'), 'utf8'))
  assert.equal(logCfg.sessions['bili-whale'].selfName, 'xiaoyu', '日志里助手应该记成 xiaoyu，不是 assistant')
  // 「默认记」现在只对有人格的会话生效：没名字的会话靠 defaults(log:false) 挡掉
  assert.equal(logCfg.sessions['bili-whale'].log, true, '有人格的会话默认要记')
  assert.equal(logCfg.defaults.log, false, '没人格的会话不许靠 defaults 漏记')
  console.log('✓ 日志配置：role 用 agent 名、只记有人格的会话')

  /* 2. 日志真的落盘 */
  const onEvent = ctx.handlers.get('session/event')
  onEvent(
    { id: 'bili-whale' },
    {
      type: 'user/message',
      seq: 100,
      t: new Date().toISOString(),
      data: { content: [{ type: 'text', text: '小小鱼，拼装到哪了' }] },
    },
  )
  await new Promise((r) => setTimeout(r, 120))
  const logFile = join(TMP, 'sessions/bili-whale/logs', `${stamp}.jsonl`)
  assert.ok(existsSync(logFile), `日志文件应该存在：${logFile}`)
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop())
  assert.equal(line.text, '小小鱼，拼装到哪了')
  assert.equal(line.role, 'tianhai', '主人说的话记成 tianhai')

  // 助手那侧：按归属表记成 agent 名，不是 assistant（图纸 §3.7）
  onEvent(
    { id: 'bili-whale' },
    {
      type: 'assistant/message',
      seq: 101,
      t: new Date().toISOString(),
      data: { message: { content: [{ type: 'text', text: '在拼插件呢' }] } },
    },
  )
  await new Promise((r) => setTimeout(r, 120))
  const rows = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const said = rows.find((r) => r.text === '在拼插件呢')
  assert.ok(said, '助手的话也要进日志')
  assert.equal(said.role, 'xiaoyu', '助手那侧要记成 xiaoyu，不是 assistant')
  console.log('✓ 对话落进日志：原文没改，role 是 tianhai / xiaoyu')

  /* 3. 注入真的塞进去 */
  const onAssemble = ctx.handlers.get('system-prompt/assemble')
  const assembled = await onAssemble(null, { agent: { session: { id: 'bili-whale' } } }, async () => ({ sections: [] }))
  const injected = assembled.sections.find((s) => s.name === 'memory:inject')
  assert.ok(injected, '应该有 memory:inject 段')
  assert.match(injected.text, /小鱼/, '人格摘要应该在')
  assert.match(injected.text, /把三个模块拼成了一个插件/, '日记总结应该在')
  assert.match(injected.text, /你有一个记忆插件/, 'B 层说明书应该在')
  assert.match(injected.text, /四条铁律/, '铁律是边界，不许省')
  assert.match(injected.text, /memory_find/, '说明书要如实说她手上有哪几个工具')
  assert.match(injected.text, /碎碎念/, '设计师碎碎念要在说明书最后')
  assert.ok(
    injected.text.indexOf('碎碎念') > injected.text.indexOf('四条铁律'),
    '碎碎念必须在四条铁律之后',
  )
  assert.ok(injected.text.includes('别凭印象编。') && injected.text.includes('这条比"表现得完整"重要得多。'), '最后那句不许被砍')
  console.log(`✓ 注入 ${injected.text.length} 字：说明书 + 人格 + 日记 + 路标`)

  /* 4. 设置页接口 */
  const routeOf = (p) => ctx.routes.find((r) => r.path === `/dsh-agent-soul/api${p}`)

  /* 换数据目录：改完 paths 要跟着变，不能还往老目录写 */
  {
    const norm = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '')
    const other = join(TMP, 'other-root')

    const r = await call(routeOf('/config/root'), 'POST', { rootDir: other })
    assert.equal(r.code, 200, '换目录应该成功')
    assert.equal(r.data.ok, true)
    assert.equal(r.data.changed, true, '目录真变了')

    /*
     * 最关键的一条：paths 必须跟着换。
     * 如果只换 config 不换 paths，插件会继续往老目录写人格/日记/日志，
     * 界面上却显示新目录 —— 数据"凭空消失"，其实全写回了原地。
     */
    assert.equal(norm(mod.status().rootDir), norm(other), '运行时 rootDir 要跟着变')
    /*
     * 不断言 agents/ 真的建出来了 —— 那取决于新目录是空的还是已有数据。
     * 该验证的是 paths 真的换了（上面那条），以及接口说清楚了。
     */
    assert.equal(r.data.previous, TMP.replace(/\\/g, '/'), '要告诉调用方原来是哪')

    // 换回来
    const back = await call(routeOf('/config/root'), 'POST', { rootDir: TMP })
    assert.equal(back.data.ok, true)
    assert.equal(norm(mod.status().rootDir), norm(TMP), '能换回来')

    // 相对路径要拒
    const bad = await call(routeOf('/config/root'), 'POST', { rootDir: 'relative/path' })
    assert.equal(bad.code, 400, '相对路径要拒')

    // 换成同一个目录：不算 changed
    const same = await call(routeOf('/config/root'), 'POST', { rootDir: TMP })
    assert.equal(same.data.changed, false, '同一个目录不该算"变了"')

    console.log('✓ 数据目录：换完之后 paths 跟着变，不会写回老目录')
  }
  const cfgRes = await call(routeOf('/config'), 'GET')
  assert.equal(cfgRes.code, 200)
  assert.equal(cfgRes.data.config.rootDir, TMP.replace(/\\/g, '/'))

  const badge = await call(routeOf('/agents'), 'GET')
  assert.deepEqual(badge.data.agents, ['xiaoyu'])

  /* /agents 要给出每个人格名下有会话几个（设置页要显示） */
  {
    assert.ok(Array.isArray(badge.data.detail), 'detail 要给出来')
    const xiaoyu = badge.data.detail.find((x) => x.name === 'xiaoyu')
    assert.ok(xiaoyu, 'detail 里要有 xiaoyu')
    /*
     * total 现在只算"真的还在"的会话（磁盘有 logs / 登记表在 / 宿主认得）。
     * 幽灵另走 ghosts 字段，不再混进 total ——
     * 不然界面上显示"5 个会话"，其实只有 1 个是真的。
     */
    assert.ok(xiaoyu.sessions && typeof xiaoyu.sessions.total === 'number', '要有 total')
    assert.ok(Array.isArray(xiaoyu.sessions.ids), '要有具体会话 id')

    // 夹具里 bili-whale 归 xiaoyu，且它有日志目录
    assert.ok(xiaoyu.sessions.total >= 1, 'bili-whale 该算进 xiaoyu')
    assert.ok(xiaoyu.sessions.ids.includes('bili-whale'), 'id 列表里要有 bili-whale')

    // 幽灵单独给，不混进 total
    assert.ok(Array.isArray(badge.data.ghosts), 'ghosts 要给出来')
    assert.ok(
      !xiaoyu.sessions.ids.some((id) => (badge.data.ghosts || []).some((g) => g.sessionId === id)),
      '幽灵不该出现在 total 的 ids 里',
    )

    // 显式"不要人格"（空串）不算任何人的
    await call(routeOf('/persona'), 'POST', { sessionId: 'session-none', agentId: '' })
    const after = await call(routeOf('/agents'), 'GET')
    const xy2 = after.data.detail.find((x) => x.name === 'xiaoyu')
    assert.equal(xy2.sessions.total, xiaoyu.sessions.total, '空串不该算进任何人格')
    console.log('✓ /agents：给出每个人格的会话数（只算真的在的，幽灵单列）')

    /* 清理幽灵：只删归属表那一条，别的不动 */
    const before = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
    const ghostIds = (badge.data.ghosts || []).map((g) => g.sessionId)
    if (ghostIds.length > 0) {
      const pr = await call(routeOf('/agents/prune-ghosts'), 'POST', {})
      assert.equal(pr.data.ok, true, '清理要成功')
      const after = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
      for (const id of ghostIds) {
        assert.equal(id in after, false, `${id} 该被清掉`)
      }
      // 真会话不能动
      assert.equal(after['bili-whale'], before['bili-whale'], '真会话的归属不许动')
      console.log(`✓ 清理幽灵：${ghostIds.length} 条，只删归属记录`)
    }
  }

  const persona = await call(routeOf('/persona'), 'POST', { sessionId: 'temp-session', agentId: 'xiaoyu' })
  assert.equal(persona.code, 200)
  const table = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
  assert.equal(table['temp-session'], 'xiaoyu')

  /* 三种意图要分得开：选人 / 显式不要 / 清除设置 */
  await call(routeOf('/persona'), 'POST', { sessionId: 'temp-session', agentId: '' })
  const t2 = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
  assert.equal(t2['temp-session'], '', '空串 = 显式不要（要留下来，不能删）')

  await call(routeOf('/persona'), 'POST', { sessionId: 'temp-session', agentId: null })
  const t3 = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
  assert.equal('temp-session' in t3, false, 'null = 清除设置，回到「没选过」')

  console.log('✓ 设置页接口：读配置 / 列人格 / 选人格都通（选人 / 不要 / 清除三态分明）')

  /* 4.4 保存「几点叫 / 工具开关」不能丢（2026-10-28 真机 bug：改了又变回去） */
  {
    const savedCfg = await call(routeOf('/config'), 'POST', {
      config: { daily: { time: '22:15', minLines: 3 }, tools: { recall: false } },
    })
    assert.equal(savedCfg.code, 200, '保存要成功')

    const onDisk = JSON.parse(readFileSync(join(TMP, 'system/settings.json'), 'utf8'))
    assert.equal(onDisk.daily.time, '22:15', 'settings.json 里要真的有 22:15')
    assert.equal(onDisk.daily.minLines, 3)
    assert.equal(onDisk.tools.recall, false, '工具开关也要存下来')
    assert.equal(onDisk.rootDir, undefined, 'rootDir 仍然不落盘')
    assert.equal(onDisk.rootIsDefault, undefined, '默认标记也不落盘')

    const after = await call(routeOf('/config'), 'GET')
    assert.equal(after.data.config.daily.time, '22:15', '读回来还是 22:15，不能被冲回默认')
    assert.equal(after.data.config.tools.recall, false)

    // 热挂之后定时器也要跟着换（Daily 是 mount 时读配置的）
    const next = mod.status().daily && mod.status().daily.nextAt
    assert.ok(next, 'Daily 应该报出下次叫醒时间')
    const d = new Date(next)
    assert.equal(d.getHours(), 22, `下次叫醒应该是 22 点，实际 ${d.getHours()}`)
    assert.equal(d.getMinutes(), 15)

    // 还原，别影响后面的用例
    await call(routeOf('/config'), 'POST', { config: { daily: { time: '23:30', minLines: 6 }, tools: { recall: true } } })
    console.log('✓ 保存不丢字段：几点叫 / 工具开关都存下来、读回来、定时器跟着换')
  }

  const board = await call(routeOf('/board'), 'GET')
  assert.match(board.data.text, /话板/)
  console.log('✓ 话板只读预览可读')

  /* 4.5 人格：新建 / 读 / 写（先备份） */
  const created = await call(routeOf('/agents/new'), 'POST', { id: 'xiaoxi' })
  assert.equal(created.code, 200, '新建人格应该成功')
  const xiFile = join(TMP, 'agents/xiaoxi/人格.md')
  assert.ok(existsSync(xiFile), '要真的建出人格文件')
  assert.match(readFileSync(xiFile, 'utf8'), /十二、红线/, '给的是骨架，不是空白页')
  assert.ok(existsSync(join(TMP, 'agents/xiaoxi/people')), 'people/ 也要建')

  /* 归档人格：不删文件、能还原、两次确认防手滑 */
  {
    // ① confirm 和 agent 不一致 → 拒绝（防手滑）
    const bad = await call(routeOf('/agents/archive'), 'POST', { agent: 'xiaoxi', confirm: 'xiaoyu' })
    assert.equal(bad.code, 400, '确认名不一致要拒绝')
    assert.ok(existsSync(join(TMP, 'agents/xiaoxi/人格.md')), '拒绝了就不许动文件')

    // ② 正常归档
    const okRes = await call(routeOf('/agents/archive'), 'POST', { agent: 'xiaoxi', confirm: 'xiaoxi' })
    assert.equal(okRes.code, 200, '归档要成功')
    assert.equal(existsSync(join(TMP, 'agents/xiaoxi')), false, '原目录不该在了')

    // 文件没丢，只是改名
    const dirs = readdirSync(join(TMP, 'agents'))
    const archDir = dirs.find((n) => n.startsWith('xiaoxi.archived-'))
    assert.ok(archDir, `要有一个 xiaoxi.archived-* 目录，实际：${dirs.join(',')}`)
    assert.ok(existsSync(join(TMP, 'agents', archDir, '人格.md')), '人格文件还在归档目录里')
    assert.ok(existsSync(join(TMP, 'agents', archDir, 'people')), 'people/ 也还在')

    // ③ 列表里能看出来
    const after = await call(routeOf('/agents'), 'GET')
    assert.ok(!after.data.agents.includes('xiaoxi'), '归档后不在活列表里')
    assert.ok(
      (after.data.archived || []).some((x) => x.name === 'xiaoxi'),
      'archived 里要能查到它（否则界面上没法取消归档）',
    )

    // ④ 取消归档
    const back = await call(routeOf('/agents/unarchive'), 'POST', { agent: 'xiaoxi' })
    assert.equal(back.code, 200, '取消归档要成功')
    assert.ok(existsSync(join(TMP, 'agents/xiaoxi/人格.md')), '人格文件要回来')
    assert.equal(readFileSync(join(TMP, 'agents/xiaoxi/人格.md'), 'utf8').includes('红线'), true, '内容一字不差')

    console.log('✓ 归档人格：不删文件、能取消归档、确认名不一致就拒绝')
  }

  const fileRoute = routeOf('/agents/file')
  const gReq = fakeReq('GET')
  gReq.url = '/dsh-agent-soul/api/agents/file?agent=xiaoxi'
  const gRes = fakeRes()
  await fileRoute.handler(gReq, gRes)
  const got = JSON.parse(gRes.body)
  assert.equal(got.ok, true)
  assert.match(got.text, /红线/)
  assert.equal(typeof got.mtime, 'number')

  const saved = await call(fileRoute, 'POST', { agent: 'xiaoxi', text: '# 小汐\n\n改过了。\n', baseMtime: got.mtime })
  assert.equal(saved.data.ok, true, '保存应该成功')
  assert.match(readFileSync(xiFile, 'utf8'), /改过了/, '内容要落盘')
  assert.ok(saved.data.backupPath, '保存前必须备份')

  const conflict = await call(fileRoute, 'POST', { agent: 'xiaoxi', text: '偷袭', baseMtime: 1 })
  assert.equal(conflict.code, 409, '编辑期间被人改过就要拦（别覆盖人家的）')

  /* 4.6 清掉"不在了的"登记行：只动登记表，不动日志 */
  {
    const regFile = join(TMP, 'system/sessions.json')
    const reg = JSON.parse(readFileSync(regFile, 'utf8'))
    reg.sessions = {
      ...reg.sessions,
      'gone-1': { name: '早没了', firstSeen: '2026-01-01', lastSeen: '2026-01-01', archived: false, enabled: true, missing: true },
      'gone-2': { name: '', firstSeen: '2026-01-01', lastSeen: '2026-01-01', archived: false, enabled: true, missing: true },
      'keep-1': { name: '还在的', firstSeen: '2026-01-01', lastSeen: '2026-10-28', archived: false, enabled: true },
    }
    writeFileSync(regFile, JSON.stringify(reg, null, 2))

    const pruned = await call(routeOf('/registry/prune'), 'POST', {})
    assert.equal(pruned.data.ok, true)
    assert.ok(pruned.data.removed >= 2, `应该删掉至少两行，实际 ${pruned.data.removed}`)

    const after = JSON.parse(readFileSync(regFile, 'utf8'))
    assert.equal(after.sessions['gone-1'], undefined, 'missing 的行要删掉')
    assert.equal(after.sessions['gone-2'], undefined)
    assert.ok(after.sessions['keep-1'], '还在的会话不许动')
    console.log('✓ 清理不在了的登记行：只删 missing，日志和日记不动')
  }

  const bad = await call(fileRoute, 'POST', { agent: '../etc', text: 'x' })
  assert.equal(bad.code, 400, '带路径的 agent 名要拒')
  console.log('✓ 人格：新建给骨架、读全文、存前备份、冲突不覆盖')


  /* 4.7 一键建人格：建骨架 + 绑会话 + 投指令 */
  {
    ctx.prompts.length = 0

    const boot = await call(routeOf('/agents/bootstrap'), 'POST', {
      id: 'boot-test',
      name: 'boot-test',
      sessionId: 'bili-whale',
    })
    assert.equal(boot.data.ok, true, '一键建人格应该成功')
    assert.equal(boot.data.existed, false)
    assert.equal(boot.data.pushed, true, '应该给它投了指令')

    // 骨架真的建出来了
    const dir = join(TMP, 'agents/boot-test')
    assert.ok(existsSync(join(dir, '人格.md')), '人格.md 要建')
    assert.ok(existsSync(join(dir, 'MEMORY.md')), 'MEMORY.md 要建')
    assert.ok(existsSync(join(dir, '经验.md')), '经验.md 要建')
    assert.ok(existsSync(join(dir, 'people')), 'people/ 要建')
    assert.ok(existsSync(join(dir, 'diary')), 'diary/ 要建')

    // 会话绑到新人格
    const tbl = JSON.parse(readFileSync(join(TMP, 'private/agents.json'), 'utf8'))
    assert.equal(tbl['bili-whale'], 'boot-test', '会话要绑到新建的人格')

    // 投的指令内容对
    assert.equal(ctx.prompts.length, 1, '应该只投一条')
    const prompt = ctx.prompts[0]
    assert.equal(prompt.sessionId, 'bili-whale')
    const text = prompt.content[0].text
    assert.ok(text.includes('【建立人格】'), '指令要有标题')
    assert.ok(text.includes('agents/boot-test/'), '要告诉它写哪')
    assert.ok(text.includes('人格.md') && text.includes('MEMORY.md'), '要点名要写的文件')
    assert.ok(text.includes('只写这次对话里真实发生过的'), '要有不许编的规矩')
    assert.ok(text.includes('日记先不写'), '要明确日记不写')
    // 第二个参数是 AbortSignal —— 真机栈钉死的（Proxy.prompt 第一行 signal.throwIfAborted()）
    assert.equal(typeof prompt.__source?.throwIfAborted, 'function', '第二个参数必须是 AbortSignal')

    // 再来一次：不该覆盖已存在的人格
    const again = await call(routeOf('/agents/bootstrap'), 'POST', {
      id: 'boot-test',
      sessionId: 'bili-whale',
    })
    assert.equal(again.data.existed, true, '第二次应该认出已存在')
    console.log('✓ 一键建人格：建骨架 / 绑会话 / 投指令（不覆盖已有的）')

    // 缺 sessionId 要拒
    const noSid = await call(routeOf('/agents/bootstrap'), 'POST', { id: 'x2' })
    assert.equal(noSid.code, 400, '缺 sessionId 要 400')
  }

  /* 4.8 打开目录：只认自己的目录，别的不许 */
  {
    const openBad = await call(routeOf('/agents/open'), 'POST', { agent: '../etc' })
    assert.equal(openBad.code, 400, '带路径的 agent 名要拒')
    const openNone = await call(routeOf('/agents/open'), 'POST', { agent: 'no-such-agent' })
    assert.equal(openNone.code, 404, '不存在的目录要 404')
    console.log('✓ 打开目录：越界与不存在都挡住（没真去开资源管理器）')
  }

  /* 4.9 会话 id 的取法：真实的 assemble context 形状 */
  {
    const inj = await import(new URL('../src/Inject/index.mjs', import.meta.url).href)
    // 宿主契约：{ agent, scope: agent }，id 在 agent.session.id（getter）
    const agent = { session: { get id() { return 'sess-1' } } }
    assert.equal(inj.sessionIdOf({ agent, scope: agent }), 'sess-1', '正常形状要取到')
    assert.equal(inj.sessionIdOf({ agent }), 'sess-1', '只有 agent 也要取到')
    assert.equal(inj.sessionIdOf({}), null, '空 context 返回 null，不抛')
    assert.equal(inj.sessionIdOf(undefined), null, 'undefined 不抛')
    // getter 抛错也不能把整条链带崩
    const badSession = {}
    Object.defineProperty(badSession, 'id', {
      get() {
        throw new Error('boom')
      },
    })
    const bad = { session: badSession }
    assert.equal(inj.sessionIdOf({ agent: bad }), null, 'getter 抛错时返回 null，不连带崩')
    // 失败时错误信息要带形状
    const shape = inj.describeContext({ agent, scope: agent })
    assert.ok(shape.includes('context.agent.session.id'), '形状描述要含关键路径')
    console.log('✓ 会话 id：正常/getter 抛错/空 context 都不崩，失败时带形状')
  }

  /* 4.10 会话列表：以宿主为准，不再拿登记表当列表 */
  {
    // 假宿主给两条：一条有名字、一条没名字（没说过话的）
    // 真实宿主的 list() 返回 { items: [...] }，不是裸数组
    ctx.sessionController.list = async () => ({
      items: [
        { sessionId: 'bili-whale', blank: false, running: false, updatedAt: 1 },
        { sessionId: 'session-quiet', blank: true, running: false, updatedAt: 2 },
      ],
    })
    const list = await call(routeOf('/sessions'), 'GET')
    assert.equal(list.data.ok, true, '/sessions 要成功')
    assert.equal(list.data.sessions.length, 2, '宿主给几条就返回几条')
    const ids = list.data.sessions.map((x) => x.id)
    /*
     * 两条都在，因为夹具的 workspace.json 里把这两条都放进了工作区。
     * 不在工作区也不置顶的会被过滤（和侧边栏一致）——
     * 那是另一条测试管的事。
     */
    assert.deepEqual(ids.sort(), ['bili-whale', 'session-quiet'], '工作区里的两条都该返回')
    // 登记表只作为附加信息，不参与"有哪些"
    assert.ok(list.data.registry, '登记表原样带回来当补充')
    console.log('✓ 会话列表：以宿主 sessionController.list() 为准（没说过话的也列）')
  }

  /* 4.11 标题：宿主不返回，要读 DSH 自己的标题缓存 */
  {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    // 造一份最小的 projcache（真机上是 ~/.dsh/storages/session_projcache.json）
    const cacheDir = join(homedir(), '.dsh', 'storages')
    const cacheFile = join(cacheDir, 'session_projcache.json')
    let backup = null
    try {
      backup = readFileSync(cacheFile, 'utf8')
    } catch {
      backup = null
    }
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      cacheFile,
      JSON.stringify({
        unit: { name: 'session_projcache', version: 3 },
        global: null,
        tables: {
          sessions: {
            'cached-cool': { identity: {}, rows: { title: { ver: 1, seq: 1, val: '缓存里的标题' } } },
            'cached-empty': { identity: {}, rows: { title: { ver: 1, seq: 1, val: '' } } },
          },
        },
      }),
    )

    ctx.sessionController.list = async () => ({
      items: [
        { sessionId: 'cached-cool', blank: false },
        { sessionId: 'cached-empty', blank: true },
        { sessionId: 'no-cache', blank: false },
      ],
    })
    const r = await call(routeOf('/sessions'), 'GET')
    const byId = Object.fromEntries(r.data.sessions.map((x) => [x.id, x]))
    assert.equal(byId['cached-cool'].name, '缓存里的标题', '冷会话的名字要从缓存读出来')
    assert.equal(byId['cached-empty'].name, '', '缓存里是空的就留空')
    assert.equal(byId['no-cache'].name, '', '没名字就空着，不编')
    console.log('✓ 标题：冷会话从 DSH 的 projcache 读名字（跟侧边栏一致）')

    // 还原
    if (backup === null) {
      try {
        const { rmSync } = await import('node:fs')
        rmSync(cacheFile, { force: true })
      } catch {
        /* 忽略 */
      }
    } else {
      writeFileSync(cacheFile, backup)
    }
  }

  /* 4.12 只显示侧边栏能点到的（工作区里的）会话 */
  {
    const { mkdirSync: mk } = await import('node:fs')
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const storages = join(home, '.dsh', 'storages')
    mk(storages, { recursive: true })
    writeFileSync(
      join(storages, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true },
        tables: {
          workspaces: {
            w1: { path: 'D:/a', title: 'A', sessionIds: ['in-ws-1', 'in-ws-2'] },
            w2: { path: 'D:/b', title: 'B', sessionIds: ['in-ws-1'] },
          },
        },
      }),
    )

    ctx.sessionController.list = async () => ({
      items: [
        { sessionId: 'in-ws-1', blank: false },
        { sessionId: 'in-ws-2', blank: false },
        { sessionId: 'orphan-1', blank: false },
        { sessionId: 'orphan-2', blank: true },
      ],
    })
    const r = await call(routeOf('/sessions'), 'GET')
    const ids = r.data.sessions.map((x) => x.id).sort()
    assert.deepEqual(ids, ['in-ws-1', 'in-ws-2'], `只该剩工作区里的两条，实际 ${ids.join(',')}`)
    console.log('✓ 只列侧边栏能点到的会话（工作区之外的不会冒出来）')
  }

  /* 5. 拆干净 */
  for (const fn of ctx.effects) await fn()()
  assert.equal(ctx.handlers.size, 0, 'dispose 之后钩子应该一个不剩')
  assert.equal(ctx.toolsRegistered.length, 0, 'dispose 之后工具也要摘干净')
  assert.equal(ctx.routes.length, 0, 'dispose 之后路由应该一个不剩')
  console.log('✓ dispose 之后钩子、路由全拆掉')

  /* 6. 一个模块坏了，其余照常（验收第 8 条） */
  // ESM 有模块缓存，改名源目录骗不过已加载的 import；
  // 所以复制一份 lib 到隔离目录，把 Log 拿掉，再从那份加载 —— 跟"真装了个坏包"一样。
  const iso = join(PKG, '.tmp-iso')
  rmSync(iso, { recursive: true, force: true })
  /*
   * 造一个"Log 缺席"的隔离副本。
   * 2026-10-29：加载源从 lib/vendor 改成 src，所以这里也要跟着复制 src。
   * 只复制 lib 的话所有模块都会找不到 —— 那不是"只有 Log 缺席"，
   * 而是全都缺席，测的就不是这件事了。
   */
  cpSync(join(PKG, 'lib'), join(iso, 'lib'), { recursive: true })
  cpSync(join(PKG, 'src'), join(iso, 'src'), { recursive: true })
  rmSync(join(iso, 'src/Log'), { recursive: true, force: true })
  const broken = await import(pathToFileURL(join(iso, 'lib/index.js')).href)

  const ctx2 = makeCtx()
  const returned2 = await broken.apply(ctx2, baseConfig)
  assert.equal(returned2, undefined, 'apply 不能返回值')
  const out2 = broken.status()
  assert.equal(out2.parts.Log, 'missing', 'Log 缺席应该被识别')
  assert.equal(out2.parts.Inject, 'on', 'Inject 不该被带崩')
  assert.ok(ctx2.handlers.has('system-prompt/assemble'))
  console.log('✓ Log 缺席：只有它不启用，注入照常（验收第 8 条）')

  /* 7. 配置写错也不崩（验收第 7 条） */
  const ctx3 = makeCtx()
  const returned3 = await broken.apply(ctx3, {
    rootDir: 'D:/definitely/not/here',
    log: 'oops',
    inject: { budget: 5 },
  })
  assert.equal(returned3, undefined, 'apply 不能返回值')
  const out3 = broken.status()
  assert.ok(out3.errors.length >= 1, '写错应该报错')
  assert.equal(out3.parts.Inject, 'on', '写错配置不该拦住启动')
  console.log('✓ 配置写错：报错但不崩，注入照常（验收第 7 条）')
  for (const fn of ctx3.effects) await fn()()

  rmSync(iso, { recursive: true, force: true })
  for (const fn of ctx2.effects) await fn()()

  rmSync(TMP, { recursive: true, force: true })
  restoreHome()
  console.log('\n全部通过。')
}

main().catch((err) => {
  console.error('✗ 冒烟失败：', err)
  process.exitCode = 1
})
