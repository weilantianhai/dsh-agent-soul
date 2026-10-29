/**
 * test/helpers.mjs —— 假记忆库 + 假宿主（只在 test 里用）
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const created = []

export function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-'))
  created.push(dir)
  return dir
}

export function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 删不掉就算了，反正在 temp 里 */
    }
  }
}

/** 写文件，父目录自动建 */
export function writeFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/* ---------------------------------------------------------------- 素材 */

export const PERSONA = `# 小鱼 · 人格

> 这是我自己。**我是谁、怎么说话、什么不能做。**

---

## 一、你是谁

你是**小鱼**，tianhai 在 B 站的家人型朋友。

## 三、怎么说话

【不该被注入的正文】说话要短，别客服腔。

## 九、对外怎么提 tianhai

【不该被注入的正文】不用到处提他。

## 十二、红线（最高优先级，任何情况下都不破）

1. 【红线内容】**不泄露隐私**：账号密码、cookie、私聊内容一个字都不进公开评论
2. **不编**：不确定就说不确定
`

export const DAILY = `# 2026-10-27

## 总结

今天在跟 tianhai 搭记忆系统的地基，聊到半夜。

## 20:11 · 记忆系统

【不该被注入的日记正文】这一段是流水账，不该进上下文。
`

export const DAILY_OLD = `# 2026-10-26

## 总结

昨天的总结，不该被选中。
`

/** 单文件日记形态（今天的真实样子：私房日记.md 里一串日期小节） */
export const DIARY_BOOK = `# 小鱼的私房日记

## 2026-10-25 · 旧的一天

【旧小节正文】这条不该被选中。

## 2026-10-27 中午，四毛钱那座故宫

【最新小节正文】他用四毛钱建了一座故宫。
`

/**
 * 造一个假记忆库。
 * @param {object} [opts]
 * @param {string} [opts.agent]        agent 目录名，默认 xiaoyu
 * @param {string} [opts.sessionId]    会话 id，默认 bili-whale
 * @param {boolean} [opts.withPersona]
 * @param {boolean} [opts.withDaily]   一天一个文件的形态
 * @param {boolean} [opts.withBook]    单文件日记的形态
 * @param {boolean} [opts.skipAgentDir] 连 agent 目录都不建（测"找不到 agent 要报"）
 */
export function mkRoot(opts = {}) {
  const {
    agent = 'xiaoyu',
    sessionId = 'bili-whale',
    withPersona = true,
    withDaily = true,
    withBook = false,
    skipAgentDir = false,
  } = opts

  const root = tmp()
  writeFile(join(root, 'private', 'agents.json'), JSON.stringify({ [sessionId]: agent }, null, 2))
  mkdirSync(join(root, 'system'), { recursive: true })

  if (!skipAgentDir) {
    const agentDir = join(root, 'agents', agent)
    mkdirSync(agentDir, { recursive: true })
    writeFile(join(agentDir, 'INDEX.md'), '# index\n\n- 人格.md\n')
    writeFile(join(agentDir, 'people', 'tianhai.md'), '# tianhai\n')
    if (withPersona) writeFile(join(agentDir, '人格.md'), PERSONA)
    if (withDaily) {
      const d = join(agentDir, 'diary', sessionId)
      writeFile(join(d, '2026-10-27.md'), DAILY)
      writeFile(join(d, '2026-10-26.md'), DAILY_OLD)
    }
    if (withBook) {
      const d = join(agentDir, 'diary', sessionId)
      writeFile(join(d, '私房日记.md'), DIARY_BOOK)
    }
  }
  return root
}

/** 配一份配置 */
export function cfgOf(rootDir, overrides = {}) {
  return {
    enabled: true,
    budget: { total: 2500, persona: 1500, diary: 800, signpost: 200 },
    sections: { persona: true, diarySummary: true, signpost: true },
    rootDir,
    fallbackAgent: null,
    ...overrides,
  }
}

/** 假的 DSH 上下文：接住 system-prompt/assemble */
export function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(fn)
      return () => handlers.get(event)?.delete(fn)
    },
  }
}

/** 跑一次钩子：模拟 DSH 调 system-prompt/assemble */
export async function callHook(ctx, context, assembly = { sections: [] }) {
  const set = ctx.handlers.get('system-prompt/assemble')
  if (!set || !set.size) throw new Error('钩子没挂上')
  const handler = [...set][0]
  return handler(null, context, async () => assembly)
}

/** 造一个 context（DSH 的形状：context.agent.session） */
export function contextOf(sessionId) {
  return { agent: { session: { id: sessionId } } }
}

/** 取出注入的那一段 */
export function injectedText(assembled) {
  const seg = (assembled?.sections || []).find((s) => s.name === 'memory:inject')
  return seg ? seg.text : ''
}
