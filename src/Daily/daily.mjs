/**
 * daily.mjs —— 日记任务的「纯脑子」：筛谁、产稿、写叫醒词
 *
 * 依据 `private/projects/design-tools-daily-prompt.md` §二：
 *
 *   > 给**当天有工作的**、并且**开了日记功能**的会话，注入一段上下文，让它记日记。
 *
 * 四重过滤（缺一不可）：
 *   1. 没有归档（登记表里 archived === false）
 *   2. **有人格认领它**（`private/agents.json` 里有它，且 `agents/<id>/` 存在）
 *   3. 这个 agent 开了日记（`config.agents` 里没被排除）
 *   4. 当天日志有实质内容（不是只有两三行）
 *
 * 再加两条运行时的：
 *   - 这个会话**正忙**就跳过（不排进队列，明天再说）
 *   - **一天只叫一次**（状态文件里记着；失败不重试）
 *
 * 这个文件不碰宿主、不写定时器，全都能单独测。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const msg = (err) => String((err && err.message) || err)

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 几点叫醒。只认 HH:mm */
  time: '23:30',
  /** 当天至少几条对话才算"有实质内容" */
  minLines: 6,
  /** 只给这些人格写日记；null = 所有有人格目录的都算 */
  agents: null,
  /** 每个会话单独开关：{ [sessionId]: { enabled } } */
  sessions: {},
}

/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，半夜会串天） */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(date, delta) {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + delta)
  return localDate(d)
}


export function readLogLines({ rootDir, sessionId, date }) {
  const file = join(String(rootDir), 'sessions', String(sessionId), 'logs', `${date}.jsonl`)
  if (!existsSync(file)) return { ok: false, file, lines: [] }
  try {
    const lines = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec.text === 'string') lines.push(rec)
      } catch {
        /* 坏行跳过 */
      }
    }
    return { ok: true, file, lines }
  } catch (err) {
    return { ok: false, file, lines: [], error: msg(err) }
  }
}

/** 这个 agent 的日记目录（`agents/<id>/diary/<会话>/<日期>.md`） */
export function diaryPath({ rootDir, agentId, sessionId, date }) {
  return join(String(rootDir), 'agents', String(agentId), 'diary', String(sessionId), `${date}.md`)
}

/** 对话稿路径（按会话分开，免得两个人格的会话重名） */
export function draftPath({ rootDir, agentId, sessionId, date }) {
  return join(String(rootDir), 'agents', String(agentId), 'diary', '.draft', String(sessionId), `${date}.md`)
}

/**
 * 产对话稿：机械筛，不做判断。
 * **它是引子，不是素材** —— 这句要写进叫醒词里，不然她会照着写成会议纪要。
 */
export function buildDraft({ rootDir, agentId, sessionId, date }) {
  const log = readLogLines({ rootDir, sessionId, date })
  const body = log.lines
    .filter((r) => r.role && r.role !== 'assistant' && String(r.text || '').trim())
    .map((r) => `**${r.role}**：${String(r.text).trim()}`)
    .join('\n\n')
  const header = [`# ${date} · ${sessionId}`, '', `> 这是对话稿，机器筛的：只有谁说了什么，没有当时的温度。`, ''].join('\n')
  return { text: `${header}${body}`, lines: log.lines.length, file: log.file }
}

/**
 * 筛出今晚该叫醒的会话。
 *
 * @param {object} opts
 * @param {string} opts.rootDir
 * @param {Array} opts.summaries       host 给的会话表：{ sessionId, running, blank, origin, updatedAt }
 * @param {object} opts.ownership      会话 → agent（private/agents.json）
 * @param {object} opts.registry       system/sessions.json 的内容
 * @param {object} [opts.config]
 * @param {string} [opts.date]         默认今天
 * @param {Date} [opts.now]
 * @returns {{date:string, ready:Array, skipped:Array<{sessionId,reason}>}}
 */
export function planSessions({ rootDir, summaries = [], ownership = {}, registry = {}, config = {}, date, now } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const today = date || localDate(now || new Date())
  const rows = (registry && registry.sessions) || {}
  const allow = Array.isArray(cfg.agents) && cfg.agents.length ? new Set(cfg.agents.map(String)) : null

  const ready = []
  const skipped = []

  for (const s of summaries || []) {
    const sid = String((s && s.sessionId) || '')
    if (!sid) continue
    const skip = (reason) => skipped.push({ sessionId: sid, reason })

    if (s.blank) {
      skip('blank')
      continue
    }
    if (s.origin === 'subagent') {
      skip('subagent')
      continue
    }
    /*
     * 正在跑的会话**照样发**（2026-10-29 用户定的）。
     *
     * 为什么改：投递用的是 sessionController.prompt(..., mode:'queue')，
     * 它本来就是**排队**语义 —— 消息进 inbox，等这一轮跑完自动接着处理。
     * 所以"忙"根本不该是跳过理由，只会让"我在对话里点按钮 → 我自己
     * 永远收不到"这种荒唐情况发生。
     *
     * 仍然记一笔 busy，方便诊断时知道这条是插队进去的。
     */
    const wasBusy = s.running === true
    // 今天动过没有（updatedAt 毫秒时间戳）
    const updated = Number(s.updatedAt)
    if (!Number.isFinite(updated) || localDate(new Date(updated)) !== today) {
      skip('not-active-today')
      continue
    }
    // 归档的不写
    if (rows[sid] && rows[sid].archived === true) {
      skip('archived')
      continue
    }
    // 必须有人格认领，且人格目录真的在（这就是"临时会话"的筛子）
    const agentId = ownership[sid]
    if (!agentId || !existsSync(join(String(rootDir), 'agents', String(agentId)))) {
      skip('no-agent')
      continue
    }
    if (allow && !allow.has(agentId)) {
      skip('agent-off')
      continue
    }
    // 这个会话被单独关掉了日记
    const perSession = cfg.sessions && cfg.sessions[sid]
    if (perSession && perSession.enabled === false) {
      skip('session-off')
      continue
    }

    const log = readLogLines({ rootDir, sessionId: sid, date: today })
    const lines = countLinesTo(log.lines)
    if (lines < Number(cfg.minLines || 0)) {
      skip(`too-quiet(${lines})`)
      continue
    }

    ready.push({
      sessionId: sid,
      agentId,
      lines,
      // 这条是插队发的（当时它正在跑，消息会排队等它这一轮结束）
      wasBusy,
      draft: draftPath({ rootDir, agentId, sessionId: sid, date: today }),
      diary: diaryPath({ rootDir, agentId, sessionId: sid, date: today }),
      yesterday: diaryPath({ rootDir, agentId, sessionId: sid, date: addDays(today, -1) }),
      logFile: log.file,
    })
  }

  return { date: today, ready, skipped }
}

/** 已经读成对象了就别再解析一遍 */
function countLinesTo(lines) {
  let n = 0
  for (const rec of lines || []) {
    const role = String(rec.role || '')
    if (!role || role === 'assistant') continue
    if (typeof rec.text === 'string' && rec.text.trim()) n += 1
  }
  return n
}

/**
 * 把日记文件建好，并打上**这个会话自己的标签** ——
 * 同一个 agent 的两个会话，日期会重名，靠目录 + 标签两重保险。
 * 已经存在就不碰（她自己写过的东西，一个字都不改）。
 */
export function ensureDiary({ rootDir, agentId, sessionId, date }) {
  const file = diaryPath({ rootDir, agentId, sessionId, date })
  if (existsSync(file)) return { file, created: false }
  mkdirSync(join(file, '..'), { recursive: true })
  const head = [
    `# ${date}`,
    '',
    `> 会话：${sessionId} · 归属：${agentId} · 由她自己写（Daily 只建了壳）`,
    '',
    '## 总结',
    '',
    '',
  ].join('\n')
  writeFileSync(file, head, 'utf8')
  return { file, created: true }
}

/**
 * 叫醒词。
 * @returns {string}
 */
/**
 * 读插件自带的 prompts/ 下的文件（可编辑的提示词）。
 *
 * 加这层（2026-10-28 tianhai 提的）：日记叫醒词是"对 agent 说话"的，
 * 最需要反复调语气，不该硬编码。
 *
 * @param {string} rel  相对 prompts/ 的路径
 * @param {object} vars 占位符
 * @returns {string} 读不到返回 ''（调用方退回内置）
 */
export function readPromptFile(rel, vars) {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    let root = ''
    for (let i = 0; i < 10; i += 1) {
      const pkg = join(dir, 'package.json')
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, 'utf8'))
          if (j && j.name === 'dsh-agent-soul') {
            root = dir
            break
          }
        } catch {
          /* 继续往上 */
        }
      }
      const up = resolve(dir, '..')
      if (up === dir) break
      dir = up
    }
    if (!root) return ''
    const file = join(root, 'prompts', rel.endsWith('.md') ? rel : rel + '.md')
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8').replace(/\{\{([^}]+)\}\}/g, (m, key) => {
      const k = String(key).trim()
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m
    })
  } catch {
    return ''
  }
}

export function wakeText({ agentId, sessionId, date, draft, diary, rootDir, yesterdayMissing = false }) {
  const rel = (p) => String(p).replace(/\\/g, '/')

  /*
   * 2026-10-29：叫醒词从"只写日记"扩成"全面记忆归档"。
   *
   * 原来只给日记路径 —— agent 就真的只写日记，认识的人、经验、INDEX 全不动。
   * 现在把它自己目录里那几个会被更新的文件都指出来，它才知道还有哪些该维护。
   *
   * 路径一律给绝对路径：只说 `people/` 它可能找不到，而且不同会话的 cwd 不一样。
   */
  const mine = rootDir ? `${rel(rootDir)}/agents/${agentId}` : `agents/${agentId}`

  // 优先用 prompts/daily/00-wake.md（可编辑）；读不到退回内置
  const fromFile = readPromptFile('daily/00-wake', {
    日期: date,
    昨天没写: yesterdayMissing ? `先一句：昨天（${addDays(date, -1)}）你没写。不催，今天照写。` : '',
    对话稿路径: rel(draft),
    会话id: sessionId,
    日记路径: rel(diary),
    我的目录: mine,
    经验路径: `${mine}/经验.md`,
    目录索引路径: `${mine}/INDEX.md`,
    记忆总览路径: `${mine}/MEMORY.md`,
  })
  if (fromFile.trim()) return fromFile.trim()

  /*
   * 内置兜底文案 —— prompts/daily/00-wake.md 读不到时用它。
   *
   * 必须和那份文件说同一件事（四件事：日记 / 认识的人 / 经验 / 大脑地图），
   * 否则文件一坏，行为就悄悄退回"只写日记" —— 用户感觉不到差别，
   * 只会觉得"怎么又只写日记了"。
   */
  const lines = [
    `【每日复盘时间】今天（${date}）你在这个会话里待过。`,
    '',
    yesterdayMissing
      ? `先一句：昨天（${addDays(date, -1)}）你没写。不催，今天照写。`
      : '',
    `你的对话稿在 ${rel(draft)}，先读它。接下来做一次全面的记忆归档。`,
    '',
    '## 1. 写今天的日记',
    '',
    '稿子只是引子，不是素材 —— 它只有谁说了什么，没有当时的温度。别照着它写会议纪要。',
    '写你自己的话。没什么可写就只写一句，别硬凑。',
    '',
    `这一篇属于**这个会话**（${sessionId}），存到 ${rel(diary)}。`,
    '第一行「会话：…」是标签别改，也别把这篇写到别的会话目录里去。总结放「## 总结」那一节。',
    '',
    '## 2. 更新你认识的人',
    '',
    `你自己的目录：${mine}`,
    `${mine}/people/ 就在里面。今天认识新的人了吗？或者对谁有了新的了解？`,
    '有就先看看有没有这个人，有就补充、没有就新建。没有就别凑。',
    '',
    '## 3. 更新你的经验库',
    '',
    `${mine}/经验.md —— 今天踩坑了吗？想明白什么道理了？`,
    '有就记一笔：事、教训、现在还算不算数。',
    '',
    '## 4. 维护你的大脑地图',
    '',
    `${mine}/INDEX.md —— 你的目录：东西都藏在哪`,
    `${mine}/MEMORY.md —— 总览：你在维护什么、进度到哪`,
    '今天新建了文件、改了结构，就顺手更新；没改就不用动。',
    '',
    '# 别做的事',
    '',
    `别动别人的目录，只碰 ${mine} 里的东西。`,
    '别改你自己已经写过的日记正文（今天这篇除外）。',
    '别为了"显得完整"硬凑 —— 今天什么都没发生，写一句也是记录。',
  ]
  return lines.filter((l) => l !== undefined && l !== null).join('\n').trim()
}

/* ------------------------------------------------------------ 状态文件 */

export function readState(file) {
  try {
    if (!existsSync(file)) return { byDate: {} }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && data.byDate ? data : { byDate: {} }
  } catch {
    return { byDate: {} }
  }
}

export function writeState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    // 只留最近 14 天，别让状态文件长成日记
    const dates = Object.keys(state.byDate || {}).sort()
    while (dates.length > 14) delete state.byDate[dates.shift()]
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 今天叫过谁 */
export function wokeToday(state, date) {
  const day = (state.byDate && state.byDate[date]) || {}
  return new Set(Array.isArray(day.woke) ? day.woke : [])
}

export function markWoke(state, date, sessionId, extra = {}) {
  state.byDate = state.byDate || {}
  const day = state.byDate[date] || { woke: [], skipped: [] }
  if (!day.woke.includes(sessionId)) day.woke.push(sessionId)
  if (extra.skipped) day.skipped = extra.skipped
  state.byDate[date] = day
  return state
}

