#!/usr/bin/env node
/**
 * ui-render.mjs —— 把设置页真渲染一遍（不开浏览器）
 *
 * client.js 之前只验了"挂得上"，没验"画得出来"。这个文件用一个很小的 React 替身
 * （能跑 useState / useEffect 依赖判定 / 重渲染）把 MemorySection 渲染成元素树，
 * 再检查关键文案和控件在不在。
 *
 * 能抓到的：渲染时抛异常、读 undefined 字段、分支没覆盖到、文案没出来。
 * 抓不到的：真实布局、真实浏览器 API。那部分等真机。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const source = readFileSync(join(PKG, 'client.js'), 'utf8')

/* ------------------------------------------------------- 迷你 React 替身 */

const hooks = []
let idx = 0
let effects = []
let dirty = false
/** 每次组件渲染结束时记下 hook 数；下一次渲染必须一样多 —— 和 React 一样 */
let lastHookCount = null
const hookCountHistory = []

/**
 * React 的硬性规则：同一次挂载内，每次渲染的 hook 数量必须一致。
 * 我们的迷你 React 之前不查这个，所以「提前返回之后又调 hook」这种白屏 bug
 * 测不出来。这里补上。
 */
function assertHookOrder(where) {
  if (lastHookCount !== null && idx !== lastHookCount) {
    throw new Error(
      `hooks 顺序/数量变了：上一次 ${lastHookCount} 个，这次 ${idx} 个（${where}）—— 真机上会白屏`,
    )
  }
  lastHookCount = idx
  hookCountHistory.push(idx)
}

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(init) {
    const i = idx++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    return [
      hooks[i],
      (v) => {
        const next = typeof v === 'function' ? v(hooks[i]) : v
        if (!Object.is(next, hooks[i])) {
          hooks[i] = next
          dirty = true
        }
      },
    ]
  },
  useCallback(fn, deps) {
    const i = idx++
    const prev = hooks[i]
    if (!prev || !sameDeps(prev.deps, deps)) hooks[i] = { deps, fn }
    return hooks[i].fn
  },
  useMemo(fn, deps) {
    const i = idx++
    const prev = hooks[i]
    if (!prev || !sameDeps(prev.deps, deps)) hooks[i] = { deps, value: fn() }
    return hooks[i].value
  },
  useEffect(fn, deps) {
    const i = idx++
    const prev = hooks[i]
    if (!prev || !sameDeps(prev.deps, deps)) {
      hooks[i] = { deps }
      effects.push(fn)
    }
  },
}

/* ------------------------------------------------------------- 元素树工具 */

function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ kind: 'text', text: String(node) })
    return out
  }
  // createPortal 的替身包了一层，walk 穿透它
  if (node.__portal) {
    walk(node.__portal.node, out)
    return out
  }
  const { type, props } = node
  if (typeof type === 'function') {
    walk(type(props), out)
    return out
  }
  out.push({ kind: 'el', type, props })
  walk(props.children, out)
  return out
}

const textOf = (tree) =>
  walk(tree)
    .filter((n) => n.kind === 'text')
    .map((n) => n.text)
    .join(' ')

/* ---------------------------------------------------------------- 假数据 */

const CONFIG = {
  rootDir: 'D:/ProgramData/dsh/memory',
  log: { enabled: true, sessions: { 'bili-whale': { log: true } }, defaults: { log: false } },
  inject: { enabled: true, defaultAgent: 'xiaoyu', budget: { total: 2500, persona: 1500, diary: 800, signpost: 200 }, sections: { persona: true, diarySummary: true, signpost: true } },
  sessions: { enabled: true },
  tools: { enabled: true, find: true, open: true, diary: true, recall: false },
  daily: { enabled: true, time: '23:30', minLines: 6, sessions: {} },
}

const WS = {
  phase: 'ready',
  items: [{ workspaceId: 'w-bili', title: 'bili-whale', path: 'D:/work/bili', sessionIds: ['bili-whale'] }],
  archivedSessionIds: [],
}
const propsWithWorkspaces = {
  useWorkspaces: (sel) =>
    sel({
      items: [
        {
          workspaceId: 'w1',
          title: 'dsh',
          path: 'D:/dsh',
          // 把 /sessions 夹具里的会话都算进来，否则会被可见性过滤掉
          sessionIds: ['bili-whale', 'session-47aae246', 'session-ee560755'],
        },
      ],
      // 归档的不该出现在列表里
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }),
}

function makeFetch({ failConfig = false, calls = [], toolsOff = false } = {}) {
  const table = {
    '/dsh-agent-soul/api/config': failConfig
      ? { ok: false, error: '宿主没起来' }
      : { ok: true, config: toolsOff ? { ...CONFIG, tools: { ...CONFIG.tools, enabled: false } } : CONFIG, paths: {} },
    '/dsh-agent-soul/api/status': { ok: true, parts: { Sessions: 'on', Log: 'on', Inject: 'on' }, rootDir: CONFIG.rootDir },
    '/dsh-agent-soul/api/agents': {
      ok: true,
      agents: ['xiaoyu'],
      // 人格详情：决定"几个人格、各自几个会话"那一行
      detail: [
        { name: 'xiaoyu', sessions: { total: 1, ids: ['bili-whale'] } },
      ],
      ghosts: [],
    },
    '/dsh-agent-soul/api/persona': { ok: true, ownership: { 'bili-whale': 'xiaoyu', 'session-new': 'xiaoyu', 'orphan-x': 'xiaoyu' } },
    '/dsh-agent-soul/api/sessions': {
      ok: true,
      sessions: [
        { id: 'bili-whale', name: '小鱼', blank: false, running: false },
        { id: 'session-47aae246', name: '', blank: true, running: false },
        { id: 'session-ee560755', name: '狗头军师', blank: false, running: false },
      ],
      registry: {
        sessions: {
          'bili-whale': { name: '小鱼' },
          'sticker-x': { name: '旧会话' },
          'gone-x': { name: '早没了', missing: true },
        },
      },
    },
    '/dsh-agent-soul/api/board': { ok: true, text: '# 话板\n' },
  }
  return async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null })
    return { json: async () => table[url] || { ok: false, error: 'no route' } }
  }
}

/* ---------------------------------------------------------------- 渲染 */

function load(fetchImpl) {
  hooks.length = 0
  let loaded = null
  const sandbox = {
    require: (n) => {
      if (n === 'react') return React
      if (n === 'react-dom/client' || n === 'react-dom') {
        return { createPortal: (node, target) => ({ __portal: { node, target } }) }
      }
      throw new Error('意外 require：' + n)
    },
    fetch: fetchImpl,
    // 最小 document：portal 需要 document.body 才走 createPortal
    document: (() => {
      const injections = []
      return {
        body: { nodeType: 1, tagName: 'BODY' },
        head: { appendChild: (el) => injections.push(el) },
        createElement: (tag) => ({ tagName: tag.toUpperCase(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }),
        addEventListener() {},
        removeEventListener() {},
        __injections: injections,
      }
    })(),
    window: { __ModuleLoader__: { load: (spec) => (loaded = spec) }, innerWidth: 1024, innerHeight: 768 },
    console,
    JSON,
    Date,
    Number,
    Object,
    Array,
    Promise,
    Set,
    String,
    Boolean,
    Math,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return loaded.factory(sandbox.require)
}

/**
 * 渲染到稳定。
 *
 * 一轮渲染 → 跑 effect（里面有 await 的 fetch）→ 等它落定 → 有 setState 就再来一轮。
 * 以前固定 12 轮 × 20ms，load() 里六个 Promise 常常来不及全回来就退出了，
 * 于是断言看到的是"还没数据"的中间态。
 */
async function mount(Component, { settle = 8 } = {}) {
  let tree = null
  lastHookCount = null // 每次 mount 视作一次新的挂载
  for (let pass = 0; pass < 60; pass++) {
    dirty = false
    idx = 0
    effects = []
    tree = Component()
    assertHookOrder('渲染后')
    const todo = effects
    effects = []
    for (const fn of todo) fn()
    // 让所有 microtask / setTimeout(0) 的 fetch 落定
    for (let k = 0; k < settle; k++) await new Promise((r) => setTimeout(r, 5))
    if (!dirty) break
  }
  return tree
}

/* ---------------------------------------------------------------- 断言 */

/** 侧边栏那份数据的假快照（useSessions 的 snapshot 形状） */
function makeSessionsHook(list) {
  const byId = {}
  for (const x of list) byId[x.sessionId] = x
  return (selector) => (typeof selector === 'function' ? selector({ byId, order: list.map((x) => x.sessionId) }) : { byId })
}

const propsWithSessions = {
  useWorkspaces: (sel) => sel({ items: [{ workspaceId: 'w1', title: 'dsh', path: 'D:/dsh', sessionIds: ['s-a', 's-b'] }] }),
  useSessions: makeSessionsHook([
    { sessionId: 's-a', title: '真名字', blank: false, cwd: 'D:/dsh', updatedAt: 300 },
    { sessionId: 's-b', title: '', blank: false, cwd: 'D:/dsh', updatedAt: 200 },
    { sessionId: 's-zombie', title: '僵尸会话', blank: false, cwd: 'D:/dsh', updatedAt: 100 },
    // fork 出来的分支：有 parentId，侧边栏会缩进显示，不能筛掉
    { sessionId: 's-fork', title: '分支会话', blank: false, cwd: 'D:/dsh', updatedAt: 90, parentId: 's-a' },
  ]),
}

async function main() {
  /* 新版设置页：按 tianhai 给的规格逐条验 */
  const mod = load(makeFetch())
  const ok = await mount(() => mod.MemorySection(propsWithWorkspaces))
  const text = textOf(ok)
  const nodes = walk(ok)

  /* 1. 记忆：状态灯，不给开关 */
  assert.ok(text.includes('记忆'), '要有「记忆」这块')
  const lights = nodes.filter((n) => String((n.props && n.props.className) || '').includes('dsas-light'))
  assert.ok(lights.length >= 3, `至少三盏灯（日志/注入/写日记），实际 ${lights.length}`)
  assert.ok(
    lights.every((n) => !n.props.className.includes('dsas-sw')),
    '状态灯旁边不该有开关',
  )
  console.log('✓ 记忆：三盏状态灯，没有开关')

  /* 2. 快速创建人格 */
  assert.ok(text.includes('根据当前会话快速创建人格'), '要有快速创建入口')

  /* 3. 默认四项 */
  for (const w of ['默认日志记录', '默认日记记录', '默认写日记时间', '新会话默认人格']) {
    assert.ok(text.includes(w), `要有「${w}」`)
  }
  // 默认人格里要有「无人格」选项
  assert.ok(text.includes('无人格'), '默认人格要有无人格选项')

  /* 4. 会话管理（可折叠，按工作区） */
  assert.ok(text.includes('会话管理'), '要有会话管理')
  // 分组默认折叠，但分组头里的**工作区名**是直接可见的
  assert.ok(text.includes('dsh'), '按工作区分组要用工作区名')
  const gheads = nodes.filter((n) => String((n.props && n.props.className) || '').includes('dsas-ghead'))
  assert.ok(gheads.length >= 1, '要有可折叠的分组头')
  console.log('✓ 默认四项 + 会话管理（可折叠、按工作区）')

  /* 列表必须来自宿主，而且不筛"没说过话的" */
  {
    // 分组默认折叠 —— 先全部展开，才能看到会话行
    const m6 = load(makeFetch())
    let treeNow = await mount(() => m6.MemorySection(propsWithWorkspaces))
    const heads = () =>
      walk(treeNow).filter((n) => String((n.props && n.props.className) || '').includes('dsas-ghead'))
    for (let guard = 0; guard < 12; guard++) {
      const closed = heads().filter((n) => n.props['data-open'] === '0')
      if (closed.length === 0) break
      closed[0].props.onClick()
      treeNow = await mount(() => m6.MemorySection(propsWithWorkspaces))
    }
    const t2 = textOf(treeNow)

    assert.ok(t2.includes('小鱼'), '宿主给的名字要显示')
    assert.ok(t2.includes('狗头军师'), '宿主里别的会话也要显示')
    /*
     * session-47aae246 是 blank（新建没说话）。
     * 侧边栏只显示**当前正打开**的那一个空白会话（作为"新会话"占位），
     * 别的空白一律不显示 —— 所以这里不该有它。
     */
    assert.equal(t2.includes('session-47aae246'), false, '空白会话（非当前）不显示')
    assert.equal(t2.includes('（不在登记表里）'), false, '不该再出现「不在登记表里」')
    assert.equal(t2.includes('（未命名）'), false, '不该再出现「未命名」')
    // 登记表里有、宿主列表里没有的（sticker-x），不该出现在列表里
    assert.equal(t2.includes('旧会话'), false, '登记表里多出来的不该顶替宿主列表')
    console.log('✓ 会话列表来自宿主：没名字的也列出，不再有「未命名/不在登记表里」')
  }

  /* 5. 点开单个会话 → 它自己的设置 */
  {
    const m = load(makeFetch())
    const before = await mount(() => m.MemorySection(propsWithWorkspaces))
    // 先展开分组
    const gh = walk(before).find((n) => String((n.props && n.props.className) || '').includes('dsas-ghead'))
    assert.ok(gh, '找不到分组头')
    gh.props.onClick()
    const opened = await mount(() => m.MemorySection(propsWithWorkspaces))
    const row = walk(opened).find((n) => String((n.props && n.props.className) || '').includes('dsas-srow'))
    assert.ok(row, '展开分组后要能看到会话行')
    row.props.onClick()
    const detail = await mount(() => m.MemorySection(propsWithWorkspaces))
    const dt = textOf(detail)
    for (const w of ['日志记录', '日记记录', '几点写日记', '会话人格']) {
      assert.ok(dt.includes(w), `单会话详情要有「${w}」`)
    }
    console.log('✓ 点开单个会话：日志 / 日记 / 时间 / 人格 四项都在')
  }

  /* 6. 人格管理：字数预算 + 人格列表 + 新建 + 打开话板 */
  {
    assert.ok(text.includes('Agent 人格管理'), '要有人格管理')
    assert.ok(text.includes('字数预算'), '要有字数预算')
    for (const w of ['总上限', '人格', '日记', '路标']) {
      assert.ok(text.includes(w), `预算要有「${w}」`)
    }
    assert.ok(text.includes('新建人格'), '要有新建人格')
    assert.ok(text.includes('在资源管理器中打开共享话板'), '要有打开共享话板')
    const nums = nodes.filter((n) => n.type === 'input' && n.props && n.props.type === 'number')
    assert.equal(nums.length, 4, `预算应该是 4 个数字框，实际 ${nums.length}`)
    console.log('✓ 人格管理：预算四项 + 列表 + 新建 + 打开话板')
  }

  /* 7. Tools：折叠，总闸关掉时其余禁用 */
  {
    assert.ok(text.includes('Tools'), '要有 Tools')
    const m = load(makeFetch({ toolsOff: true }))
    const off = await mount(() => m.MemorySection(propsWithWorkspaces))
    // 展开 Tools
    const tb = walk(off).find((n) => String((n.props && n.props.className) || '').includes('dsas-block-head-btn'))
    assert.ok(tb, 'Tools 要可折叠')
    tb.props.onClick()
    const op = await mount(() => m.MemorySection(propsWithWorkspaces))
    const sws = walk(op).filter((n) => n.props && n.props.role === 'switch')
    const disabled = sws.filter((n) => n.props.disabled === true)
    assert.ok(disabled.length >= 4, `总闸关掉后四项该变灰，实际 ${disabled.length} 个禁用`)
    console.log('✓ Tools：折叠；总闸关掉时下面的开关变灰')
  }

  /* 8. 出问题了：体检 + 可复制 */
  {
    assert.ok(text.includes('出问题了'), '要有「出问题了」')
    assert.ok(text.includes('体检'), '要有体检')
    assert.ok(text.includes('开始体检'), '要有体检按钮')
    console.log('✓ 出问题了：体检按钮在')
  }

  /* 9. 保存 / 重新读取 */
  assert.ok(text.includes('保存'), '要有保存')
  assert.ok(text.includes('重新读取'), '要有重新读取')
  // 平铺样式不要了
  assert.equal(text.includes('换成平铺'), false, '平铺布局应该去掉了')

  /* 10. 异常态 */
  {
    const badMod = load(makeFetch({ failConfig: true }))
    const bad = await mount(() => badMod.MemorySection({}))
    const bt = textOf(bad)
    assert.ok(bt.includes('正在读配置'), '读不到配置时显示加载态')
    assert.ok(bt.includes('宿主没起来'), '错误原样显示')
    console.log('✓ 异常态：读不到配置不白屏')
  }

  /* 整页面板：标题栏、返回、正文都在 */
  {
    const m4 = load(makeFetch())
    const page = await mount(() => m4.SoulPage(propsWithWorkspaces))
    const t = textOf(page)
    assert.ok(t.includes('记忆与人格'), '整页要有标题')
    assert.ok(t.includes('对话'), '整页要有「回到对话」的出口')

    const nodes = walk(page)
    const back = nodes.find((n) => n.kind === 'el' && String((n.props && n.props.className) || '').includes('dsas-page-back'))
    assert.ok(back, '要有返回按钮')
    const body = nodes.find((n) => n.kind === 'el' && String((n.props && n.props.className) || '').includes('dsas-page-body'))
    assert.ok(body, '要有正文滚动区')
    // 分组默认只展开第一节，所以这里只断言正文把设置页装进去了（标题在）
    assert.ok(t.includes('① ') || t.includes('记忆'), '正文里是设置页内容')
    console.log('✓ 整页面板：标题栏 / 返回对话 / 正文滚动区')
  }

  /* 反向验证：hooks 校验真的会抓「提前返回后又调 hook」 */
  {
    let threw = null
    let first = true
    const Bad = () => {
      const [n] = React.useState(0)
      if (first) return '第一帧'
      const [m] = React.useState(0)
      return '第二帧' + n + m
    }
    // 手动跑两帧，模拟"配置从无到有"
    lastHookCount = null
    idx = 0
    hooks.length = 0
    effects = []
    Bad()
    assertHookOrder('第一帧')
    first = false
    idx = 0
    effects = []
    try {
      Bad()
      assertHookOrder('第二帧')
    } catch (e) {
      threw = String(e && e.message)
    }
    assert.ok(threw && threw.includes('hooks'), 'hooks 校验应该抓住顺序错误，实际：' + threw)
    console.log('✓ 反向验证：hooks 数量变化会被测试抓到（真机上就是白屏）')
  }

  /* useSessions（侧边栏那份）优先：名字直接有，不用读文件 */
  {
    const m7 = load(makeFetch())
    // 分组默认折叠，先把所有分组点开
    let page = await mount(() => m7.MemorySection(propsWithSessions))
    for (let guard = 0; guard < 12; guard++) {
      const closed = walk(page).filter(
        (n) => String((n.props && n.props.className) || '').includes('dsas-ghead') && n.props['data-open'] === '0',
      )
      if (closed.length === 0) break
      closed[0].props.onClick()
      page = await mount(() => m7.MemorySection(propsWithSessions))
    }
    const t = textOf(page)

    assert.ok(t.includes('真名字'), '侧边栏给了名字就该直接用')
    // 没名字的那个：用 id 尾巴，不写「未命名」
    assert.ok(t.includes('s-b'), '没名字的也要列出来')
    assert.equal(t.includes('（未命名）'), false, '不该出现「未命名」')
    assert.equal(t.includes('（不在登记表里）'), false, '不该出现「不在登记表里」')

    /*
     * s-zombie 不属于任何工作区 —— 但侧边栏会把它放进「未分组」，
     * 那是要显示的，不能筛掉。筛掉它的只有三种情况：
     * 子代理 / 子会话 / 非当前空白 / 已归档。
     */
    assert.ok(t.includes('僵尸会话'), '不在工作区的落到「未分组」，照样要显示')
    assert.ok(t.includes('分支会话'), 'fork 分支要显示（不能被 parentId 筛掉）')

    // 后端 /sessions 里那些假数据不该顶掉侧边栏的
    assert.equal(t.includes('狗头军师'), false, 'useSessions 在的时候，不该用后端那份')
    console.log('✓ useSessions 优先：名字直接用侧边栏的，不再拼文件')
  }

  console.log('\n设置页渲染通过。')
}

main().catch((err) => {
  console.error('✗ 渲染测试失败：', err)
  process.exitCode = 1
})
