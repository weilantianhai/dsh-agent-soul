# Log · API 参考

> → 这份是**查签名用的参考资料**：导出什么、参数和返回、回调什么时候触发、失败报什么错。模块整体说明去 [`README.md`](README.md)。

> **一句话定位**：DSH 会话事件 → 当天 jsonl。**只写 `logs/`，别的一概不碰。**

---

## 一、导出什么

```js
// Windows 上 ESM 的绝对路径必须带 file:/// 前缀，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
import { start, stop, status, handle, reload } from 'file://<仓库根>/src/Log/index.mjs'
```

### `start(opts) → Promise<{ running, reason? }>`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `opts.ctx` | object | 否 | DSH 宿主上下文。有 `ctx.on` 就自动挂 `session/event`。不传则钩子不挂，需自己调 `handle` |
| `opts.configPath` | string | 否 | 配置文件路径。默认模块目录下的 `config.json` |
| `opts.onWrite` | `(record) => void` | 否 | 每**真写进一行**回调一次（判重跳过的不算） |
| `opts.onError` | `(err) => void` | 否 | 出错回调。**不会替你吞**，也不影响已写的行 |

- 返回 `{ running: true }` 表示在跑。
- `enabled: false` 时返回 `{ running: false, reason: 'disabled' }`，**不抛异常**。
- `ctx` 挂不上时返回 `{ running: false, reason: 'attach-failed' }`，同时调 `onError`。
- 重复 `start` 会先 `stop` 再起，不会出现两个监听。

`record` 的形状（`onWrite` 收到的东西）：

```json
{
  "sessionId": "bili-whale",
  "role": "tianhai",
  "text": "小鱼小鱼我们继续",
  "seq": 8812,
  "t": "2026-10-27T20:11:03+08:00",
  "path": "D:/ProgramData/dsh/memory/sessions/bili-whale/logs/2026-10-27.jsonl",
  "date": "2026-10-27"
}
```

### `stop() → Promise<status对象>`

解绑事件、收尾。**立即落盘策略下没有缓冲**，所以不存在"还有半条没写"。

### `status() → object`

```js
{
  running: true,          // 在跑吗
  attached: true,         // 钩子挂上了吗（用 handle 手动喂时是 false）
  sessions: ['bili-whale'],// 记过话的会话
  written: 128,           // 写进去的条数
  skipped: 7,             // 没写的条数
  reasons: { interrupted: 1, 'not-configured': 6 }, // 没写的原因分布
  seen: 135,              // 收到的事件数
  duplicates: 0,
  failed: 0,
  configPath: '...',
  startedAt: '2026-10-27T20:00:00+08:00',
  lastError: null
}
```

### `handle(session, event) → void`

给宿主自己接线用（不走 `ctx`）。没 `start` 过就是空转，不会报错。

```js
ctx.on('session/event', (session, event) => log.handle(session, event))
```

### `reload(opts) → Promise<...>`

等同 `start(opts)`（会先停）。改完 `config.json` 不用重启进程，但**要自己再传一次 `ctx`**。

---

## 二、回调时机

| 回调 | 什么时候触发 | 触发几次 |
|---|---|---|
| `onWrite` | 一行**真的写进文件之后**（`writeSync` 已返回，`close` 已完成） | 每条一次。判重跳过的不触发 |
| `onError` | ① 配置文件读不了／不是合法 JSON<br>② 写文件失败（磁盘、权限）<br>③ 挂 `ctx` 失败<br>④ 你的 `onWrite` 自己抛了异常 | 每个错误一次 |

**`onWrite` 是给人接的**：别的模块要日志，接这里，别去读文件。这样我哪天被卸载，你只是收不到，不会崩。

`onWrite` 里抛异常不会影响已经落盘的那一行（写和回调是分开的），异常会转去 `onError`。

---

## 三、失败时怎么表现

| 情况 | 表现 |
|---|---|
| 配置不存在 | 用兜底配置（什么都不记），`status().lastError` 说明原因，**不崩** |
| 配置不是合法 JSON | 调 `onError`，退回兜底配置，`running: false`，**不崩** |
| `enabled: false` | 不挂钩子，`running: false`，不报错（这是正常状态，不是故障） |
| 日志目录不存在 | 自动 `mkdir -p`，照写 |
| 目录建不出来／磁盘满 | 这条不写，`onError` 收到一次，`status().failed + 1`，**已有内容不受影响**（只 append） |
| 事件里没有 `seq` | 照写，`seq: null`；判重改用 `t+role+text` 指纹（同一秒说两遍同样的话会被当成重复，可接受） |
| 事件里没有时间 | 用当前时间 |
| 事件结构不认识 | 静默跳过（计入 `reasons`），**绝不抛回宿主** |
| jsonl 里有坏行 | 读判重集合时跳过该行，**不修、不删、不覆盖** |

**任何情况下 `handle`／事件回调都不会把异常抛给 DSH 宿主**——上游崩了不能是我崩的。

---

## 四、不在了会怎样（上游怎么降级）

删掉 `modules/Log/` 就等于卸载。此时：

- **日记（Daily）停** —— 它读 `logs/`，没有新日志就写不出新日记（旧日志还在，能补写旧日期）。
- **检索（Search）只剩历史** —— 索引到最后一篇为止，不再增长。
- **账本（Store）、注入（Inject）照常** —— 它们只碰对象文件和 `MEMORY.md`，不依赖我。
- **会话本身照常** —— 我只是旁听，不参与对话；DSH 不知道自己少了个监听。

兜底路：钩子没收到的东西，还能从会话文件 `session.v4.jsonl.zstd` 多帧解压补录。**补录器不在本模块里**，本模块只保证"钩子在的时候不漏"。

---

## 五、配置（`config.json`）

```json
{
  "enabled": true,
  "baseDir": "D:/ProgramData/dsh/memory/sessions",
  "logsSubdir": "logs",
  "selfName": "xiaoyu",
  "ownerMid": "<你的 QQ 号>",
  "ownerName": "tianhai",
  "defaultRole": "tianhai",
  "sessions": {
    "bili-whale": { "log": true, "selfName": "xiaoyu", "dir": "D:/ProgramData/dsh/memory/sessions/bili-whale/logs" }
  },
  "defaults": { "log": false }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关。`false` = 整个模块睡觉，不报错 |
| `baseDir` | 没给 `dir` 时，按 `baseDir/<会话id>/<logsSubdir>` 拼路径 |
| `selfName` | 助手输出的默认 role 名（会话里可单独覆盖）。**不写死在小鱼身上** |
| `ownerMid` / `ownerName` | 主人的 mid → role 名 |
| `defaultRole` | 认不出说话人时用什么 role。桌面端单人会话设为 `tianhai`；多用户场景请设成 `user:unknown`，别让人冒充主人 |
| `sessions.<id>.log` | 这个会话记不记。不在表里的按 `defaults.log` |
| `sessions.<id>.dir` | 这个会话写哪。优先级最高 |
| `defaults.log` | 没登记过的会话默认记不记（默认 `false`） |
