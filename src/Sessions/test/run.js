#!/usr/bin/env node
/**
 * test/run.js —— 验收跑这一条就够
 *
 *   cd <仓库根>/src/Sessions && node test/run.js
 *
 * 10 条验收 + 7 条附加，全过算完。有一条红就 exit 1。
 */

import { tests as scanTests } from './scan.test.mjs'
import { tests as registryTests } from './registry.test.mjs'
import { cleanup } from './helpers.mjs'

const all = [...scanTests, ...registryTests].sort((a, b) => a.no - b.no)

const REQUIRED = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

let pass = 0
let fail = 0
const failures = []

console.log(`\nSessions 模块验收 · ${all.length} 条\n${'─'.repeat(60)}`)

for (const t of all) {
  const tag = REQUIRED.has(t.no) ? '' : ' [附加]'
  try {
    await t.fn()
    pass += 1
    console.log(`  ✓ ${t.no}. ${t.name}${tag}`)
  } catch (err) {
    fail += 1
    failures.push({ t, err })
    console.log(`  ✗ ${t.no}. ${t.name}${tag}`)
    console.log(`      ${String((err && err.message) || err).split('\n')[0]}`)
  }
}

cleanup()

console.log('─'.repeat(60))
console.log(`  通过 ${pass} / ${pass + fail}`)

const missing = [...REQUIRED].filter((n) => !all.some((t) => t.no === n))

if (fail) {
  console.log('\n  失败详情：')
  for (const { t, err } of failures) {
    console.log(`\n  [${t.no}] ${t.name}`)
    console.log(
      String((err && err.stack) || err)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    )
  }
  console.log('\n  没过。\n')
  process.exit(1)
}

if (missing.length) {
  console.log(`\n  少测了：${missing.join(', ')}\n`)
  process.exit(1)
}

console.log('\n  全绿。\n')
