# 模型说明 —— 这个插件到底在拿什么做判断

> 写这份文档的直接原因：同一个概念（“会话在不在”）在四天里被重新定义过四次，
> 每次都靠补丁对齐当时的现象。这不叫代码乱，这叫**没有模型**。
>
> 所以这里把每个概念写死，并分成两栏：
>
> - **宿主语义** —— 有据可查，注明来自哪个 API / 哪段源码。改它等于对抗宿主，要慎重。
> - **我们的规则** —— 我自己定的。**可能是错的**，标了 `❓` 的等你确认。
>
> 判断代码对不对，先看它符合哪一栏。两栏混着写的地方，就是这几天的 bug 来源。

---

## 一、会话（Session）

### 1.1 会话的身份

| | |
|---|---|
| **宿主语义** | 会话 id 是字符串，形如 `session-<uuid>`，也可能是自定义名（`bili-whale`）。存在 `~/.dsh/sessions/<cwd编码>/<sessionId>/session.v4.jsonl.zstd` |
| **我们的规则** | 插件里一律 `String(id)`，不假设格式、不假设长度 |

### 1.2 「有哪些会话」—— 这是最容易搞混的一个

**有三个不同的集合，用途完全不同，不许混用：**

| 集合 | 来源 | 本机上有多大 | 用在哪 |
|---|---|---|---|
| ① 磁盘全部 | `~/.dsh/sessions/*/*` | **141** | 判“这个 id 是否存在过” |
| ② 宿主 list() | `sessionController.list()` | 也是 141（本地全权用户 `remoteAccess.allows` 恒 true） | 拿 `running` / `updatedAt` / `origin` 这类**实时状态** |
| ③ 侧边栏可见 | `workspace.json`：`(工作区 ∪ 置顶) − 归档` | **77** | **所有给用户看的数字和筛选** |

**宿主语义**：`sessionController.list()` 返回 `{ items: [...] }`（**对象，不是数组**）。字段 `sessionId / updatedAt / blank / running / origin / parentSessionId / cwd`，**没有 title**。

**我们的规则**：见下面 1.4。

### 1.3 会话的标题

| | |
|---|---|
| **宿主语义** | `sessionTitle.get(session)` 需要**活的 Session 对象**；冷会话的标题在 `~/.dsh/storages/session_projcache.json` → `tables.sessions[<id>].rows.title.val` |
| **我们的规则** | 取标题顺序：projcache → 首条人话 → id 前 12 位。**不编造** |

### 1.4 「会话算不算还在」—— 现在的定义

```
在 = 侧边栏可见（集合③） 且 不是空壳（宿主存储 > 4KB）
```

| 条件 | 依据 | 属于哪栏 |
|---|---|---|
| 侧边栏可见 | `workspace.json` 的 `tables.workspaces[*].sessionIds` ∪ `global.pinnedSessionIds` − `global.archivedSessionIds` | 宿主语义（DSH 的 `sessionVisible` 就这么判） |
| **> 4KB 才算不是空壳** | 实测：`bili-whale` 7.7MB / `xiaoxi` 名下那个 0.4KB | **我们的规则 `❓`** |

**为什么加 4KB**：用户说“小汐显示有 1 个，实际上没有”。查下来那个会话只有 0.4KB —— 建过但一句正经话都没聊。光看“侧边栏里有”会把它算成 1。

**`❓` 待确认**：4KB 是我拍的。更准的做法可能是“有没有至少一条 user/assistant 消息”，但那要解压 zstd，成本高。现在这个数字对不对，你说了算。

**判据不可用时一律返回 `null`（不知道），不返回 `false`**——宁可多露，不能因为读不到就当成不存在。

### 1.5 会话的人格归属

| | |
|---|---|
| **宿主语义** | 宿主完全不知道“人格”这回事。这是**我们插件自己的概念** |
| **存储** | `memory/private/agents.json`：`{ "<sessionId>": "<人格名>" }` |
| **我们的规则** | 三种值语义：<br>`"名字"` = 用它<br>`""`（空串）= **明确不要人格**<br>**缺这个 key** = 跟随 `config.inject.defaultAgent` |

**`❓` 待确认**：这个三态设计是我定的。空串和缺失的区别只在一处生效（`resolveAgentId`），很容易被后来的人当成 bug 改掉。如果你觉得没必要，可以简化成两态。

---

## 二、消息投递（`prompt`）

### 2.1 签名

| | |
|---|---|
| **宿主语义** | `session.prompt(request, signal)` —— **第二个参数是 `AbortSignal`**，第一行就 `signal.throwIfAborted()` |
| 第一个参数 | `{ requestId, sessionId, mode: 'queue'\|'steer', content: [{type:'text', text}] }` |
| **source 从哪来** | **宿主内部构造，写死 `kind: 'user'`**。`const source = { kind: 'user', rpcId: request.requestId }`。**插件无法让消息显示成"自动化任务"之类** |

**这条是这几天最大的坑**：我一直以为第二个参数是 `source`，传 `{kind:'schedule'}`，
于是每个会话都 `wake-failed: signal.throwIfAborted is not a function`。
真机栈：`at Proxy.prompt (dsh-api-session-controller/lib/index.js:3219:11)`。

文件里还有 `SessionCommandController.prompt(request, source)`（925 行），
那是**宿主内部**用的；插件通过 `ctx.get('sessionController')` 拿到的是 Proxy，
走的是 Remote 那一层。**认错这个，白查四轮。**

### 2.2 什么算「送到了」

| 阶段 | 含义 |
|---|---|
| `prompt()` 返回 `{accepted:true}` | **只代表消息进了内存里的 inbox**。不等于落盘，不等于会话会跑一轮 |
| **+ `sessions.flush(session)`** | 才算真的落盘。宿主自己的定时任务（`dsh-schedule`）投完立刻做这件事 |

**我们的规则**：投完必须 `flush`。没落盘就不算叫过（记 `wake-unflushed`，下次能重试）。

### 2.3 「忙」要不要紧

| | |
|---|---|
| **宿主语义** | `mode: 'queue'` 就是**排队**语义：消息进 inbox，等这一轮跑完自动处理 |
| **我们的规则** | **忙也发**。把 `running: true` 当跳过理由，会导致“在对话里点按钮 → 自己永远收不到” |

---

## 三、可见性与隐私

### 3.1 跨人格边界

| | |
|---|---|
| **宿主语义** | `tools/pre-execute` 钩子：`(exec, next) => {kind:'allow'\|'deny'\|'ask'\|'cancel'}` |
| **我们的规则** | 结构化工具（`ops_read_files` / `write` / `edit` / `working_directory`）解析路径 → 落到 `agents/<别人>/` 就拦。**`ops_bash` 不拦**（字符串分析防不住，见下） |

**已知的洞（写在这里，不假装它不存在）**：`ops_bash` 可以 `cd` 再相对路径、可以拼字符串、可以 `python -c`。给了 bash 就等于给了任意文件读写。**靠提示词软约束，不靠代码。**

### 3.2 `ask` 还是 `deny`

| | |
|---|---|
| **宿主语义** | `ask` → `serviceAsk` → `approval.request()`；**没有审批渠道时 `ask` 自动变成拒绝**（fail-closed） |
| **我们的规则** | 默认 `config.privacy.allowPrompt = false` → 返回 `deny` 并带完整理由。**为什么**：返回 `ask` 时宿主会用它自己的固定文案（`the user rejected tool "x"`），把我们的理由**吞掉**，用户看不到为什么被拒 |

---

## 四、日记（Daily）

### 4.1 谁会被叫醒（四重过滤）

按顺序，任何一条不满足就 skip：

| # | 条件 | 依据 |
|---|---|---|
| 1 | 不是 `origin === 'subagent'` | 子代理不写日记 |
| 2 | 不 `blank` | 空会话没内容 |
| 3 | 今天活动过（`updatedAt` 是本地的今天） | **用 `localDate(now)`，不是 `toISOString()`** —— 差一天就全挂 |
| 4 | 有归属人格 | 没绑人格 = 临时会话 |
| 5 | 今天日志行数 ≥ `minLines`（默认 6） | `countLinesTo` 只数有 `text` 且 `role !== 'assistant'` 的 |
| 6 | 今天还没叫过 | 除非 `force` |

**我们的规则**：`force` 要**穿透两道拦截**（整体 `already-ran-today` + 逐会话 `already-woke-today`）。只穿第一道等于按了没反应。

### 4.2 测什么

| | |
|---|---|
| **我们的规则** | **手动触发和定时触发产出的叫醒词必须一字不差**。不给会话打“测试”标记 —— 叫它测试，它就会敷衍。这个按钮关键时刻用来真的补写日记 |

### 4.3 一天只跑一次

| | |
|---|---|
| **我们的规则** | 记录在 `system/daily.state.json`，按日期。**失败也算跑过**（不重试） |
| `skipped` 截断 | 只存前 50 条，但**优先留有人格的** —— 否则排查时看不到自己为什么被跳过 |

---

## 五、上下文摘要（Summary）

**当前状态：设计不成立，代码要移出范围。**

原设计：占用率 ≥ 80% 时叫 agent 写交接总结到 `agents/<人格>/summary/`。

**为什么说不成立**：

1. 压缩是宿主在**一轮进行中**做的，不是“一轮结束”。挂在 `agent/turn-stopping` 上，
   等事件到时压力已经被压掉了 —— **拿结果判断过程，永远慢一步**
2. 真机数据：`done: 0`，一次都没触发过
3. 就算触发，`prompt` 那时还是坏的（见 2.1）

**没有替代方案之前，先删代码，不想留着假装能用。** `❓` 你如果想到正确触发点（比如宿主有没有“即将压缩”的钩子），告诉我。

---

## 六、不变的东西（重构不许碰）

| | |
|---|---|
| 数据目录 | `D:/ProgramData/dsh/memory` —— **路径、结构、命名，一个字都不改** |
| 人格目录 | `agents/<名>/{人格.md, MEMORY.md, INDEX.md, 经验.md, people/, diary/, summary/}` |
| 提示词 | `prompts/**` 是用户自己在编辑的，只允许改排版错字，**不许重写措辞** |
| `apply` 返回值 | **必须 `undefined`**。返回对象 = `TypeError('Invalid effect')` = 插件 2 毫秒后被拆 |
| 路由数 | 16 条，测试钉着 |
| 工具数 | 5 个（`memory_find/open/diary/recall/index`），测试钉着 |

---

## 七、写代码时怎么用这份文档

1. **写判据之前先来这里查**：这个判断属于宿主语义还是我们的规则？
2. **同一个判断只许出现一次**。想出第二个地方，就是错的。
3. **我们的规则要标 `❓` 并写明为什么**。不然下次我会把它当成需求，反过来说用户的需求不对。
4. **两栏混着写的地方就是 bug 温床**。发现混了，拆开。
