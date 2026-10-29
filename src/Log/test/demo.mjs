/**
 * test/demo.mjs —— 喂各种形态的事件，直观看看最后文件里留下什么
 *
 *   cd <仓库根>/src/Log && node test/demo.mjs
 *
 * 跑在系统 temp 里，不碰真日志。
 */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, stop, status } from '../index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-log-demo-'))
const logs = join(dir, 'logs')
const cfgPath = join(dir, 'config.json')
writeFileSync(cfgPath, JSON.stringify({
  enabled: true,
  selfName: 'xiaoyu',
  ownerMid: '1000001',
  ownerName: 'tianhai',
  defaultRole: 'tianhai',
  sessions: { 'bili-whale': { log: true, dir: logs } },
  defaults: { log: false },
}, null, 2))

const handlers = new Set()
const ctx = { on(e, f) { if (e === 'session/event') { handlers.add(f); return () => handlers.delete(f) } } }
const emit = (s, e) => { for (const f of [...handlers]) f(s, e) }
const S = { id: 'bili-whale' }
const T = (h, mi, s = 0) => new Date(2026, 9, 27, h, mi, s).toISOString()

await start({ ctx, configPath: cfgPath })

// ① 真人说话，但 DSH 包了一层 system-reminder（正文在 user_query 里）
emit(S, { type: 'user/message', seq: 8812, data: {
  content: [{ type: 'text', text:
    '<system-reminder data-role="user-context">\n<user_info>\nOS Version: win32\nShell: bash\n</user_info>\n<current_time>2026-10-27 21:02</current_time>\n</system-reminder>\n<user_query>小鱼，日志这块你想怎么落？</user_query>' }],
  source: { kind: 'user' }, seq: 8812, at: T(21, 2, 10) } })

// ② 小鱼的回话（含代码块和换行）
emit(S, { type: 'assistant/message', data: {
  message: { content: [{ type: 'text', text: '我想一天一个文件，一行一条。\n这样补录的时候好对 seq：\n\n```js\nwrite({ seq })\n```' }] },
  seq: 8813, at: T(21, 2, 48) } })

// ③ bili 私信被包成【主人私信】——标记去掉，正文留下
emit(S, { type: 'user/message', data: {
  content: [{ type: 'text', text: '【主人私信】someone（mid 1000001）刚给你发私信：\n\n今天晚上别熬太晚' }],
  source: { kind: 'user' }, seq: 8814, at: T(21, 5, 30) } })

// ④ 别人的私信（不是主人）
emit(S, { type: 'user/message', data: {
  content: [{ type: 'text', text: '【主人私信】路过的鱼（mid 778899）刚给你发私信：\n\n你这条视频做得真好' }],
  source: { kind: 'user' }, seq: 8815, at: T(21, 6, 12) } })

// ⑤ 生物钟叫醒 —— 不是人说的，整条不留
emit(S, { type: 'user/message', data: {
  content: [{ type: 'text', text: '【生物钟】19:30 该睡了，记得写今天的日记。' }],
  source: { kind: 'schedule' }, seq: 8816, at: T(21, 30, 0) } })

// ⑥ 工具调用 —— 不记
emit(S, { type: 'tool-call', data: { content: [{ type: 'text', text: '{"cmd":"rm -rf /"}' }] } })

// ⑦ 助手被打断 —— 半句，不记
emit(S, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我正想说' }] }, interrupted: true, seq: 8817, at: T(21, 40, 0) } })

// ⑧ 同一个 seq 又来一次（重放/补录）—— 判重
emit(S, { type: 'user/message', data: { content: [{ type: 'text', text: '小鱼，日志这块你想怎么落？' }], source: { kind: 'user' }, seq: 8812, at: T(21, 2, 10) } })

// ⑨ 不在配置里的会话 —— 不记
emit({ id: 'xiaoxi-wechat-shadow' }, { type: 'user/message', data: { content: [{ type: 'text', text: '这条不该出现' }], seq: 1, at: T(21, 50, 0) } })

// ⑩ 过了零点 —— 换文件
emit(S, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '跨天了，这句应该落进新文件。' }] }, seq: 8818, at: new Date(2026, 9, 28, 0, 3, 5).toISOString() } })

console.log('════════ 落盘结果 ════════\n')
for (const f of readdirSync(logs).sort()) {
  console.log(`--- ${f}`)
  const raw = readFileSync(join(logs, f), 'utf8')
  for (const line of raw.split('\n').filter(Boolean)) {
    const o = JSON.parse(line)
    console.log(JSON.stringify(o, null, 0))
  }
  console.log()
}

const s = status()
console.log('════════ 统计 ════════')
console.log(`收到事件 ${s.seen} · 写入 ${s.written} · 没写 ${s.skipped}`)
console.log('没写的原因：', JSON.stringify(s.reasons, null, 0))
console.log('目录：', logs)
await stop()
