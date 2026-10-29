# Sessions —— 扫出还活着的会话，记进登记表

> → 这份讲**怎么用**：模块干什么、怎么跑、怎么验、硬边界在哪。查函数签名去 [`API-REFERENCE.md`](API-REFERENCE.md)。

> 一句话：**扫出 DSH 里还活着的会话，记进一张登记表。不判断、不隐藏、不删行。**

```
DSH 运行时 → [扫活会话] → [查归档名单] → [合并进旧表] → memory/system/sessions.json
```

---

## 这模块干嘛

小鱼的日记和 1 号的日志都得知道「现在有哪些会话」。会话 id 从哪儿来？哪儿归档了不该再记？归谁管？

本模块就干这一件：把答案写进 `memory/system/sessions.json`，别人来查。

- **主路是运行时**：`ctx.agents.list()` 里活着的 agent，`ctx.get('workspaceRegistry')` 里的归档名单
- **兜底是文件**：服务拿不到就自己读 `~/.dsh/storages/workspace.json`（同一份数据，格式稳）
- **两条都拿不到**：`archivedKnown: false` + 报警。**不许静默当成「没有归档」**

---

## 怎么跑

```js
// ⚠️ Windows 上 ESM 不许用 'D:/xxx' 绝对路径（ERR_UNSUPPORTED_ESM_URL_SCHEME），要 file:/// 前缀
import { register, isEnabled } from 'file://<仓库根>/src/Sessions/index.mjs'

const r = await register(ctx, { onError: (e) => console.error('[Sessions]', e.message) })
console.log(r.sessions)            // { 'bili-whale': { name: '小鱼', enabled: true, ... } }
console.log(r.discovered, r.missing)

isEnabled('bili-whale')            // true / false
```

**本模块不建定时器。** 谁想让它跑，谁调 `register(ctx)`：会话起来时调一次、或宿主每 10 分钟调一次都行。不常驻，是故意的 —— 少一个自己转的东西，就少一处半夜出事的地方。

只读、不写盘：

```js
const reg = await scan(ctx)        // 只看这一轮扫到什么，不动 sessions.json
const now = getRegistry()          // 只看表现在长什么样
```

---

## 登记表放哪（位置变过，这里说明下）

**`memory/system/sessions.json`** —— 「机器维护、agent 不直接读」那一层。v4 之前它在 `memory/shared/`，2026-10-27 21:46 目录改版后搬到了 `system/`。

代码怎么认：

1. `memory/system/sessions.json` 有 → 用它
2. 没有、但旧的 `memory/shared/sessions.json` 有 → **认旧的**（免得表分裂成两份）
3. 两个都没有 → 按新位置建

---

## 谁让它跑

**它不自己跑。** 没有 `plugin.mjs`、没有 `apply(ctx)`、没有定时器 —— 2026-10-27 tianhai 定：**要表就调接口**。

- 真接上 DSH 的话，得有个宿主插件在 `apply(ctx)` 里调 `register(ctx)`
- 或者谁要表谁调一次：`await register(ctx)`（一次约几十毫秒，只动一个 json）
- 本模块**只提供接口**，怎么触发是调用方的事

> 顺带一句：`ctx.agents.list()` 只给「当前挂着的 agent」，不是磁盘上所有历史会话。这是对的 —— Sessions 管的是**活着的会话**，不是抄历史档案。

---

## 怎么验

```bash
cd <仓库根>/src/Sessions && node test/run.js
```

19 条：**10 条任务单验收 + 9 条附加**（ctx 全空、服务坏但文件在、`session-` 前缀、`agents.list` 抛错、`isEnabled` 三种情况、版本比我新、归档名单不可信时不许冲掉原状态、默认路径不许写回 shared、**扫到 0 个不许覆盖**）。

有红就 `exit 1`，还会检查「10 条验收项一条都没少」。测试全跑在系统 temp 里，**不碰真登记表**。

第 4 条（不许静默）是这套里最要紧的一条：归档名单拿不到时 `onError` 必须被叫，而且**只叫一次**。

---

## 你不在了谁受影响

删掉 `modules/Sessions/` 就等于卸载。

| 谁 | 影响 |
|---|---|
| **Log（1 号）** | 失去「该记谁」的依据，退化成只按它自己的 `config.json` 走。**新会话不会自动开始记** —— 这是最实际的损失 |
| 日志本身 | 不停。旧表还在 `sessions.json` 里，1 号读得到 |
| **Daily / Search / Inject / Store** | **照常**，它们不读这张表 |
| 归档的会话 | 没人标了，1 号会继续记（多记，不丢） |
| 会话本身 | 照常。它不参与对话 |

重新装回来直接接着用，`firstSeen` 不会丢（表在 `memory/` 里，不在模块目录）。

---

## 五条硬边界

1. **只写 `sessions.json`**（+ 坏文件的 `.bak-*`、写盘中途的 `.tmp`），别的一个字节不动
2. **不碰日志、不碰日记、不碰对象文件** —— 那是 1 号、小鱼、3 号的地盘
3. **不许删会话行**。这次没扫到只标 `missing: true`，人再判
4. **不许静默**。拿不到就说拿不到（`archivedKnown: false`）、出错就报（`onError`）
5. **不许拿空表盖掉有数据的表**。扫到 0 个 + 表里原有东西 → 拒绝写入（`scan-empty`），原表一个字节不动

---

## 几个想清楚了的地方

**「拿不到」不等于「没有」。** `dsh-fish-memory` 踩过这个坑：`catch { return new Set() }`，读不到归档名单就当成没有归档，结果 11 条归档会话变成幽灵，一点痕迹都不留。这里把它拆成两件事：`known: false`（数据层面的不知道）+ `onError`（人层面的喊一声）。下游看到 `false` 可以自己决定信不信，但**不会被我们骗**。

**宁可多露，不可错藏。** 归档名单不可信时：全员当没归档、`enabled: true`。多记一段日志能删，漏记一段就永远没了。

**坏表先备份再重建。** 重建是唯一会「丢」东西的操作，所以坏文件一定先 `copyFileSync` 成 `sessions.json.bak-YYYYMMDD-HHmmss`，同名加序号，绝不覆盖旧备份。

**版本比我新就不写。** `version > 1` 说明以后改过结构。不认识的表**一个字节都别动**，返回 `wrote: false, reason: 'version-too-new'` —— 比「按空表重建」安全一万倍。

**读不动也不写。** 文件被占用、权限不对（`unreadable`），也**不写**。因为「读不到」和「是空表」在写的时候长得一模一样，一写就把别人的东西抹了。

**扫到 0 个不覆盖有数据的表。** 2026-10-27 的教训：离线扫盘那版有 98 行，换到没有运行时的环境一跑，扫出 0 个，空表就把 98 行盖了。防护原来只防了「版本太新 / 读不动 / 坏表」，**唯独没防「什么都没扫到」** —— 因为那看起来像一次正常的空结果。现在：`扫到 0 个 && 表里原有 > 0` → `wrote: false, reason: 'scan-empty'` + 报警。表本来就是空的才照常写（无害）。

**「坏」和「空」是两回事，但出事时长得像。** 所以三条都不写：坏表先备份再重建、读不动的表不写、扫不到东西不覆盖。

**`session-` 前缀两边都认。** 归档名单里写 `session-abc`，agent 上报 `abc`，直接比字符串会漏。比对时抹掉前缀再比一次（归档名单才 26 条，O(n) 无所谓）。这条是附加测试 13 守着的。

**`firstSeen` 永不改，`lastSeen` 每次刷。** 「这条会话我第一次见是什么时候」是一条历史事实，改了就再也查不回来了；`lastSeen` 只是现状。

**`enabled` 没有手动静音。** 现在 `enabled = !archived`，归档名单可信时每轮都重算。想手动关掉一个活着的会话，得另开字段（别偷偷改 `enabled`，下一轮就被刷回去了）。
