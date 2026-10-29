# Inject · API 参考

> → 这份是**查签名用的参考资料**：导出什么、参数和返回、回调什么时候触发、失败报什么错。模块整体说明去 [`README.md`](README.md)。

> 一句话：**每轮开场，把该让她知道的东西塞进系统提示。只三段，多一段都不给。**

```js
// ⚠️ Windows 上 ESM 绝对路径必须带 file:///，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
import { register, buildInjection, status } from 'file://<仓库根>/src/Inject/index.mjs'
```

---

## 一、导出什么

### `register(ctx, opts) → () => void`

挂钩子，返回一个 **dispose 函数**（解绑用）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `ctx` | ✓ | DSH 宿主上下文，要能 `ctx.on`。没有就抛错（配置错要立刻炸，不能静默） |
| `opts.configPath` | | 配置文件路径，默认模块目录下的 `config.json` |
| `opts.config` | | 直接给一份配置对象（测试用，优先于 configPath） |
| `opts.onError` | | `(err: Error) => void`，**不吞** |

挂的事件：`system-prompt/assemble`。

```js
const dispose = register(ctx, { onError: (e) => console.warn('[inject]', e.message) })
// 卸载时
dispose()
```

### `buildInjection(context, opts) → Promise<Result>`

**只拼不塞**，不用起 DSH 就能调（测试、预览、手动排查都靠它）。

| 参数 | 说明 |
|---|---|
| `context` | DSH 的 assemble context，只用到 `context.agent.session` |
| `opts.config` / `opts.configPath` | 配置。都不给就用上次 `register` 的，再没有就读默认文件 |
| `opts.onError` | 出错回调 |

返回：

```js
{
  text: '拼好的整段（要 push 进 sections 的就是它，没内容时是空串）',
  sections: [{ name: 'persona', chars: 654, from: '…/人格.md' }],
  chars: 1119,          // 实际字数
  agentId: 'xiaoyu',
  agentSource: 'agents.json',  // agents.json | sessions.json:name | config.fallbackAgent
  sessionId: 'bili-whale',
  cuts: [],             // 超预算砍了什么
  over: false,          // 砍完还超（路标不砍时的极端情况）
  disabled: true        // enabled:false 时才有这个字段
}
```

### `status() → object`

```js
{ enabled, lastChars, lastSections, lastAgentId, lastAt, lastError, injected }
```

任务单要的三个字段（`enabled` / `lastChars` / `lastSections`）都在，其余是排查用的。

### `reset()`

测试用：把运行态清干净。生产代码别调。

---

## 二、回调时机

只有一个回调 `onError`，在下面这些时候触发（**每次都触发，绝不静默**）：

| 时机 | 报什么 |
|---|---|
| 配置文件不存在／不是合法 JSON | `配置文件读不了（…）`，并降级成 `enabled:false` |
| `context.agent.session` 拿不到 | `拿不到 context.agent.session，这一轮不注入（不猜）` |
| 会话找不到对应的 agent 目录 | `会话 xxx 找不到对应的 agent 目录…` |
| agent 存在但没人格文件 | `agent xxx 没人格文件…这一段不塞` |
| 超预算砍了东西 | 每砍一刀报一条：`注入超预算：<砍了什么>` |
| 拼装过程中抛异常 | 原样报出来 |

**没有日记不报错**（那是正常状态，不是故障）。

---

## 三、失败时怎么表现

| 情况 | 表现 |
|---|---|
| `enabled: false` | 不塞、不报错，**把 `next()` 给的对象原样交回去**（同一个引用，不是新建） |
| 配置坏了 | 降级成"关掉"，报一次，不影响对话 |
| 拿不到会话／找不到 agent | 这一段不塞 **任何东西**，报一次；对话照常 |
| 没有人格文件 | 不塞人格段（**绝不猜一个顶上去**），报一次；日记和路标照常 |
| 没有日记 | 不塞日记段，**不报错** |
| 超预算 | 按顺序砍（日记→人格→日记整段→硬截人格），**路标永远不砍**，每刀报一次 |
| 拼装里抛异常 | 捕获，报出来，返回 `assembled`；**对话不受影响** |
| `next()` 自己抛 | 不捕获（那是上游的事，不该我兜） |

**红线：所有路径都从 `agents/<当前 agent>/` 出发，绝不拼别人的目录。** 小汐的一个字都不许出现在小鱼的上下文里，这条有测试（第 8 条）盯着。

---

## 四、不在了会怎样

**注入器卸载后，她还会正常说话，但会忘事。**

- **人格**靠 DSH 那份 `AGENTS.md` 撑着 —— 还能是她，只是不会每轮被提醒"红线是什么"
- **日记总结没了** —— 她不会自动知道"昨天聊到哪"，得自己想起来去翻文件（翻得到，只是不会主动翻）
- **路标没了** —— 没人告诉她"你的记忆在哪、去翻 INDEX.md"，她会更容易凭印象说话
- **别人不受影响** —— 日志照收（Log）、登记表照写（Sessions）、账本照读（Store），它们不依赖我
- **对话不受影响** —— 我崩了、被删了，DSH 该说说，只是少一段上下文

一句话：**删掉我是"降级"，不是"故障"。**

---

## 五、配置（`config.json`）

```json
{
  "enabled": true,
  "budget": { "total": 2500, "persona": 1500, "diary": 800, "signpost": 200 },
  "sections": { "persona": true, "diarySummary": true, "signpost": true },
  "persona": { "includeFirstSection": true },
  "rootDir": "D:/ProgramData/dsh/memory",
  "fallbackAgent": null
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关。`false` = 一个字不塞，不报错 |
| `budget.*` | 各段上限 + 合计上限 |
| `sections.*` | 三段各能单独关，关一段不影响别的 |
| `persona.includeFirstSection` | 人格摘要要不要带上「一、你是谁」。默认 true（见 README 的说明） |
| `rootDir` | 记忆库根目录 |
| `fallbackAgent` | 找不到归属时兜底用哪个 agent 目录。**默认 null：不猜** |
