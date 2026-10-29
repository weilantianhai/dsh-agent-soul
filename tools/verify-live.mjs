#!/usr/bin/env node
/**
 * verify-live.mjs —— 重启之后，验它真在干活
 *
 * 不用打开界面，直接问宿主：
 *   node tools/verify-live.mjs [端口]
 *
 * 端口：显式传参 > $DSH_WEB_URL（DSH 自己会给，最准）> $DSH_PORT > 63104。
 * 2026-10-28 踩过：这台机器是 62608，写死 63104 只会连不上，白白以为插件没起来。
 *
 * 验四件事：
 *   1. 三块是不是都 on（不是 on 就告诉你是哪块、为什么）
 *   2. 设置页接口活着、能读到配置
 *   3. 登记表里有会话
 *   4. 今天的日志文件存在，里面是原文
 *
 * 只读，不改任何东西。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.argv[2] || process.env.DSH_PORT
const BASE = PORT ? `http://127.0.0.1:${PORT}` : process.env.DSH_WEB_URL || 'http://127.0.0.1:63104'
const ROOT = process.env.DSH_MEMORY_ROOT || 'D:/ProgramData/dsh/memory'

const day = new Date()
const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`

let bad = 0
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => {
  bad++
  console.log(`✗ ${m}`)
}

async function get(path) {
  const r = await fetch(BASE + path, { cache: 'no-store' })
  const text = await r.text()
  try {
    return { status: r.status, data: JSON.parse(text) }
  } catch {
    return { status: r.status, data: null, text }
  }
}

async function main() {
  console.log(`问 ${BASE} …\n`)

  const st = await get('/dsh-agent-soul/api/status').catch((e) => ({ status: 0, error: e }))
  if (!st.data || !st.data.ok) {
    fail(`插件没应答（HTTP ${st.status || '连不上'}）。要么没装，要么没重启，要么插件启动失败`)
    console.log('\n去 DSH 日志里搜 [dsh-agent-soul] 看报什么错。')
    process.exitCode = 1
    return
  }

  const parts = st.data.parts || {}
  for (const [k, label] of [
    ['Sessions', '会话登记'],
    ['Log', '日志'],
    ['Inject', '注入'],
  ]) {
    if (parts[k] === 'on') ok(`${label}（${k}）在跑`)
    else fail(`${label}（${k}）= ${parts[k] || '未知'}`)
  }
  if (st.data.rootDir) console.log(`  rootDir：${st.data.rootDir}`)
  if (st.data.lastError) console.log(`  最近一次报错：${st.data.lastError}`)

  const cfg = await get('/dsh-agent-soul/api/config')
  if (cfg.data && cfg.data.ok) ok('设置页接口活着，读得到配置')
  else fail(`设置页接口不对：HTTP ${cfg.status}`)

  const se = await get('/dsh-agent-soul/api/sessions')
  const sessions = (se.data && se.data.ok && se.data.registry && se.data.registry.sessions) || null
  if (sessions && Object.keys(sessions).length) ok(`登记表里有 ${Object.keys(sessions).length} 个会话：${Object.keys(sessions).join('、')}`)
  else fail('登记表是空的（Sessions 没扫到，或者 DSH 侧还没暴露活着会话）')

  /* 日志文件：找一个会话，看今天有没有文件 */
  const sessDir = join(ROOT, 'sessions')
  if (!existsSync(sessDir)) {
    fail(`日志目录不存在：${sessDir}`)
  } else {
    const ids = readdirSync(sessDir).filter((n) => {
      try {
        return statSync(join(sessDir, n)).isDirectory()
      } catch {
        return false
      }
    })
    let found = 0
    for (const id of ids) {
      const file = join(sessDir, id, 'logs', `${stamp}.jsonl`)
      if (!existsSync(file)) continue
      found++
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      const last = JSON.parse(lines[lines.length - 1])
      ok(`${id} 今天的日志 ${lines.length} 行，最后一行：${JSON.stringify(last.text).slice(0, 40)}…`)
    }
    if (!found) fail(`今天（${stamp}）还没有任何日志文件 —— 说句话再看`)
  }

  console.log('')
  if (bad) {
    console.log(`${bad} 项没过。`)
    process.exitCode = 1
  } else {
    console.log('全过。她在记，也记得自己是谁。')
  }
}

main().catch((err) => {
  console.error('✗ ' + String((err && err.message) || err))
  process.exitCode = 1
})
