/**
 * budget.mjs —— 字数预算，超了砍谁
 *
 * 上限（可配）：人格 1500 / 日记 800 / 路标 200，合计 2500。
 *
 * 砍的顺序（任务单定的）：
 *   1. 先砍日记总结 —— 砍到只剩最后一段
 *   2. 还超，砍人格 —— 只留「红线」，其余砍掉
 *   3. **路标永远不砍**
 *
 * 我多加两级（任务单没写"还超怎么办"，但不能就这么超额交出去）：
 *   4. 还超，把日记整段去掉
 *   5. 还超，硬截人格（保留开头，末尾加 …）
 *
 * 每砍一刀都要留下名字，调用方负责报出去 —— **不许默默砍**。
 */

/** 按"看得见的字符"数，中文一个算一个 */
export const chars = (s) => [...String(s ?? '')].length

/** 最后一段（按空行切） */
export function lastParagraph(s) {
  const parts = String(s ?? '')
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * 砍日记：正文砍到只剩最后一段，但**把末尾那行路标留住**。
 * 路标长得像 `（细节：… · 人物：…）`，它不是正文，砍正文不能连它一起砍 ——
 * 不然"留了缺口"的那根手指就没了。
 */
export function shrinkDiary(s) {
  const parts = String(s ?? '')
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const trailIdx = parts.findIndex((p) => p.startsWith('（') && p.includes('细节'))
  const trail = trailIdx >= 0 ? parts.splice(trailIdx, 1)[0] : ''
  const body = parts.join('\n\n').trim()
  return [lastParagraph(body), trail].filter(Boolean).join('\n')
}

/** 硬截断，末尾补 …，保证不超过 max 字 */
export function hardTrim(s, max) {
  const arr = [...String(s ?? '')]
  if (arr.length <= max) return String(s ?? '')
  if (max <= 1) return '…'
  return `${arr.slice(0, max - 1).join('')}…`
}

/** 拼起来的实际字数（段与段之间空一行） */
export function totalChars({ persona = '', diary = '', signpost = '' }) {
  return chars([persona, diary, signpost].filter(Boolean).join('\n\n'))
}

export const DEFAULT_LIMITS = { total: 2500, persona: 1500, diary: 800, signpost: 200 }

/**
 * 砍到预算之内。
 * @param {object} input
 * @param {string} input.persona   人格段（完整：开头 + 红线）
 * @param {string} input.redline   只有红线的那段（降级用）
 * @param {string} input.diary     日记段
 * @param {string} input.signpost  路标
 * @param {object} [input.limits]
 * @param {(reason:string)=>void} [input.onCut] 每砍一刀回调一次
 * @returns {{persona:string, diary:string, signpost:string, chars:number, cuts:string[], over:boolean}}
 */
export function applyBudget({ persona = '', redline = '', diary = '', signpost = '', limits, onCut } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) }
  const cuts = []
  const note = (reason) => {
    cuts.push(reason)
    if (typeof onCut === 'function') {
      try {
        onCut(reason)
      } catch {
        /* 回调自己炸了不影响预算 */
      }
    }
  }

  let p = String(persona || '')
  let d = String(diary || '')
  const s = String(signpost || '') // 路标：从始至终不动

  // ① 各段上限
  if (chars(p) > lim.persona) {
    p = hardTrim(p, lim.persona)
    note(`人格超过单段上限 ${lim.persona} 字，截断`)
  }
  if (chars(d) > lim.diary) {
    const before = chars(d)
    d = hardTrim(shrinkDiary(d), lim.diary)
    note(`日记超过单段上限 ${lim.diary} 字（${before}），砍到只剩最后一段`)
  }

  // ② 总预算
  if (totalChars({ persona: p, diary: d, signpost: s }) > lim.total) {
    if (d) {
      const trimmed = shrinkDiary(d)
      if (trimmed !== d) {
        d = trimmed
        note('总字数超预算，日记砍到只剩最后一段')
      }
    }
  }

  if (totalChars({ persona: p, diary: d, signpost: s }) > lim.total && redline && p !== redline) {
    p = redline
    note('仍超预算，人格只留「红线」')
  }

  if (totalChars({ persona: p, diary: d, signpost: s }) > lim.total && d) {
    d = ''
    note('仍超预算，日记整段去掉')
  }

  if (totalChars({ persona: p, diary: d, signpost: s }) > lim.total) {
    const remain = lim.total - totalChars({ persona: '', diary: '', signpost: s })
    p = remain > 20 ? hardTrim(p, remain - 2) : ''
    note('仍超预算，人格硬截断（路标不砍）')
  }

  const total = totalChars({ persona: p, diary: d, signpost: s })
  return { persona: p, diary: d, signpost: s, chars: total, cuts, over: total > lim.total }
}
