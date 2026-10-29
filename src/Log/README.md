# Log —— 把「人话」实时写进当天日志

> → 这份讲**怎么用**：模块干什么、怎么跑、怎么验、硬边界在哪。查函数签名去 [`API-REFERENCE.md`](API-REFERENCE.md)。

> 一行字：**旁听会话，把人说的话原样落盘，不判断、不摘要、不改字。**

```
DSH 事件  →  [过滤]  →  [落盘]  →  memory/sessions/<会话>/logs/YYYY-MM-DD.jsonl
```

**它是整个插件的第 1 块地基。** 没有日志，日记就没稿子可读 ——
agent 只能凭印象说"我记得"，那就是编。

---

## 怎么跑

```js
// ⚠️ Windows 上 ESM 不许用 'D:/xxx' 这种绝对路径（会报 ERR_UNSUPPORTED_ESM_URL_SCHEME），
//    要么写 file:/// 前缀，要么从相对路径 import。
import { start, stop, status } from 'file://<仓库根>/src/Log/index.mjs'

await start({ ctx })                 // ctx 来自 DSH 宿主，要能 ctx.on
console.log(status())                // { running: true, written: 0, ... }

// 收工
await stop()
```

没 `ctx` 也能用（测试、补录、单跑）：

```js
await start({ configPath: 'D:/xxx/test-config.json' })
const { handle } = await import('file://<仓库根>/src/Log/index.mjs')
handle(session, event)               // 自己把事件往里塞
```

想看它写出来的东西：

```bash
tail -f "D:/ProgramData/dsh/memory/sessions/bili-whale/logs/$(date +%F).jsonl"
```

---

## 怎么验

```bash
cd <仓库根>/src/Log && node test/run.js
```

13 条：9 条是任务单的验收项，4 条是我自己加的（重启判重、坏配置、换行转义、真实 DSH 包装形态）。
**全绿才算完。** 有一条红就 `exit 1`，不会假装通过。

测试全部写在系统临时目录里，**不碰真日志**。

想看它到底记什么样，跑演示（同样在 temp 里，不污染）：

```bash
cd <仓库根>/src/Log && node test/demo.mjs
```

喂 10 种形态的事件（真人消息、带壳消息、私信、生物钟、工具调用、被打断、重放、陌生会话、跨零点），
直接打印落盘原文 + 每种被丢掉的原因。

---

## 三条硬边界

1. **只读事件，不碰会话文件。** 我没有写会话、没有解压、没有补录。
2. **只写 `logs/`。** 别的地方一个字节都不动。
3. **不判断"哪句重要"。** 全部原样落；重要不重要是 Store/Search 的事，不是我的。

---

## 不在了会怎样

删掉这个文件夹就等于卸载，DSH 照常跑（我只是旁听）。

- 日记会停：`Daily` 读 `logs/`，没有新日志就写不出新日记（旧日志还在，能补写旧日期）。
- 检索只剩历史，账本和注入照常——它们不依赖我。
- 兜底路还在：会话文件 `session.v4.jsonl.zstd` 可以事后多帧解压补录，**但补录器不在这个模块里**。

---

## 几个想清楚了的地方

**1. 先脱壳，再判空。**
任务单表格里写「以 `<system-reminder>` 开头 → 整条丢」。照字面做，第一条真消息就没了——
真实形态是：

```
<system-reminder ...>AGENTS.md / 时间 / 身份</system-reminder>
<user_query>好的，那我们继续搭</user_query>
```

正文在壳里。所以顺序改成：先把壳整块挖掉、`<user_query>` 只脱标签，再看**剩下有没有正文**。
壳里空的才判为"整条是包装"。这条有测试（第 13 条）盯着。

**2. 助手侧一个字都不洗。**
降噪只对用户侧做（宿主爱往用户消息里塞东西）。小鱼说的话原样落，包括 markdown 和代码块。

**3. 判重从文件里读回来。**
内存里的 seq 集合第一次碰某个文件时，会把已有的 seq 读进来。所以进程重启之后，同一个 seq 也不会写第二遍。

**4. 每条写完立刻 close。**
不攒批。崩了就崩在两条之间，不会丢已经写过的。

**5. `defaultRole` 是配置项，不是代码里的默认值。**
桌面端单人会话设成 `tianhai`；哪天多用户了，改配置成 `user:unknown`，别让人冒充主人。

---

## 目录

```
modules/Log/
├── package.json
├── config.json       # 现场配置（改这里，别改代码）
├── index.mjs         # 入口：start / stop / status / handle / reload
├── hook.mjs          # 事件监听 + 过滤 + 剔包装
├── writer.mjs        # 写文件（追加 + 判重 + 建目录）
├── API.md            # 接口、回调时机、失败表现、卸载影响
├── README.md         # 这份
└── test/
    ├── run.js        # 验收入口
    ├── helpers.mjs   # 测试小工具（假 ctx、临时目录）
    ├── hook.test.mjs
    └── writer.test.mjs
```

`modules/Log/` 之外什么都不 import，别的模块目录一行都不碰。
