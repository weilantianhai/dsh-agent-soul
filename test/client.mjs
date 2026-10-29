#!/usr/bin/env node
/**
 * client.mjs —— 设置页的契约测试（不启浏览器）
 *
 * 只验三件事：
 *   1. 产物格式是 `window.__ModuleLoader__.load({ id, factory })`，id = 包名
 *   2. factory 能跑起来，导出 apply / inject
 *   3. apply 挂的是 `settings.section`，id、order、label 都在
 *
 * 真渲染要 React + 浏览器，那一步留给装完之后的真机验收。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const source = readFileSync(join(PKG, 'client.js'), 'utf8')

/** 最小的 React 替身：只要不渲染，hooks 不干活也没关系 */
const fakeReact = {
  createElement: (...args) => args,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
}

let loaded = null
const styleInjections = []
const sandbox = {
  document: {
    head: { appendChild: (el) => styleInjections.push(el) },
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      textContent: '',
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v
      },
      remove() {
        this.removed = true
      },
    }),
  },
  window: {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
      },
    },
  },
  require: (name) => {
    if (name === 'react') return fakeReact
    throw new Error(`意外 require：${name}`)
  },
  fetch: () => Promise.resolve({ json: async () => ({ ok: true }) }),
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

assert.ok(loaded, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-agent-soul', 'id 必须等于包名')
assert.equal(typeof loaded.factory, 'function')

const exported = loaded.factory(sandbox.require)
assert.equal(typeof exported.apply, 'function', '要导出 apply')
assert.deepEqual(JSON.parse(JSON.stringify(exported.inject)), ['slots'], '要声明 slots')
assert.equal(typeof exported.MemorySection, 'function', '要导出 MemorySection（方便单测）')
assert.equal(typeof exported.HeroPersona, 'function', '要导出 HeroPersona（新会话那行的人格下拉）')

/* apply 挂到哪儿 */
const calls = []
const ctx = {
  effect: (fn) => {
    calls.push(['effect', fn()])
  },
  slots: {
    inject: (name, factory) => {
      calls.push(['inject', name, factory()])
      return () => {}
    },
    register: (options, component) => {
      calls.push(['register', options, component])
      return () => {}
    },
  },
}

exported.apply(ctx)

/* 样式表契约：apply 时插入 <style>，内容带 dsas- 前缀 */
assert.ok(styleInjections.length >= 1, 'apply 应该插入样式表')
const styleEl = styleInjections[0]
assert.equal(styleEl.tagName, 'STYLE')
assert.ok(String(styleEl.textContent).includes('.dsas-wrap'), '样式表内容要真的有规则')
assert.ok(String(styleEl.textContent).includes(':hover'), '要有 hover 规则（这正是内联样式做不到的）')

/* 卸载时要能拔掉：effect 注册过拿清理函数，调它应该 remove 掉那个 <style> */
const disposers = calls.filter((c) => c[0] === 'effect' && typeof c[1] === 'function').map((c) => c[1])
for (const d of disposers) d()
assert.ok(styleEl.removed, '卸载时样式表要被移除')

const injects = calls.filter((c) => c[0] === 'inject').map((c) => c[1])
    assert.deepEqual(
      injects.slice().sort(),
      ['conversation.hero.options', 'main', 'settings.section', 'sidebar.panellist'],
      '四个槽位：侧边栏入口 + 整页主面板 + 设置页 + 新建会话那一行',
    )

    const regs = calls.filter((c) => c[0] === 'register')
    assert.equal(regs.length, 4, '应该注册四个槽位占用')

    /* 侧边栏入口：id 必须和 main 的 key 一模一样，宿主靠它配对 */
    const sideReg = regs.find((c) => c[1].name === 'sidebar.panellist')
    assert.ok(sideReg, '缺少 sidebar.panellist（侧边栏那颗图标）')
    assert.equal(sideReg[1].id, 'dsh-agent-soul')
    assert.equal(sideReg[1].label(), '记忆与人格', '侧边栏文字')
    assert.equal(typeof sideReg[2], 'function', '图标要是个组件')

    const mainReg = regs.find((c) => c[1].name === 'main')
    assert.ok(mainReg, '缺少 main（点开后占满主区的那一页）')
    assert.equal(mainReg[1].key, sideReg[1].id, 'main 的 key 必须等于侧边栏 id，否则点了打不开')
    assert.equal(typeof mainReg[2], 'function')

    /* 整页面板：只验它是个组件、且内部引用到 MemorySection（完整渲染在 ui-render 里） */
    assert.equal(typeof exported.SoulPage, 'function', '要导出 SoulPage 方便单测')
    assert.equal(typeof exported.SoulIcon, 'function', '要导出 SoulIcon')
    // 这个假 React 的 createElement 直接返回参数数组：[type, props, children]
    const iconNode = exported.SoulIcon({ size: 22, active: true })
    assert.equal(iconNode[0], 'svg', '侧边栏图标要画出 svg')
    assert.equal(iconNode[1].width, 22, '图标尺寸跟着宿主给的 size 走')

    const sectionReg = regs.find((c) => c[1].name === 'settings.section')
    assert.ok(sectionReg, '缺少 settings.section')
    assert.equal(sectionReg[1].id, 'dsh-agent-soul')
    assert.equal(typeof sectionReg[1].order, 'number')
    assert.equal(sectionReg[1].label(), '记忆')
    assert.equal(sectionReg[2], exported.MemorySection)

    const heroReg = regs.find((c) => c[1].name === 'conversation.hero.options')
    assert.ok(heroReg, '缺少 conversation.hero.options（新建会话时要能选人格）')
    assert.equal(heroReg[1].id, 'dsh-agent-soul-persona', 'id 要是自己的，别抢别人那一格')
    assert.equal(typeof heroReg[1].order, 'number')
    assert.equal(heroReg[1].label(), '人格')
    assert.equal(heroReg[2], exported.HeroPersona)

    console.log(
      '✓ 契约：__ModuleLoader__ / id / apply / 四个槽位（侧边栏 + 整页 + 设置 + 新会话）/ label',
    )
