#!/usr/bin/env node
/**
 * install-local.mjs —— 把插件 link 进某个 profile（本机安装）
 *
 * 为什么要有这个脚本：desktop profile 由 Electron 独占管理，`dsh plugin` CLI 不让碰；
 * 而手改容易漏步、也容易忘了备份。所以把「加依赖 + 加 bundle + 建链接」固定下来。
 *
 * 用法：
 *   node tools/install-local.mjs --dry-run        # 只说要改什么（默认）
 *   node tools/install-local.mjs --apply          # 真改，先备份
 *   node tools/install-local.mjs --rollback       # 还原到最近一次备份
 *
 * 环境变量：
 *   DSH_PROFILE_DIR=...   默认 ~/.dsh/profiles/desktop
 *   DSH_PROFILE_NAME=...  默认 desktop（只用于打印）
 *
 * ⚠️ 改完**不会自动重启**。重启是人的事。
 */

import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '..')
const PKG = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const NAME = PKG.name

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
const PROFILE_NAME = process.env.DSH_PROFILE_NAME || 'desktop'
const PKG_JSON = join(PROFILE_DIR, 'package.json')
const LOCK = join(PROFILE_DIR, 'pnpm-lock.yaml')
const LINK = join(PROFILE_DIR, 'node_modules', NAME)

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const ROLLBACK = args.has('--rollback')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function latestBackup(file) {
  const dir = dirname(file)
  const base = file.split(/[\\/]/).pop()
  const list = readdirSync(dir)
    .filter((n) => n.startsWith(base + '.bak-'))
    .sort()
  return list.length ? join(dir, list[list.length - 1]) : null
}

function plan() {
  if (!existsSync(PKG_JSON)) throw new Error(`找不到 profile：${PKG_JSON}`)
  const profile = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
  const deps = profile.dependencies || {}
  const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || []

  return {
    profile,
    needsDep: deps[NAME] !== `link:${PKG_DIR.replace(/\\/g, '/')}`,
    needsBundle: !bundles.includes(NAME),
    needsLink: !existsSync(LINK),
    needsLock: existsSync(LOCK) && !readFileSync(LOCK, 'utf8').includes(`\n      ${NAME}:\n`),
    deps,
    bundles,
  }
}

function printPlan(p) {
  console.log(`profile：${PROFILE_DIR}（${PROFILE_NAME}）`)
  console.log(`插件：${PKG_DIR}`)
  console.log('')
  console.log(`  dependencies["${NAME}"]   ${p.needsDep ? '要加' : '已有'}`)
  console.log(`  dsh.profile.bundles       ${p.needsBundle ? '要加' : '已有'}`)
  console.log(`  node_modules/${NAME}      ${p.needsLink ? '要建链接' : '已有'}`)
  console.log(`  pnpm-lock.yaml            ${p.needsLock ? '要补 link 条目' : '已有 / 没有 lock'}`)
}

function apply() {
  const p = plan()
  if (!p.needsDep && !p.needsBundle && !p.needsLink && !p.needsLock) {
    console.log('已经装好了，不用动。')
    return
  }

  const ts = stamp()
  copyFileSync(PKG_JSON, `${PKG_JSON}.bak-${ts}`)
  console.log(`已备份：${PKG_JSON}.bak-${ts}`)

  const next = {
    ...p.profile,
    dependencies: { ...p.deps, [NAME]: `link:${PKG_DIR.replace(/\\/g, '/')}` },
    dsh: {
      ...(p.profile.dsh || {}),
      profile: {
        ...((p.profile.dsh || {}).profile || {}),
        bundles: [...p.bundles.filter((b) => b !== NAME), NAME],
      },
    },
  }
  writeFileSync(PKG_JSON, JSON.stringify(next, null, 2) + '\n')
  console.log('已写入 dependencies + bundles')

  if (!existsSync(LINK)) {
    symlinkSync(PKG_DIR, LINK, 'junction')
    console.log(`已建链接：${LINK} → ${PKG_DIR}`)
  }

  // lock 里也得有这一条，否则哪天 DSH 用 frozen lockfile 装依赖会报 OUTDATED。
  // link 依赖不需要解析版本，所以补一段 specifier/version 同值就够了。
  if (p.needsLock) {
    const linkTarget = PKG_DIR.replace(/\\/g, '/')
    copyFileSync(LOCK, `${LOCK}.bak-${stamp()}`)
    const text = readFileSync(LOCK, 'utf8')
    const block = `      ${NAME}:\n        specifier: link:${linkTarget}\n        version: link:${linkTarget}\n`
    writeFileSync(LOCK, text.replace('\npackages:\n', '\n' + block + '\npackages:\n'))
    console.log('已补 pnpm-lock.yaml 的 link 条目')
  }

  console.log('')
  console.log('装好了。**不会自动重启** —— 重启 DSH 之后看这一行：')
  console.log('[dsh-agent-soul] 已启动 Sessions=on Log=on Inject=on root=D:/ProgramData/dsh/memory')
}

function rollback() {
  const backup = latestBackup(PKG_JSON)
  if (!backup) {
    console.log('没有备份可还原。')
    return
  }
  copyFileSync(backup, PKG_JSON)
  console.log(`已还原：${backup} → ${PKG_JSON}`)

  const lockBackup = existsSync(LOCK) ? latestBackup(LOCK) : null
  if (lockBackup) {
    copyFileSync(lockBackup, LOCK)
    console.log(`已还原：${lockBackup} → ${LOCK}`)
  }

  if (existsSync(LINK)) {
    const st = lstatSync(LINK)
    if (st.isSymbolicLink() || st.isDirectory()) {
      rmSync(LINK, { recursive: true, force: true })
      console.log(`已删链接：${LINK}`)
    }
  }
  console.log('还原完。重启之后插件就不在了。')
}

try {
  if (ROLLBACK) rollback()
  else if (APPLY) apply()
  else {
    printPlan(plan())
    console.log('\n（--apply 才真改；--rollback 还原）')
  }
} catch (err) {
  console.error('✗ ' + String((err && err.message) || err))
  process.exitCode = 1
}
