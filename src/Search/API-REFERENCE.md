# Search · API 参考

> → 这份是**查签名用的参考资料**：导出什么、参数和返回、回调什么时候触发、失败报什么错。模块整体说明去 [`README.md`](README.md)。

---

## 导出

### `TOOL_KEYS`

```js
export const TOOL_KEYS = {
  memory_find: 'find',
  memory_open: 'open',
  memory_diary: 'diary',
  memory_recall: 'recall',
  memory_index: 'index',
}
```

**键 = 工具名，值 = 配置开关名。**

加新工具时改这里，然后 `src/Inject/manual.mjs` 的 `TOOL_BLURB` / `TOOL_ORDER`
也要加（漏了说明书里会输出 `- undefined`）。

### `register(ctx, opts?) → () => void`

把五个工具挂到宿主的 `tools` 服务上。

```js
const off = register(ctx, {
  rootDir: 'D:/ProgramData/dsh/memory',
  config: { enabled: true, find: true, recall: false },
  onError: (err) => {},
})
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `opts.rootDir` | string | 记忆根目录 |
| `opts.config` | object | 覆盖 `DEFAULT_CONFIG` |
| `opts.fallbackAgent` | string \| null | 没绑人格的会话回落到谁 |
| `opts.onError` | function | 报告错误（**不会抛**） |

**返回**：解绑函数。调用后五个工具全部撤掉。

**失败时**：宿主没有 `tools` 服务 → 调一次 `onError`，返回空函数，不抛。

### `buildTools(deps) → Record<string, ToolDefinition>`

只构造工具定义，不注册。测试用这个。

```js
const tools = buildTools({
  rootDir: '...',
  sessionIdOf: () => 'sess-a',   // 从 exec 里取 sessionId
  fallbackAgent: null,
  maxChars: 12000,
})
// → { memory_find: {...}, memory_open: {...}, ... }
```

每个定义长这样：

```js
{
  name: 'memory_find',
  description: '...',        // 要说清**什么时候用**，不只说干什么
  parameters: { type: 'object', properties: {...} },
  execute: async (args, exec) => '...',
  output: { render: () => '...' },
}
```

### 格式化函数

| 函数 | 干什么 |
|---|---|
| `formatFind(hits)` | 把搜索结果排成人能读的一段 |
| `formatOpen(doc)` | 打开文件后的输出 |
| `formatDiary(summaries)` | 日记总结列表 |
| `formatTranscript(lines)` | 原始对话 |

都是**纯函数**：输入数据，输出字符串。想改措辞改这几个。

---

## 回调 / 触发时机

工具是**按需调用**的 —— 宿主不调，我们什么都不做。
没有定时器、没有轮询。

`execute` 里的 `exec.agent.id` 是 sessionId，
`sessionIdOf(exec)` 负责从各个可能的形状里取出它（不同宿主版本字段不一样）。

---

## 失败时怎么表现

| 情况 | 表现 |
|---|---|
| 文件不存在 | 返回一句"没找到"，不抛 |
| 路径越界 | `lib/guard.mjs` 在 `tools/pre-execute` 拦（不在这里） |
| 宿主没有 `tools` 服务 | `onError` 报一次，返回空函数 |
| `execute` 里抛了 | 宿主自己包成工具错误，agent 会看到错误文本 |

**一律不抛到宿主外面。** 一个工具坏了不该让整轮对话崩。

---

## 配置

```js
export const DEFAULT_CONFIG = {
  enabled: true,
  find: true,
  open: true,
  diary: true,
  recall: true,
  index: true,
}
```

`enabled: false` → 一个都不挂。
单项 `false` → 那个不挂。

---

## 依赖与边界

**依赖**：`lib/infra/fs.mjs`（读文件）、`lib/infra/host.mjs`（拿工具服务）。

**不依赖** `lib/routes`、`lib/index.js` —— 依赖方向只能往下。

**边界**：
- 只读，不写
- 路径全部从 `rootDir` 派生
- `memory_recall` 有硬上限（默认 40，最多 200）
