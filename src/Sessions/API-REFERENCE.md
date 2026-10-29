# Sessions · API 参考

> → 这份是**查签名用的参考资料**：导出什么、参数和返回、回调什么时候触发、失败报什么错。模块整体说明去 [`README.md`](README.md)。

> 一句话：**扫出活着的会话，登记进 `sessions.json`；拿不准就多露、就多记，绝不静默。**

```js
// ⚠️ Windows 上 ESM 不许用 'D:/xxx' 绝对路径（ERR_UNSUPPORTED_ESM_URL_SCHEME），要 file:/// 前缀
import { scan, register, watch, getRegistry, isEnabled } from 'file://<仓库根>/src/Sessions/index.mjs'
```

---

## 一、导出什么

### `scan(ctx, opts?) → Promise<ScannedRegistry>`

扫一次。**不读旧表、不写盘**，纯取数。

| 参数 | 必填 | 说明 |
|---|---|---|
| `ctx` | ✓ | DSH 宿主上下文，用到 `ctx.agents.list()` / `ctx.sessions.get()` / `ctx.sessionTitle.get()` / `ctx.get('workspaceRegistry')` |
| `opts.now` | | `Date` / 时间串 / 时间戳。**测试用**，假装现在几点（决定 `lastSeen` 和 `updated`） |
| `opts.workspacePath` | | 归档名单兜底文件路径，默认 `$DSH_HOME/storages/workspace.json`（`$DSH_HOME` 缺省为 `~/.dsh`） |
| `opts.includeIds` | | 额外要塞进表的会话 id（补录/测试用） |
| `opts.onError` | | `(err: Error) => void`，出错回调，**不吞** |

返回：

```js
{
  version: 1,
  updated: '2026-10-27T21:20:00+08:00',
  archivedKnown: true,          // 归档名单到底拿到没有
  archivedSource: 'service',    // 'service' | 'file' | null
  sessions: {
    'bili-whale': { name: '小鱼', firstSeen: '2026-10-27', lastSeen: '2026-10-27', archived: false, enabled: true }
  },
  errors: [],                   // 致命问题（扫不到 / 归档名单没有）
  notes: []                     // 不致命（名字取不到、服务坏了走兜底）
}
```

`scan` 不抛异常：`ctx` 是空的、`agents.list()` 炸了，都变成 `errors` + `onError`，返回空表。

### `register(ctx, opts?) → Promise<Registry>`

日常跑这个：**扫 + 合并 + 落盘**。参数同 `scan`，另有：

| 参数 | 说明 |
|---|---|
| `opts.registryPath` | 登记表路径，默认 `<项目根>/memory/system/sessions.json`（旧位置 `memory/shared/sessions.json` 只有在新位置还没建、它还有数据时才认） |
| `opts.onDiscover` | `(sid, info) => void`，**新会话**回调 |

返回写后的登记表（结构见第三节），另带：

```js
{
  ...registry,
  discovered: ['session-a1b2'],  // 这次新发现的
  missing: ['old-session'],       // 表里有、这次没扫到的
  wrote: true,                    // 有没有写进去
  reason: undefined,              // wrote=false 时：'version-too-new' | 'unreadable' | 'scan-empty'
  path: '.../sessions.json',
  backupPath: null,               // 重建时坏文件的备份路径
  errors: [], notes: []
}
```

### `watch(ctx, opts?) → () => void`

**2026-10-28 加。没有它，登记表会一直是空的。**

`register` 只在被调用的那一刻扫一次。插件在 `apply` 里调它，而 `apply` 跑在 DSH **启动那一瞬间** —— 那时一个会话都还没有，扫出来必然是空表，而且之后再没人扫过。真机现象就是：插件全绿、设置页「登记表」一片空白。

`watch` 盯着宿主，有会话冒出来就补扫一遍（内部就是调 `register`，合并写盘）：

| 监听 | 什么时候 | 为什么 |
|---|---|---|
| `session/created` | 会话发布（新建 / 恢复 / 分叉） | 主路径 |
| `agent/created` | agent 起来 | 老宿主可能只发这个 |
| `session/event` | **表里还没有**这条会话的第一条事件 | 兜底：插件比会话晚就绪时自愈 |

- 多次触发会合并：`opts.delay` 毫秒（默认 30）内只扫一次；`timer.unref()`，不拖住进程
- 写盘失败只走 `onError`，不抛
- 返回 `unwatch()`，幂等；插件把它塞进 `dispose` 链

```js
const off = watch(ctx, { registryPath, onError })
// ... 卸载时
off()
```

### `getRegistry(opts?) → Registry`

读当前登记表，**不扫**。参数是路径字符串或 `{ registryPath, onError }`。

返回登记表对象 + `health` / `path` / `error`：

| `health` | 含义 |
|---|---|
| `ok` | 读到了，能用 |
| `missing` | 文件不存在（第一次跑，正常） |
| `corrupt` | 文件在但内容不认（`register` 会备份后重建；`getRegistry` 只读不管） |
| `future` | `version` 比 1 新，**本模块不许覆盖** |
| `unreadable` | 文件在但读不动（权限/占用） |

### `isEnabled(sid, opts?) → boolean`

这个会话要不要记日志。**1 号来问的就是这句。**

- 表里写 `archived: true` → `false`
- 表里 `enabled: false` → `false`
- **表里没这个会话 → `true`**（新会话默认开，等下次 `register` 才落成一行）
- **表坏了 / 读不动 / 版本太新 → `true`**（宁可多记，不许漏记）

> 这是**建议值**。调用方要不要再和自己的配置取交集，是调用方的事（1 号的 `config.json` 里有 `defaults.log`）。

---

## 二、回调什么时候触发

| 回调 | 什么时候 | 几次 |
|---|---|---|
| `onError` | ① 活会话扫不到（`ctx` 空 / `agents.list()` 抛错 / 返回不是数组）<br>② **归档名单两条路都拿不到**<br>③ 登记表坏了（重建时）<br>④ 登记表读不动 / 版本太新（没写）<br>⑤ **这次一个会话都没扫到、但表里原有数据**（`scan-empty`，没写）<br>⑥ 写盘失败<br>⑦ `onDiscover` 自己抛错 | 每类失败**一次**，聚合消息；同一次 `scan` 里归档那类只叫一次 |
| `onDiscover` | `register` 合并时，**表里原来没有**这个会话。`missing` 的行重新出现**不算**新会话 | 每个新会话一次，在写盘**之前** |

回调抛错不影响主流程（内部 `try` 住了，只记不计）。`onError` **不会**为这些叫：名字取不到、服务坏了但文件兜底成功 —— 那些进 `notes`。

---

## 三、登记表格式（`version: 1`）

```json
{
  "version": 1,
  "updated": "2026-10-27T21:20:00+08:00",
  "archivedKnown": true,
  "sessions": {
    "bili-whale": {
      "name": "小鱼",
      "firstSeen": "2026-10-20",
      "lastSeen": "2026-10-27",
      "archived": false,
      "enabled": true
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `version` | 固定 1。改结构要升，并且 `readRegistry` 会拒绝更旧的代码覆盖它 |
| `updated` | 本次扫描时间，本地时区 ISO8601 带偏移 |
| `archivedKnown` | **归档名单到底拿到没有**。`false` = 每个 `archived` 值都不可信 |
| `firstSeen` | 第一次见到。**之后永不改** |
| `lastSeen` | 每次扫到就更新 |
| `archived` | 归档了 = `true`（数据留着，不再记日志） |
| `enabled` | 要不要记日志。归档的自动 `false` |
| `missing` | 只在「表里有、这次没扫到」时出现。**不删行**，人再判 |

**合并规则**（`registry.mjs: mergeScanned`）：

1. 老会话：保留 `firstSeen`，更新 `lastSeen` / `name` / `archived`
2. 新会话：加进去，`firstSeen` = 今天，回调 `onDiscover`
3. 表里有、这次没扫到：**不删**，标 `missing: true`；再出现时把 `missing` 去掉
4. `archivedKnown: false` 时：**不许**拿「没归档」去覆盖，`archived` / `enabled` 全保留原值；新行给 `archived: false` + `enabled: true`（宁可多露）
5. `enabled = !archived`，只在 `archivedKnown: true` 时执行

---

## 四、失败时怎么表现

| 情况 | 表现 | 会不会污染别人 |
|---|---|---|
| `ctx` 是空的 / 扫到 0 个，**表里原来有数据** | **拒绝写入**，返回 `wrote: false, reason: 'scan-empty'` + `onError` 一次，原表一个字节不动 | 不会。这条是 2026-10-27 的教训：一张空表把 98 行盖掉了 |
| `ctx` 是空的 / 扫到 0 个，表**本来就是空的** | 照常写空表（无害，只刷了个 `updated`） | 不会 |
| `agents.list()` 抛错 | 同上 | 同上 |
| 名字取不到 / 标题服务抛错 | `name: ''`，进 `notes`，**不算错** | 不会 |
| 服务没给 `workspaceRegistry` | 走文件兜底，成功就不报警，进 `notes` | 不会 |
| **两条路都拿不到归档名单** | `archivedKnown: false`，全员当没归档（`enabled: true`），`onError` **必叫一次** | 不会。下游看到 `archivedKnown: false` 应自己决定信不信 |
| 登记表是垃圾 / 0 字节 / 不是对象 | **先备份成 `sessions.json.bak-YYYYMMDD-HHmmss`**，再按空表重建，`onError` 叫一次 | 不会。旧表备份还在 |
| 登记表 `version > 1` | **不写、不覆盖**，返回 `wrote: false, reason: 'version-too-new'` | 不会，文件一个字节不动 |
| 登记表读不动（权限/占用） | **不写**，返回 `wrote: false, reason: 'unreadable'` | 不会。**绝不把读不到的表当空表覆盖** |
| 写盘失败 | `wrote: false` + `onError`，返回合并结果（内存里那份是对的） | 不会。先写 `.tmp` 再 rename，不留半张表 |
| `onDiscover` 抛错 | 记 `onError`，继续合并其他会话 | 不会 |

**唯一会「丢东西」的操作是备份重建**，而且坏文件一定先备份。

---

## 五、不在了会怎样

删掉 `modules/Sessions/` 就等于卸载。DSH 照常跑，**但 1 号的日志失去「该记谁」的依据**。

| 谁 | 影响 |
|---|---|
| **Log（1 号）** | `isEnabled()` 拿不到 → 它会退化成**只按自己的 `config.json`**（`sessions.<id>.log` / `defaults.log`）。本模块在时是「登记表说了算」，不在时是「配置说了算」 |
| **Log 的新会话** | **不会自动开始记**。1 号配置里没写的会话就记不了 —— 这是卸载本模块**最实际的损失** |
| **Daily / Search / Inject / Store** | **照常**。它们不读 `sessions.json` |
| **`sessions.json`** | 文件留着不动。重新装回来直接接着用（`firstSeen` 不会丢） |
| **归档名单** | 没人维护了。1 号的日志会继续记归档会话（多记，不丢） |

**它缺席时不会「全都不记」，也不会崩**：`sessions.json` 还在原地，只是没人更新它。

---

## 六、依赖与边界

- 只读：DSH 运行时（`ctx`）、`workspace.json`
- 只写：`sessions.json`（+ 坏文件的 `.bak-*`、写盘中途的 `.tmp`）
- **不碰**：日志、日记、对象文件、`MEMORY.md`
- **不 import 任何别的模块目录**。`session-` 前缀比对、时间格式化这类小工具都是本目录内自带，宁可复制二十行
- 无第三方依赖，Node ≥ 20
