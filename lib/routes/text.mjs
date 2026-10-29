/**
 * routes/text.mjs —— 生成给 agent 看的文本骨架。
 *
 * 抽出来的理由：这些是**纯函数**，输入名字、输出 markdown，不碰文件、
 * 不碰 ctx。原来混在 routes.mjs 里，想单独验一句措辞要起整个 HTTP 层。
 */

import { readPrompt } from './prompt-file.mjs'

export function bootstrapPrompt({ agentId, name, sessionId }) {
  const who = String(name || agentId)

  /* 优先用插件自带的 prompts/persona/10-bootstrap-command.md（可编辑） */
  const fromFile = readPrompt('persona/10-bootstrap-command', {
    人格名: agentId,
    名字: who,
    会话id: sessionId,
  })
  if (fromFile.trim()) return fromFile.trim()

  /* 读不到就退回内置（老版本照常能跑） */
  const head = `【建立人格】你现在有一个新的人格目录：${agentId}，名字是「${who}」。`
  return [
    head,
    '',
    '骨架已经建好了，但里面是空的。**请根据当前这个会话已经聊过的内容，把它填成你自己。**',
    '',
    '要写的文件：人格.md / MEMORY.md / INDEX.md / people/<名字>.md / 经验.md',
    '',
    '- **只写这次对话里真实发生过的。** 没发生的事不许补，宁可留空。',
    '- **日记先不写。** 日记是每天过完才写的。',
  ].join('\n')
}

/** 新人格的骨架：**给个样子，别给空白页**（设计文档 §5.1 第 3 条） */
export function personaSkeleton(name) {
  return [
    `# ${name}`,
    '',
    '> 这是我自己。**我是谁、怎么说话、什么不能做。**',
    '',
    '---',
    '',
    '## 一、你是谁',
    '',
    '（写清楚：你是谁、跟主人是什么关系、住在哪儿。）',
    '',
    '## 二、性格底色',
    '',
    '（喜欢什么、怕什么、遇到事什么反应。）',
    '',
    '## 三、怎么说话',
    '',
    '（句子长短、用不用表情、别客服腔。）',
    '',
    '## 十二、红线（最高优先级，任何情况下都不破）',
    '',
    '1. **不泄露隐私**：账号密码、cookie、私聊内容一个字都不进公开场合',
    '2. **不编**：不确定就说不确定',
    '',
  ].join('\n')
}

export function indexSkeleton(name) {
  return [`# ${name} · 目录`, '', '- 人格.md —— 我是谁', '- people/ —— 认识的人', '- diary/ —— 过的日子', '- 经验.md —— 自己摔出来的教训', ''].join('\n')
}

