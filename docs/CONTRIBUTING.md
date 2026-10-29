# 怎么改这个仓库

> 这份不讲产品，只讲**动手时的约定**和**别人踩过的坑**。
> 先读 [`ARCHITECTURE.md`](ARCHITECTURE.md) 知道东西在哪，再读这份知道怎么改。

---

## 三条硬规矩

### 1. 判据只能有一份

同一个判断（"会话在不在"、"这个人格有几个会话"、"消息算不算送到"）
**只许在一个地方实现**。想用就 import，不许抄。

为什么这么严：这个仓库以前每种判据都有两三份实现，
改了一处、漏了一处，于是"改了不生效"、"两个地方数字不一样"。
`lib/domain/session.mjs` 就是为这件事存在的。

### 2. 帮用户看的数据，必须和用户能看见的那份同源

界面上显示"有 12 个会话"，用户就会去侧边栏数。
如果他数出来 5 个，你的逻辑再对也是错的。

具体到代码：**给用户看的会话集合，一律用 `readSidebarSessions()`。**
不要用 `sessionController.list()`（那里面有他看不见的会话）。

### 3. 数据目录不许自己写

所有写入走 `lib/infra/fs.mjs`。它替你做了原子写和写前备份。

```js
// ✅ 对
import { readJson, atomicWrite, withBackup } from './infra/fs.mjs'

// ❌ 错 —— 断电会截断文件，用户数据看起来凭空消失
writeFileSync(join(root, 'private/agents.json'), JSON.stringify(x))
```

---

## 加一个新接口

1. 在 `lib/routes/<资源>.mjs` 里写，不要往 `routes.mjs` 塞
2. 用 `json(res, code, payload)` 返回，不要自己 `res.end()`
3. **写操作必须过 `fence`**（`registerRoutes` 里已经统一处理，但别绕过）
4. 加完更新 `test/host-contract.mjs` 里的路由数（它会报"实际 N 条"）
5. 在 `test/smoke.mjs` 加一条真调的用例

前端要读的话，`client.js` 里搜 `jget` / `jpost` 看现有写法。

---

## 加一个新工具（给 agent 用的）

四步，**漏一步就会有一个地方不知道它的存在**：

1. `src/Search/index.mjs` 的 `TOOL_KEYS` 加键
2. 同文件的 `buildTools` 里加定义
3. `src/Inject/manual.mjs` 的 `TOOL_BLURB` 加一句说明（**漏这步说明书里会输出 `- undefined`**）
4. `src/Inject/manual.mjs` 的 `TOOL_ORDER` 加键（决定说明书里的排列顺序）

`test/host-contract.mjs` 会验工具数，`src/Search/test` 会验清单和 `TOOL_KEYS` 一致。

---

## 改提示词

`prompts/` 下的 md 是**用户可以直接编辑的**，不是代码。

| 前缀 | 是什么 | 发给模型吗 |
|---|---|---|
| `_doc-` | 给开发者看的说明 | ❌ 不发 |
| 其余 | 真正的提示词 | ✅ 发 |

改的时候注意：

- **占位符是 `{{名字}}`**，双花括号。改错一个字母就变成字面输出
- 改完后检查代码里有没有对应的**内置兜底文案** —— 文件读不到时会用它，
  两份说法不一致的话，文件一坏行为就悄悄变了
- **不要重写用户的措辞**。那是他改的东西，只改排版和错字

---

## 加一个模块

`src/<名字>/` 三件起：`index.mjs`（导出 `register`）、`test/run.js`、`package.json`。

然后 `lib/index.js` 的 `mount()` 里加一块，**注意顺序**（见 `ARCHITECTURE.md`）：

```js
try {
  const mod = await loadPart('../src/<名字>/index.mjs')
  const off = mod.register(ctx, { ... })
  runtime.parts.<名字> = 'on'
  if (typeof off === 'function') disposes.push(...)
} catch (err) {
  runtime.parts.<名字> = 'missing'
  onError(new Error(`<名字> 未启用：${msg(err)}`))
}
```

**失败不许拖垮别的块。** 这是这个插件的底线：一块起不来，其他照常。

---

## 这个仓库踩过的坑（别重犯）

### 只 `export { x } from './y'` 不 `import`，然后本文件还要调用 x

```js
export { readSidebarSessions } from './session.mjs'   // 转手导出，老调用方不用改
// ...
const inWs = readSidebarSessions()                     // ❌ ReferenceError
```

**re-export 不等于 import。** 本文件要用就得单独 import 一遍。

这个错在这个仓库犯过 **四次**（`probes.mjs`、`routes.mjs`、`sessions.mjs`、`agents.mjs`）。
共同点：**凭印象写 import，不查实际用了什么**。

改法：搬代码时先 `grep -oE '\b(符号名1|符号名2|...)\b'` 把用到的全捞出来，
再对着原文件的 import 那几行抄 —— 不要手写。

### 按括号配平删函数

JSDoc 注释里的 `{ }` 会被算进括号配平，于是删多或删少。

```js
// 注释里有 { } —— 配平算法会数错
/**
 * 返回 { ok, error }   ← 这里的 { } 不是代码
 */
```

改法：按**行号**删，或找"列 0 位置的 `}`"作为结束。

### 改后端返回结构，不找前端消费点

删一个字段，前端还在读 → 界面上安静地显示 `undefined`。
不会报错，只会看起来像坏了。

改完 `grep` 一遍前端引用的字段，或者干脆审一遍所有 `xxx.yyy`。

### 测试的 mock 形状和宿主对不上

这个最危险 —— **测试绿，功能瞎**。

真实案例：`pressureOf` 读的是 `ctx.sessionProjections.stateOf(session, key)`，
但测试 mock 的是 `session.projections.values()`（一个不存在的方法）。
于是单测全绿，功能一次没工作过，直到用户发现"怎么没提醒写总结"。

改法：**mock 之前先查宿主源码**，或用 `cordis_inspect_query` 看真实签名。
`tools/verify-summary.mjs` 就是为这类事加的 —— 真 cordis 里验一遍。

---

## 提交前自查

- [ ] 判据有没有出现第二份？
- [ ] 给用户看的数字，和用户能看见的同源吗？
- [ ] 写数据走 `infra/fs.mjs` 了吗？
- [ ] 新加的 export 有人用吗？（`node tools/check-deps.mjs`）
- [ ] 测试里的 mock 形状，和宿主真实签名一致吗？
- [ ] 改了返回结构，前端消费点都跟上了吗？
- [ ] `npm test` 绿了吗？（它最后一步是真机验证，不只看单测）

---

## 跑测试

```bash
npm test                        # 全套
node src/Daily/test/run.js      # 单个模块
node tools/check-deps.mjs       # 依赖 / 死代码
node tools/verify-summary.mjs   # 真 cordis 验摘要
```

**改完必须重启 DSH 才生效**（后端改动）。只改 `client.js` 刷新页面就行。
