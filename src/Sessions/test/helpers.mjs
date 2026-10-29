/**
 * test/helpers.mjs —— 测试小工具
 *
 * 所有用例都跑在系统 temp 里，**不碰真登记表**。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = []

/** 建一个临时目录，跑完 cleanup() 一起删 */
export function tempDir(tag = 'sessions') {
  const d = mkdtempSync(join(tmpdir(), `dsh-${tag}-`))
  dirs.push(d)
  return d
}

/** 删掉所有临时目录 */
export function cleanup() {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 删不掉就留着，temp 会自己清 */
    }
  }
}

/**
 * 临时登记表路径（目录不预先建，顺便测 mkdir -p）
 * @returns {string}
 */
export function tempRegistry(tag = 'sessions') {
  return join(tempDir(tag), 'shared', 'sessions.json')
}

/** 一个不存在的归档兜底文件路径 —— 让「路二」必定失败 */
export function noWorkspaceFile() {
  return join(tempDir('nows'), 'storages', 'workspace.json')
}

/** 写一个归档名单文件（假的 workspace.json） */
export function writeWorkspace(path, archivedSessionIds) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ global: { archivedSessionIds } }, null, 2), 'utf8')
  return path
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeRaw(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

export function fileExists(path) {
  return existsSync(path)
}

/**
 * 造一个假 ctx。
 *
 * @param {object} [o]
 * @param {{id:string}[]} [o.live]              活着的会话
 * @param {Record<string,string>} [o.titles]   会话标题（缺省取不到）
 * @param {string[]|null} [o.archivedIds]      服务上的归档名单（null 表示服务没有这个属性）
 * @param {'service'|'none'|'not-array'} [o.archivedMode]  服务怎么坏
 * @param {boolean} [o.titleThrows]            取标题时抛错
 * @param {boolean} [o.listThrows]             agents.list() 抛错
 * @param {boolean} [o.getThrows]              ctx.get 抛错
 */
export function makeCtx(o = {}) {
  const live = o.live || []
  const titles = o.titles || {}
  return {
    // 2026-10-28：真机取数改成"会话店"为主（agents 那条老路已删），假宿主跟着换
    sessions: {
      list() {
        if (o.listThrows) throw new Error('sessions.list 炸了')
        return live.map((s) => ({ id: s.id }))
      },
      get(sid) {
        if (o.sessionsThrows) throw new Error('sessions.get 炸了')
        return { id: sid }
      },
    },
    sessionTitle: {
      get(s) {
        if (o.titleThrows) throw new Error('标题服务炸了')
        const t = titles[s && s.id]
        return t === undefined ? null : { title: t }
      },
    },
    get(key) {
      if (o.getThrows) throw new Error('ctx.get 炸了')
      if (key !== 'workspaceRegistry') return undefined
      const mode = o.archivedMode || 'service'
      if (mode === 'none') return undefined
      if (mode === 'not-array') return { archivedSessionIds: 'bili-whale' }
      if (mode === 'empty-service') return {}
      return { archivedSessionIds: o.archivedIds || [] }
    },
  }
}

/** 收集 onError 的调用 */
export function errorSpy() {
  const calls = []
  const fn = (err) => calls.push(err)
  fn.calls = calls
  fn.count = () => calls.length
  fn.text = () => calls.map((e) => String((e && e.message) || e)).join('\n')
  return fn
}

/** 收集 onDiscover 的调用 */
export function discoverSpy() {
  const calls = []
  const fn = (sid, info) => calls.push({ sid, info })
  fn.calls = calls
  return fn
}
