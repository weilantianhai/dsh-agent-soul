# Inject —— 每轮开场，把该记得的塞进上下文

> → 这份讲**怎么用**：模块干什么、怎么跑、怎么验、硬边界在哪。查函数签名去 [`API-REFERENCE.md`](API-REFERENCE.md)。

> 一行字：**每轮回答一个问题——"现在说话的这个人，该记得什么？"——然后把答案推进系统提示。只有三段。**

```
system-prompt/assemble → [找 agent] → [人格摘要 + 日记总结 + 路标] → [预算] → sections.push
```

**它是整个插件的第 2 块地基。** 不管记忆存得多好，不推进上下文，
agent 一样一个字都想不起来 —— 那就是"读过日记的我"和"经历过的我"的区别。

---

## 这模块干嘛

会话一压缩，她就忘了昨天聊到哪、自己是什么脾气。所以每轮开场补三样：

| 段 | 内容 | 从哪来 |
|---|---|---|
| **人格摘要** | 开头那段 + 「一、你是谁」+ **红线那一节** | `agents/<id>/人格.md` |
| **日记总结** | 最近一篇日记的最新一节 | `agents/<id>/diary/<会话>/` |
| **路标** | 一句话：你的记忆在哪、先去翻 `INDEX.md` | 写死的字，目录跟着 agent 走 |

**故意不给的**：人格全文（233 行塞每轮会把人定死）、日记正文、别人的任何东西（红线）。

---

## 怎么跑

```js
// ⚠️ Windows 上 ESM 绝对路径要带 file:///（ERR_UNSUPPORTED_ESM_URL_SCHEME）
import { register } from 'file://<仓库根>/src/Inject/index.mjs'

const dispose = register(ctx, { onError: (e) => console.warn('[inject]', e.message) })
```

只想看看会塞什么（不碰宿主）：

```js
import { buildInjection } from 'file://<仓库根>/src/Inject/index.mjs'
const out = await buildInjection({ agent: { session: { id: 'bili-whale' } } })
console.log(out.chars, out.text)
```

---

## 怎么验

```bash
cd <仓库根>/src/Inject && node test/run.js
```

18 条：12 条任务单验收 + 6 条附加（空 context、单文件日记形态、只关一段、砍日记保路标、预算函数本身、字面模式）。全绿才算完，有红就 `exit 1`。

测试全在系统 temp 里造假记忆库，**不碰真数据**。

---

## 你不在了谁受影响

**注入器卸载后，她还会正常说话，但会忘事。**

- 人格靠 DSH 的 `AGENTS.md` 撑着，只是不再每轮被提醒红线
- 日记总结没了 → 不会自动知道"昨天聊到哪"
- 路标没了 → 更容易凭印象说话
- Log / Sessions / Store 照常，对话照常

**删掉我是降级，不是故障。**

---

## 三个跟任务单不一样的地方（都报备了）

### 1. 红线在 §十二，不在 §九

任务单写「九、红线」，但实际 `人格.md` 里 §九 是「对外怎么提 tianhai」，红线是 **§十二**。
所以红线按**标题关键字**找（`/红线/`），不按编号找 —— 以后再挪位置也不会失效。

### 2. 人格摘要多带了「一、你是谁」

任务单说只取「第一个 `---` 之前」。实际那个位置只有标题 + 三行引言，**连"你是小鱼"都没有**，注入就白注入了。
所以默认再带第一个正文章节（§一）。`persona.includeFirstSection: false` 可以退回字面行为，两种都有测试。

### 3. 日记的现实形态不是 `YYYY-MM-DD.md + ## 总结`

现在是 `公开日记.md` / `私房日记.md`，里面是一串日期小节。所以：
1. 先按任务单的形态找（`diary/<会话>/YYYY-MM-DD.md` 的 `## 总结`，取最近一天）
2. 找不到，再找**标题里带日期的最新那一节**
3. 都没有 → 不塞，不报错

两种形态都有测试（第 6 条 / 第 14 条）。

---

## 还有一个前提没到位

**`memory/private/agents.json` 不存在。** 归属表是"人定"的，我不该替人写。

现在解析顺序是：`agents.json` → `sessions.json` 的 `name` 恰好等于目录名 → 配置里的 `fallbackAgent` → 报错。

而 `sessions.json` 里 `name` 记的是「小鱼」，目录叫 `xiaoyu` —— 对不上。所以**在归属表建好之前，真实环境只能靠 `fallbackAgent` 兜**。

要跑通，建 `memory/private/agents.json`：

```json
{ "bili-whale": "xiaoyu" }
```

这行我不会自己写，等人点头。
