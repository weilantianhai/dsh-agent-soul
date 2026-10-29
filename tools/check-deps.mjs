import fs from 'node:fs'
import path from 'node:path'

const files = []
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.mjs') || f.endsWith('.js')) files.push(p)
  }
}
walk('lib')
walk('src')

const norm = (s) => s.split(path.sep).join('/')
const deps = new Map()
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const ds = []
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    ds.push(norm(path.resolve(path.dirname(f), m[1])))
  }
  deps.set(norm(f), ds)
}

let cycles = 0
for (const [f, ds] of deps) {
  for (const d of ds) {
    if (deps.has(d) && deps.get(d).includes(f) && f !== d) {
      console.log('双向依赖:', f, '<->', d)
      cycles += 1
    }
  }
}
console.log(cycles ? `⚠️ 发现 ${cycles / 2} 处双向依赖` : '✅ 没有双向依赖')

/* 未使用导出（粗查：导出了但全仓没人 import） */
const allSrc = [...deps.keys()].map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const unused = []
for (const [f, dList] of deps) {
  void dList
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/export (?:async )?function (\w+)/g)) {
    const name = m[1]
    const uses = (allSrc.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
    if (uses <= 1) unused.push(`${f} → ${name}`)
  }
}
console.log(unused.length ? `未使用导出 ${unused.length} 个：\n  ${unused.join('\n  ')}` : '✅ 没有未使用的导出')
