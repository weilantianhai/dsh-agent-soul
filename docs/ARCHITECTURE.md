# 架构

> 给要改这个插件的人看的。不涉及产品功能，只讲"东西在哪、为什么在那"。

先读 [`MODEL.md`](MODEL.md)。那份讲**概念**（会话是什么、消息什么时候算送到），
这份讲**代码怎么摆**。两份配合着看，比单独看代码快得多。

---

## 一个插件，六个半边，五个模块

```
                    ┌──────────────────┐
   浏览器          │  client.js       │  UI：设置页 / 侧边栏 / 新会话选人
                    └────────┬─────────┘
                             │ HTTP（只认回环）
                    ┌────────┴─────────┐
   宿主进程         │  lib/index.js    │  编排：apply → mount 六块 → 挂路由
                    └────────┬─────────┘
             ┌──────────────┼──────────────┐
             │              │              │
      ┌──────┴─────┐  ┌─────┴────┐  ┌─────┴──────┐
      │ infra/     │  │ domain/  │  │ routes/    │
      │ fs  host   │  │ session  │  │ 资源分文件  │
      └────────────┘  └──────────┘  └────────────┘
             │              │              │
             └──────────────┼──────────────┘
                            │
                    ┌───────┴────────┐
      ┌─────────────┤  src/（五个模块）├─────────────┐
      │             └────────────────┘             │
   Sessions      Log  Inject  Search  Daily
   登记会话      记日志 拼提示  查记忆   写日记
```

**依赖方向只能往下，不能往上传。** 具体规矩：

| 层 | 能依赖 | 不能依赖 |
|---|---|---|
| `src/`（模块） | `lib/domain`、`lib/infra` | `lib/routes`、`lib/index.js` |
| `lib/routes/` | `lib/domain`、`lib/infra` | `lib/index.js` |
| `lib/domain` | `lib/infra/fs` | 上面任何一层 |
| `lib/infra` | 只有 node 内置 | 一切业务概念 |

`lib/index.js` 是最顶上那一层，谁都能往下看，但它只负责编排，不实现业务。

---

## 目录

```
lib/
  index.js            654 行   apply/mount/unmount；六块的挂载顺序和拆解都在这里
  routes.mjs          235 行   registerRoutes：挂 webServer、注册路由、dispose
  routes/
    agents.mjs        647      人格全部接口
    sessions.mjs      267      会话列表 + 登记表清理
    http.mjs          109      json / 本机校验 / 信任栅栏 / 读请求体
    text.mjs           67      骨架生成（纯函数）
    prompt-file.mjs    62      读 prompts/ 并替换占位符
    board.mjs          63      话板
    daily.mjs          51      手动触发写日记
  infra/
    fs.mjs            97      文件读写唯一入口（含"写前备份"）
    host.mjs          127     宿主服务唯一入口（ctx.get 全在这）
  domain/
    session.mjs       213     会话判据**只有这一份**
  guard.mjs           217     跨人格隐私边界（tools/pre-execute）
  summary.mjs                上下文压力的算法
  summary-watch.mjs          看门狗：到阈值 → 排队 → 等空闲 → 叫它写
src/                   五个模块的真实源码，每个都有两份文档
  Log/  Sessions/  Inject/  Search/  Daily/
    README.md              这模块干什么、怎么跑、怎么验、硬边界
    API-REFERENCE.md       导出什么、签名、回调时机、失败表现
prompts/               所有对 agent 说的话（见该目录的 INDEX.md）
docs/                  这份 + MODEL.md + CONTRIBUTING.md
tools/                 check-deps / verify-summary
client.js             2904 行  UI（未拆分，见"已知问题"）
```

**每个模块两份文档，分工固定**：

- `README.md` —— 给人**上手**看的：它干什么、怎么跑、边界在哪
- `API-REFERENCE.md` —— 给人**查签名**看的：导出、参数、返回、失败表现

两份都不长（100–200 行），先读 README 再看代码，卡住了查 API-REFERENCE。

---

## 六块挂载

`lib/index.js` 的 `mount()` 按顺序挂，每块失败不拖垮别的：

| # | 块 | 干什么 | 失败会怎样 |
|---|---|---|---|
| 1 | Sessions | 登记会话，定时重扫 | 会话表空，其余照常 |
| 2 | Log | 把对话记进 `sessions/<id>/logs/` | 没日志，日记产不出稿 |
| 3 | Inject | 每轮往系统提示里塞人格/日记/路标 | 系统提示里没有记忆 |
| 4 | Tools | 五个 `memory_*` 工具 | agent 只能凭印象说 |
| 5 | Daily | 定时叫醒写日记 + 手动触发 | 晚上不叫 |
| 6 | Privacy | 跨人格读写的拦截 | 隐私边界没了 |
| 7 | Summary | 上下文到阈值时叫它写交接总结 | 压缩前不留底 |

**顺序有讲究**：Sessions 必须最先（别人都要它的登记表）；
Privacy 在 Tools 之后（它拦的是工具调用）。

---

## 三个"唯一入口"

这几个地方是为了**不让同一件事出现第二次**。改之前先想清楚会不会破坏它：

### `lib/infra/fs.mjs`
所有文件读写。**"写数据前先备份"这条规矩在这里**，别的文件不许自己
`writeFileSync` 到数据目录 —— 漏一处就是"用户数据没了，还回不去"。

### `lib/infra/host.mjs`
所有 `ctx.get(...)`。每个都做了"没有这个服务怎么办"的处理。
有些服务在不同宿主版本里会在两个位置（`ctx.webServer` / `ctx.get('webServer')`），
这个兼容逻辑也只在这里。

### `lib/domain/session.mjs`
所有会话判据。**「会话在不在」只许有一个定义**。
历史上它换过四种口径，每次都靠补丁对齐现象 —— 详见 `MODEL.md` 1.4。

---

## 数据流

### 一轮对话

```
用户发消息
  ↓
session/event  ──────────────→ Log 写进 logs/<date>.jsonl
  ↓
system-prompt/assemble ──────→ Inject 追加一段（人格/日记/路标）
  ↓
模型回答
  ↓
tools/pre-execute ──────────→ Privacy 判断：是不是要碰别人的目录
```

### 提示词注入 —— 最复杂的一环

这一块决定了 **agent 每轮开口前"知道什么"**。它做错了，记忆存得再好也没用。

#### 挂在哪

宿主每轮组系统提示时发 `system-prompt/assemble`，是个 **waterfall**（瀑布）：

```js
ctx.on('system-prompt/assemble', async (assembly, context, next) => {
  const assembled = await next()        // ← 必须先 next，拿到别人组装好的
  assembled.sections.push({ name: 'memory:inject', text })
  return assembled
})
```

**三个必须遵守的点：**

| # | 规矩 | 违反会怎样 |
|---|---|---|
| 1 | `push` 必须在 `await next()` **之后** | 之前 push，会被后面的插件覆盖掉 |
| 2 | 关掉时 `return assembled`（**同一个对象**） | 新建对象，下游拿到的引用变了 |
| 3 | 拿不到 `context.agent.session` 就报一次 `onError` | 静默跳过，看起来"注入了但没效果" |

#### 从哪知道"这是谁的会话"

```
context.agent.session.id              ← sessionId
        ↓ 查 private/agents.json
        ↓ 没有这个条目？
        ↓   ├─ 有 config.inject.defaultAgent → 用它
        ↓   └─ 都没有                      → 这个会话没人格，不注入
```

归属表是**三态**的（见 `MODEL.md` 1.5）：`"名字"` / `""`（明确不要）/ 缺失（跟随默认）。

#### 拼什么（五段，有顺序）

| 顺序 | 段 | 内容 | 能被预算砍吗 |
|---|---|---|---|
| 1 | `manual` | 插件说明书：铁律、工具、目录路标 | **不砍** |
| 2 | `persona` | 人格上半（"我是谁、怎么说话"） | 砍 |
| 3 | `diarySummary` | 最近一篇日记的「## 总结」段 | 砍 |
| 4 | `signpost` | 一句路标：稿子/日记/人在哪 | 砍 |
| 5 | `board` | 话板有新留言时提一句 | 砍 |

**说明书不砍是有意的**：它讲的是边界（"别人的目录别碰"），砍掉等于没有边界。

#### 人格为什么要分"首轮 / 后续"

人格全文上千字。每轮都给一遍，就是在**每轮都重新付一遍 token**。

```js
repeat: 'first-turn'   // 默认：同一会话第一次给完整上半，之后只给一句路径提醒
repeat: 'every-turn'   // 每轮都给（人格短、或要求强一致时用）
```

记忆记的是 `sessionId → 上次用的哪个人格`。
**换人格时会重新给全文** —— 不然它会以为自己还是上一个人。

#### 预算怎么砍

拼完之后过 `applyBudget`：

```
总字符超了
  ↓ 先砍 diarySummary（日记总结没那么要紧）
  ↓ 再砍 signpost（路标可以只留最短一句）
  ↓ 再砍 persona（**最后才动人设**）
  ↓ 说明书永远不动
```

每砍一次记一条 `cuts`，`status()` 里能看到"这轮为什么少了什么"。

#### 提示词文件在哪

**所有对 agent 说的话都在 `prompts/`，不在代码里。** 存盘生效，不用重启。

改的时候注意：**代码里还有一份内置兜底**。文件读不到时用它。
两份说法不一致的话，文件一坏行为就悄悄变了 —— 而且没人会发现。

#### 怎么验

```bash
cd <仓库根>/src/Inject && node test/run.js
```

`test/run.js` 走**真钩子**跑两轮，断言：第一轮有完整人格、第二轮只剩提醒；
关掉某一段后它真的不出现；预算砍到 0 时说明书还在。

### 上下文到阈值

```
每轮结束 / 状态变化
  ↓
Summary 读 ctx.sessionProjections.stateOf(session, 'contextPressure')
  ↓  超过 80%？
排进 pending（**不立刻发** —— 它可能正在干长任务）
  ↓  等它 idle
prompt → 让它写交接总结到 agents/<人格>/summary/<会话>/
```

### 晚上写日记

```
定时器到点
  ↓
拿宿主的会话列表
  ↓
**按侧边栏可见集过滤**（见 MODEL.md 1.2：宿主给 141 个，用户只看得见 77 个）
  ↓
四件事筛：不是子代理 / 不空 / 今天动过 / 有人格 / 有内容量
  ↓
产对话稿 → 建日记壳 → 投叫醒消息 → flush 落盘
```

---

## 改代码前该知道的四件事

**① `apply` 必须返回 `undefined`。**
宿主把返回值当"这次挂载的 effect"解释：函数=disposer、可迭代=逐个收，
**其余一律 `TypeError('Invalid effect')`**，然后整个插件被拆。
`test/host-contract.mjs` 钉着这条。

**② `prompt` 的第二个参数是 `AbortSignal`。**
不是 source。宿主第一行就 `signal.throwIfAborted()`。
`source` 由宿主构造、`kind` 写死 `'user'` —— 插件改不了消息的显示形态。

**③ 宿主给三个不同的"会话集合"，别混用。**
磁盘全部（141）/ 宿主 list()（也是 141）/ 侧边栏可见（77）。
给用户看的数字必须用第三个。见 `MODEL.md` 1.2。

**④ 提示词在 `prompts/`，不在代码里。**
改一句措辞不用动代码、不用重启。`_doc-` 前缀的文件是给人看的，不会发给模型。

---

## 已知问题

**`client.js` 2904 行没拆。**
它是单文件注入（`window.__ModuleLoader__.load({factory})`），
拆成多文件要动宿主 loader，风险高、收益低。

补偿手段：文件内部按区块划分（样式 / 小组件 / 设置页 / hero / 侧边栏 / 挂载），
每块有注释标注。想找东西先搜区块注释。

**`src/Log/index.mjs` 的 `reload` 是死代码。**
但 `Log/API.md` 和 `README.md` 里写着它。删之前先确认没人按文档调用。

---

## 怎么验

```bash
npm test                    # 全套：插件 90+ 项 + 真机验证
node tools/check-deps.mjs   # 双向依赖 + 未使用导出
node tools/verify-summary.mjs  # 单独验"上下文压力读得到"
```

`npm test` 最后一步是**真机验证**（起真 cordis 挂插件），
不是纯单测 —— 因为有过"单测绿、功能瞎"的教训（`MODEL.md` 五）。
