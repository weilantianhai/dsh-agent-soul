#!/usr/bin/env node
/**
 * privacy.mjs —— 跨 agent 隐私边界测试
 *
 * 这一类是"完全权限也拦得住"的那层，所以规则必须写死、不能模糊。
 * 每条断言后面那句话就是规则本身。
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { agentOfRel, makeGuard, pathsOf, readOwnershipFile, relToRoot } from '../lib/guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp-privacy')
const ROOT = TMP

const table = {
  's-fish': 'xiaoyu',
  's-dog': 'goutoujunshi',
  's-none': '',
}

const guard = makeGuard({ rootDir: ROOT, readOwnership: () => table })

const decide = (sid, name, args) => guard({ name, arguments: args, agent: { id: sid } })

let pass = 0
const ok = (label) => {
  pass += 1
  console.log(`  ✓ ${label}`)
}

async function main() {
  /* 12. 判死活只看侧边栏 —— 和用户能对账的那份数据一致 */
  {
    // sessionAlive / readSidebarSessions 都在 config 里（routes 只是转手）
    const { readSidebarSessions, sessionAlive, readHostSessionSizes } = await import('../lib/config.mjs')
    assert.equal(typeof readSidebarSessions, 'function', '要导出 readSidebarSessions')
    assert.equal(typeof sessionAlive, 'function', '要导出 sessionAlive')

    // 造一个假的 HOME，放一份工作区清单
    const fakeHome = join(TMP, 'fakehome')
    const storages = join(fakeHome, '.dsh', 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: {
          workspaceIds: ['w1'],
          pinnedSessionIds: ['pinned-one'],
          archivedSessionIds: ['in-ws-archived'],
        },
        tables: {
          workspaces: {
            w1: { path: 'D:/a', title: 'A', sessionIds: ['in-ws', 'in-ws-archived'] },
          },
        },
      }),
    )

    const prev = { up: process.env.USERPROFILE, home: process.env.HOME }
    process.env.USERPROFILE = fakeHome
    process.env.HOME = fakeHome
    try {
      const sb = readSidebarSessions()
      assert.ok(sb, '要能读到')
      assert.ok(sb.has('in-ws'), '工作区里的算')
      assert.ok(sb.has('pinned-one'), '置顶的也算（哪怕不在任何工作区）')
      assert.equal(sb.has('in-ws-archived'), false, '归档的**不算** —— 侧边栏默认不显示')

      assert.equal(sessionAlive('in-ws', sb, null), true, 'sizes 拿不到时按"在"算')
      assert.equal(sessionAlive('in-ws-archived', sb, null), false)
      assert.equal(sessionAlive('nobody', sb, null), false)
      assert.equal(sessionAlive('x', null, null), null, '读不到清单时返回 null（不知道），不是 false')

      /*
       * 空壳判据：清单里有、但内容小于 4 KB 的不算。
       * 真机上 xiaoxi 名下唯一那个会话只有 0.4 KB —— 建过但没聊过。
       */
      const sizes = new Map([
        ['in-ws', 8000],
        ['tiny-shell', 400],
      ])
      assert.equal(sessionAlive('in-ws', sb, sizes), true, '大于 4KB 算真聊过')
      assert.equal(sessionAlive('tiny-shell', new Set(['tiny-shell']), sizes), false, '小于 4KB 是空壳，不算')
      assert.equal(
        sessionAlive('no-size-record', new Set(['no-size-record']), sizes),
        true,
        '宿主没有大小记录时按"在"算（宁可多露）',
      )
    } finally {
      if (prev.up === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prev.up
      if (prev.home === undefined) delete process.env.HOME
      else process.env.HOME = prev.home
    }
    ok('判死活只看侧边栏：工作区 + 置顶 − 归档，和用户能对账的完全一致')
  }

  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'agents', 'xiaoyu'), { recursive: true })
  mkdirSync(join(TMP, 'agents', 'goutoujunshi'), { recursive: true })

  /* 1. 路径归一化 */
  {
    assert.equal(relToRoot(join(ROOT, 'agents/xiaoyu/人格.md'), ROOT), 'agents/xiaoyu/人格.md', '绝对路径要归一')
    assert.equal(relToRoot('agents/xiaoyu/人格.md', ROOT), 'agents/xiaoyu/人格.md', '相对路径按根解析')
    assert.equal(relToRoot('D:/totally/elsewhere/a.js', ROOT), null, '根之外返回 null')
    assert.equal(relToRoot('..', ROOT), null, '往上跳也要判断成根外')
    ok('路径归一化：绝对/相对/根外/上跳')
  }

  /* 2. 从相对路径抠 agent */
  {
    assert.equal(agentOfRel('agents/xiaoyu/人格.md'), 'xiaoyu')
    assert.equal(agentOfRel('agents/xiaoyu'), 'xiaoyu', '目录本身也算')
    assert.equal(agentOfRel('sessions/x/logs/a.jsonl'), null, '别的地方不是 agent 目录')
    assert.equal(agentOfRel('agents/'), null, '光 agents/ 不算')
    assert.equal(agentOfRel(null), null)
    ok('agentOfRel：只认 agents/<名字>/ 这一层')
  }

  /* 3. 参数提取 */
  {
    const a = pathsOf('ops_read_files', { files: [{ path: 'x/a' }, { path: 'y/b' }] })
    assert.equal(a.length, 2, 'files 数组每一项都算')
    assert.equal(pathsOf('write', { file_path: 'z' })[0].path, 'z', 'file_path')
    assert.equal(pathsOf('working_directory', { cd: 'q' })[0].path, 'q', 'cd')
    assert.equal(pathsOf('ops_bash', { command: 'cat x' }).length, 0, 'ops_bash 故意不解析')
    ok('参数提取：files / file_path / cd；ops_bash 不解析')
  }

  /* 4. 自己的目录 */
  {
    assert.equal(decide('s-fish', 'ops_read_files', { files: [{ path: join(ROOT, 'agents/xiaoyu/人格.md') }] }).kind, 'allow', '读自己的要放行')
    assert.equal(decide('s-fish', 'write', { file_path: 'agents/xiaoyu/记忆.md' }).kind, 'allow', '写自己的要放行')
    ok('自己的目录：放行')
  }

  /* 5. 别人的目录 —— 核心 */
  {
    const d = decide('s-fish', 'ops_read_files', { files: [{ path: join(ROOT, 'agents/goutoujunshi/人格.md') }] })
    assert.equal(d.kind, 'ask', '读别人的要问')
    assert.ok(d.reason.includes('goutoujunshi'), '理由要说清是谁的目录')
    assert.ok(d.displayReason && d.displayReason.zh, '要有中文显示理由')

    assert.equal(decide('s-fish', 'edit', { file_path: 'agents/goutoujunshi/经验.md' }).kind, 'ask', '写别人的也要问')
    ok('别人的目录：有审批渠道时 ask（主人可能真让它去改）')

    /*
     * 没有审批渠道时 → deny，而且理由要说人话。
     * 真机上验过：ask 在没有渠道时会被宿主换成
     * "the user rejected tool"，我们的理由全丢，用户只会以为误拦。
     */
    const noAsk = makeGuard({ rootDir: ROOT, readOwnership: () => table, canAsk: () => false })
    const d2 = noAsk({
      name: 'ops_read_files',
      arguments: { files: [{ path: join(ROOT, 'agents/goutoujunshi/人格.md') }] },
      agent: { id: 's-fish' },
    })
    assert.equal(d2.kind, 'deny', '没渠道就 deny，不要假装能弹窗')
    assert.ok(d2.reason.includes('goutoujunshi'), '理由要说是谁的目录')
    assert.ok(d2.reason.includes('没有可用的确认弹窗'), '要解释为什么直接拒')
    assert.ok(d2.reason.includes('让主人自己来'), '要给出路，不是死路')
    ok('没审批渠道：deny + 说清原因和出路')
  }

  /* 6. 不在 agents 下 */
  {
    assert.equal(decide('s-fish', 'ops_read_files', { files: [{ path: join(ROOT, 'sessions/x/logs/a.jsonl') }] }).kind, 'allow', '日志不属于某个 agent')
    assert.equal(decide('s-fish', 'write', { file_path: 'D:/program/a.js' }).kind, 'allow', '根外不管')
    ok('不在 agents/<某人>/ 下：放行')
  }

  /* 7. 没人格的会话 */
  {
    assert.equal(decide('s-none', 'ops_read_files', { files: [{ path: join(ROOT, 'agents/xiaoyu/人格.md') }] }).kind, 'ask', '没人格 = 谁的都不许')
    ok('没绑人格的会话：任何 agent 目录都要问')
  }

  /* 8. ops_bash 放开 */
  {
    const d = decide('s-fish', 'ops_bash', { command: `cat ${join(ROOT, 'agents/goutoujunshi/人格.md')}` })
    assert.equal(d.kind, 'allow', 'ops_bash 故意不拦（防不住，也不能给人虚假安全感）')
    ok('ops_bash：不拦（靠提示词软约束）')
  }

  /* 9. 没有主体 */
  {
    assert.equal(guard({ name: 'write', arguments: { file_path: 'agents/x/y' } }).kind, 'allow', '没有 agent 就谈不上越界')
    ok('无 agent 的调用：放行')
  }

  /* 10. guard 自己炸了要放行并上报 */
  {
    const bad = makeGuard({
      rootDir: ROOT,
      readOwnership: () => {
        throw new Error('表读炸了')
      },
    })
    let notified = ''
    const bad2 = makeGuard({
      rootDir: ROOT,
      readOwnership: () => table,
      onBlock: (t) => {
        notified = t
      },
    })
    /*
     * 造一个真会炸的入参：agent 的 id 是个 getter，一读就抛。
     * guard 里第一件事就是读 exec.agent.id，所以必然进 catch。
     */
    const boom = {
      name: 'write',
      arguments: { file_path: 'agents/x/y' },
      agent: {
        get id() {
          throw new Error('读 id 就炸')
        },
      },
    }
    assert.equal(bad2(boom).kind, 'allow', 'guard 出错时放行，不能把整个工具集变砖')
    assert.ok(notified.includes('guard 出错'), '但要报出去，让人知道边界此刻没生效')
    ok('guard 自身出错：放行 + 上报（不静默）')
  }

  /* 11. agents.json 读取 */
  {
    const f = join(TMP, 'private', 'agents.json')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ 's-a': 'xiaoyu', 's-b': '' }), 'utf8')
    const t = readOwnershipFile(f)
    assert.equal(t['s-a'], 'xiaoyu')
    assert.equal(readOwnershipFile(join(TMP, 'nope.json'))['s-a'], undefined, '读不到返回空对象，不抛')
    ok('agents.json：读得到；读不到返回空对象')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n隐私边界 ${pass} 组全过。`)
}

main().catch((err) => {
  console.error('\n✗ 隐私边界测试失败：', err && err.message)
  process.exitCode = 1
})
