# Daily · API 参考

> → 这份是**查签名用的参考资料**：导出什么、参数和返回、回调什么时候触发、失败报什么错。模块整体说明去 [`README.md`](README.md)。

---

## 入口

### `start(ctx, opts) → { stop, run, status }`

起定时器 + 启动补跑。

```js
const handle = start(ctx, {
  rootDir: 'D:/ProgramData/dsh/memory',
  config: { enabled: true, time: '23:30', minLines: 6 },
  sidebarSessions: readSidebarSessions(),   // 侧边栏可见集，见下
  onError: (err) => {},
  onReport: (r) => {},
})
```

| 参数 | 说明 |
|---|---|
| `opts.config` | 覆盖 `DEFAULT_CONFIG` |
| `opts.sidebarSessions` | `Set<string>`。**没有它就不过滤**（宁可多露） |
| `opts.onError` | 报告错误，不抛 |
| `opts.onReport` | 每轮跑完回调一次，参数是结果 |

**返回**：

| 字段 | 干什么 |
|---|---|
| `stop()` | 停定时器 |
| `run(extra?)` | 手动跑一轮。`extra` 可带 `force` / `sidebarSessions` |
| `status()` | 当前状态快照 |

`run({ force: true })` 忽略"今天已经叫过"（**两道拦截都穿透**）。

### `runOnce(ctx, opts) → Promise<Result>`

跑一轮，不涉及定时器。`start().run()` 内部调它，测试也直接调它。

**返回**：

```js
{
  date: '2026-10-29',
  woke: ['session-a', 'bili-whale'],     // 真的送到并落盘的
  skipped: [{ sessionId, reason }],       // 没叫的，各自原因
  diag: {
    hostItems,          // 宿主给了几个会话
    withAgent,          // 其中挂了人格的
    activeToday,        // 其中今天动过的
    readyAfterFilter,   // 过完筛子的
    skippedTotal,
    owned: [...],       // 挂了人格的逐个：叫什么下场
    failed: [...],      // 投递失败的
  },
}
```

**`reason` 可能的取值**：

| reason | 意思 |
|---|---|
| `blank` | 空会话 |
| `subagent` | 子代理 |
| `not-active-today` | 今天没动过 |
| `no-agent` | 没绑人格 |
| `agent-off` | 那个人格关了 |
| `session-off` | 这个会话单独关了 |
| `too-quiet(N)` | 今天只有 N 行，不够 `minLines` |
| `archived` | 已归档 |
| `already-woke-today` | 今天叫过（`force` 能穿透） |
| `wake-unflushed` | 投了但没落盘，不算叫过 |
| `wake-failed:xxx` | 投递抛错 |

---

## 纯逻辑（`daily.mjs`）

### `localDate(d?) → 'YYYY-MM-DD'`

**本地日期。** 不能用 `toISOString()` —— 那是 UTC，北京时间半夜会串天。
这个 bug 真的发生过：造测试数据用 UTC 日期，跑起来全是 `too-quiet(0)`。

### `planSessions({ rootDir, summaries, ownership, registry, config, date, now })`

筛出该叫谁。**纯函数**，不读文件不投消息，测试直接调它。

`summaries` 是宿主给的会话列表（`{ sessionId, running, blank, origin, updatedAt }`）。

返回 `{ ready: [...], skipped: [...] }`。
`ready` 里每项带 `wasBusy`（当时是不是在跑，消息会排队）。

### `buildDraft({ rootDir, agentId, sessionId, date })`

产对话稿：把当天日志里**人说的话**捞出来，按会话分开。

### `ensureDiary({ rootDir, agentId, sessionId, date })`

建日记壳（第一行打「会话：…」标签）。
**已经有内容的一个字都不动** —— 返回 `{ created: false, file }`。

### `wakeText({ agentId, sessionId, date, draft, diary, rootDir, yesterdayMissing })`

拼叫醒词。优先读 `prompts/daily/00-wake.md`，读不到用内置兜底。

**内置兜底必须和那份文件说同一件事**（四件事），否则文件一坏行为就悄悄退回"只写日记"。

### `readLogLines({ rootDir, sessionId, date })`

读当天日志。返回 `{ ok, file, lines }`。

### `readPromptFile(rel, vars)`

读 `prompts/` 下的文件并替换 `{{占位}}`。读不到返回 `''`。

---

## 配置

```js
export const DEFAULT_CONFIG = {
  enabled: true,
  time: '23:30',       // 只认 HH:mm
  minLines: 6,         // 当天至少几条对话才算有内容
  agents: null,        // 只给这些人格写；null = 所有
  sessions: {},        // 每个会话单独开关
}
```

`enabled: false` → 起不来，`run()` 直接返回 `{ reason: 'disabled' }`。

---

## 状态文件

### `system/daily.state.json`

```json
{
  "byDate": {
    "2026-10-29": {
      "woke": ["bili-whale"],
      "ran": true,
      "skipped": [{ "sessionId": "...", "reason": "too-quiet(2)" }],
      "skippedOwned": 3
    }
  }
}
```

**`skipped` 只存前 50 条，但优先留有人格的** ——
不然排查时看不到自己为什么被跳过。

### `status()` 返回

```js
{
  enabled, startedAt, nextAt,
  lastRun, lastReport, lastError,
  catchUp,           // 启动补跑排期 { at, scheduledMs } 或 null
}
```

---

## 回调 / 触发时机

| 时机 | 发生什么 |
|---|---|
| `start()` 时已经过了设定时间 | 8 秒后补跑一次（走和定时器**同一条**路径 `tick`） |
| 到设定时间 | `tick()` → `runOnce()` → `schedule()` 排下一次 |
| 手动 `run()` | 直接 `runOnce()`，不影响定时器 |

**补跑为什么要走 `tick` 而不是裸调 `runOnce`：**
裸调不写 `lastRun` / `lastReport`，界面上看不出来它跑过 ——
用户只会觉得"设了时间怎么没生效"。

---

## 失败时怎么表现

| 情况 | 表现 |
|---|---|
| 宿主没有 `sessionController` | `reason: 'no-session-controller'`，报一次 |
| 拿不到会话列表 | `reason: 'list-failed'` |
| 某个会话投不进去 | 记进 `skipped`（`wake-failed:xxx`），**不重试**，不影响别人 |
| 投了但没落盘 | 记 `wake-unflushed`，**不算叫过**，下次能重试 |
| 拿不到上下文压力 | 不叫（宁可漏，不瞎叫） |

**一律不抛到宿主外面。**

---

## 依赖与边界

**依赖**：`lib/infra/fs.mjs`、`lib/infra/host.mjs`、`lib/domain/session.mjs`（判"在不在"）。

**不依赖** `lib/routes`、`lib/index.js`。

**边界**：只动 `agents/<人格>/` 和 `sessions/<会话>/`，不改用户已经写好的正文。
