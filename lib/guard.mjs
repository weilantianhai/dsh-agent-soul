/**
 * guard.mjs —— 跨 agent 的隐私边界（硬拦）
 *
 * 规则一句话：**A 不能碰 `agents/<B>/`，除非 A 就是 B。**
 *
 * 这是"完全权限也拦得住"的那一层 —— DSH 的沙箱按**路径**管（工作区外不让写），
 * 一旦给 danger-full-access 边界就消失了。但"A 的人格目录属于 A"这个信息
 * 沙箱不知道，只有我们知道。所以补在这里。
 *
 * 实现方式：挂 `tools/pre-execute`，工具分发之前看一眼参数里的路径。
 *
 * 为什么只拦结构化工具、不碰 `ops_bash`：
 *   bash 的参数是**命令字符串**，路径能拼、能 cd、能 base64。
 *   在字符串上做边界，防不住还会给人虚假的安全感。
 *   所以 bash 那一层靠提示词软约束（见 prompts/inject/00-manual.md 的铁律），
 *   硬边界只管 read_files / write / edit / working_directory 这些路径是结构化字段的工具。
 *
 * 判定流程：
 *   1. 调用者是哪个会话 → 查 agents.json → 它的人格是谁
 *   2. 参数里的路径 → 归一化 → 是不是落在 <根>/agents/<某人>/
 *   3. 某人 !== 自己 → ask（弹验证）；自己 → allow；不在 agents/ 下 → allow
 *
 * 没有审批渠道时 `ask` 会被宿主变成拒绝（dsh-tools 的 serviceAsk 保证了这点），
 * 所以**失败即安全**：审批链路坏了也只是拒绝，不会静默放行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'

const msg = (err) => String((err && err.message) || err)

/**
 * 把路径归一化成"相对记忆根的 posix 形式"，用来判断前缀。
 *
 * 为什么要这么绕：Windows 上分隔符混用、大小写不敏感、还可能带 `..`。
 * 直接字符串比 contains 会误伤（别的项目里也有 `agents/` 目录）。
 *
 * @param {string} p        待判断的路径
 * @param {string} rootDir  记忆根目录
 * @param {string} cwd      相对路径的基准
 * @returns {string|null}   归一化后的相对路径；不在根下返回 null
 */
export function relToRoot(p, rootDir, cwd) {
  try {
    const root = resolve(String(rootDir))
    const target = isAbsolute(String(p)) ? resolve(String(p)) : resolve(String(cwd || root), String(p))
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return normalize(rel).replaceAll('\\', '/')
  } catch {
    return null
  }
}

/**
 * 从一个相对路径里抠出「它碰的是哪个 agent 的目录」。
 *
 *    `agents/小鱼/人格.md`        → '小鱼'
 *    `agents/小鱼`                → '小鱼'
 *    `sessions/x/logs/a.jsonl`    → null（不是 agent 专属目录）
 *
 * @param {string|null} rel
 * @returns {string|null}
 */
export function agentOfRel(rel) {
  if (!rel) return null
  const parts = String(rel).split('/').filter(Boolean)
  if (parts.length < 2) return null
  if (parts[0] !== 'agents') return null
  return parts[1] || null
}

/**
 * 从一次工具调用里提取所有"可能是路径"的字符串。
 *
 * 覆盖我们关心的四个工具：
 *   ops_read_files        → arguments.files[].path
 *   write / edit          → arguments.file_path
 *   working_directory     → arguments.cd
 *   ops_list / 其它带 path 的 → arguments.path
 *
 * **故意不解析 ops_bash 的 command** —— 见文件头。
 *
 * @param {string} name
 * @param {object} args
 * @returns {Array<{path:string, where:string}>}
 */
export function pathsOf(name, args) {
  const out = []
  const push = (p, where) => {
    if (typeof p === 'string' && p.trim()) out.push({ path: p.trim(), where })
  }
  if (!args || typeof args !== 'object') return out

  // ops_read_files：files 是数组
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f && typeof f === 'object') push(f.path, 'files[].path')
    }
  }
  // write / edit / 以及任何用 file_path 的
  push(args.file_path, 'file_path')
  push(args.path, 'path')
  // working_directory 的 cd
  push(args.cd, 'cd')
  // 我们自己的几个工具：id 不是路径，但 memory_open 可能带 diary/xxx
  // 那些本来就在自己的目录里，不用拦

  return out
}

/**
 * 建一个 guard 函数，挂到 `tools/pre-execute` 上。
 *
 * @param {object} opts
 * @param {string} opts.rootDir        记忆根目录
 * @param {() => object} opts.readOwnership  返回 agents.json 的内容
 * @param {(text:string)=>void} [opts.onBlock] 被拦时记一笔（诊断用）
 * @param {() => boolean} [opts.canAsk]  有没有审批渠道（能弹窗让人确认）
 * @returns {(exec: object) => {kind:string, reason?:string, displayReason?:object}}
 */
export function makeGuard({ rootDir, readOwnership, onBlock, canAsk } = {}) {
  return function guard(exec) {
    try {
      if (!exec || typeof exec !== 'object') return { kind: 'allow' }

      // 谁在调
      const sid = exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      if (!sid) return { kind: 'allow' } // 没有主体，谈不上越界
      const table = (typeof readOwnership === 'function' ? readOwnership() : null) || {}
      const me = table && typeof table === 'object' ? table[sid] : null
      const myAgent = typeof me === 'string' && me ? me : ''

      // 参数里的路径
      const paths = pathsOf(exec.name, exec.arguments)
      if (paths.length === 0) return { kind: 'allow' }

      const cwd = join(String(rootDir))
      for (const item of paths) {
        const rel = relToRoot(item.path, rootDir, cwd)
        const owner = agentOfRel(rel)
        if (!owner) continue // 不在 agents/<某人>/ 下，不管
        if (myAgent && owner === myAgent) continue // 自己的，放行
        /*
         * 越界：别人的目录。或者自己压根没有人格（myAgent 为空）——
         * 那种情况下任何 agent 的专属目录都算别人的。
         */
        const who = myAgent ? `「${myAgent}」` : '你（当前会话没有绑定人格）'
        const reason = `跨 agent 访问：${who} 不能读/写 \`agents/${owner}/\`（那是「${owner}」的私人目录）`
        if (typeof onBlock === 'function') {
          try {
            onBlock(`${exec.name} ${item.where}=${item.path} → 属于 ${owner}`)
          } catch {
            /* 记日志失败不影响拦截 */
          }
        }

        /*
         * 有审批渠道 → ask（弹窗让人确认）
         * 没有     → deny，并且**把理由原样交出去**
         *
         * 为什么不能无脑 ask（2026-10-29 真机验证发现的）：
         * 宿主在没有审批渠道时会把 ask 变成拒绝，但用的是它自己的固定文案
         * 「the user rejected tool "ops_read_files"」—— 我们写的理由被吞了。
         * 用户看到只会以为是误拦，不知道为什么、也不知道该怎么办。
         */
        const askable = typeof canAsk === 'function' ? canAsk() : true
        if (!askable) {
          return {
            kind: 'deny',
            reason:
              `${reason}。\n` +
              '（当前没有可用的确认弹窗，所以直接拒了。确实要读，让主人自己来，' +
              `或让「${owner}」自己把内容拿给你。）`,
          }
        }

        return {
          kind: 'ask',
          reason,
          displayReason: {
            en: `Cross-agent access: this session may not touch agents/${owner}/`,
            zh: `跨 agent 访问：这个会话不能碰「${owner}」的私人目录`,
          },
        }
      }

      return { kind: 'allow' }
    } catch (err) {
      /*
       * guard 自己炸了怎么办？
       * **放行**还是**拒绝**？这里选放行 —— guard 是附加保护，
       * 它坏了不应该让所有工具都用不了（那会把整个插件变成炸弹）。
       * 但要报错出去，让人知道边界此刻没生效。
       */
      if (typeof onBlock === 'function') {
        try {
          onBlock(`guard 出错（这次放行）：${msg(err)}`)
        } catch {
          /* 忽略 */
        }
      }
      return { kind: 'allow' }
    }
  }
}

/** 读 agents.json（会话 → 人格）。读不到返回空对象，不抛 */
export function readOwnershipFile(file) {
  try {
    if (!existsSync(file)) return {}
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}
