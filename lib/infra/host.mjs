/**
 * infra/host.mjs —— 和宿主打交道的唯一入口。
 *
 * 为什么要这一层：
 *
 *   1. `ctx.get('xxx')` 散在四个文件里，每处都得自己判
 *      `ctx && typeof ctx.get === 'function'`。漏判一次就是
 *      "某个宿主版本上插件直接崩"。
 *
 *   2. 有些服务在不同宿主版本里挂在**两个位置**（`ctx.webServer` /
 *      `ctx.get('webServer')`）。这个兼容逻辑原来在两个文件里各写一遍，
 *      分叉过一次（有个文件只认一个位置）。
 *
 *   3. 这一层可以**打桩测试** —— 想知道"宿主没给这个服务会怎样"，
 *      只要构造一个假的 ctx 传进来，不用起真宿主。
 *
 * 这一层不认识业务概念（人格、日记、配置）。它只回答"宿主有没有给我这个"。
 */

/** 安全取服务：ctx 可能没有 get、可能抛异常，都当"没有" */
function safeGet(ctx, key) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const v = ctx.get(key)
      if (v !== undefined && v !== null) return v
    }
  } catch {
    /* 宿主抛了就默认没有 */
  }
  return null
}

/**
 * 会话控制器 —— 列会话、投消息。
 *
 * ⚠️ 拿到的往往是 **Proxy**（Remote 层），不是宿主内部的
 * SessionCommandController。两者 `prompt` 的第二个参数**语义不同**：
 *   Proxy.prompt(request, signal)          ← 我们用的这个，第二参是 AbortSignal
 *   SessionCommandController.prompt(request, source)  ← 宿主内部
 * 认错这个，会白白查好几轮（见 docs/MODEL.md 2.1）。
 */
export function sessionControllerOf(ctx) {
  const c = safeGet(ctx, 'sessionController')
  return c && typeof c.prompt === 'function' ? c : null
}

/** 会话标题服务（需要活的 Session 对象；冷会话要读 projcache） */
export function sessionTitleOf(ctx) {
  const c = safeGet(ctx, 'sessionTitle')
  return c && typeof c.get === 'function' ? c : null
}

/** 活会话存储。`get(id)` 返回 Session，`flush(session)` 落盘 */
export function sessionsOf(ctx) {
  const c = safeGet(ctx, 'sessions')
  return c && typeof c.get === 'function' ? c : null
}

/**
 * 会话投影注册表 —— 读宿主的各种 projection（contextPressure 等）。
 *
 * ⚠️ 这是**唯一**正确的读法：`projections.stateOf(session, key)`。
 * Session 对象上**没有** `.projections` / `.projectionValues()` 这种东西。
 * 2026-10-29 前我们一直按后者写，于是压力永远读不到、摘要看门狗一次没触发。
 */
export function sessionProjectionsOf(ctx) {
  const c = safeGet(ctx, 'sessionProjections')
  return c && typeof c.stateOf === 'function' ? c : null
}

/** 审批服务（`ask` 决策要用） */
export function approvalOf(ctx) {
  const c = safeGet(ctx, 'approval')
  return c && typeof c.request === 'function' ? c : null
}

/** 信任栅栏（写操作要过） */
export function connectionOf(ctx) {
  return safeGet(ctx, 'connection') || (ctx && ctx.connection) || null
}

/**
 * HTTP 服务 —— 两个位置都认。
 *
 * 原来在两个文件里各写一份判断，其中一处只认 `ctx.get`，
 * 另一个只认 `ctx.webServer`，于是"某个宿主版本上设置页整块消失"。
 */
export function webServerOf(ctx) {
  const direct = ctx && ctx.webServer
  if (direct && typeof direct.register === 'function') return direct
  const got = safeGet(ctx, 'webServer')
  return got && typeof got.register === 'function' ? got : null
}

/**
 * 一次性把常用服务绑好，省得每次传 ctx。
 *
 * 用法：
 *   const host = bindHost(ctx)
 *   host.controller.list()
 *
 * 注意：绑定发生在**调用时**，不是模块加载时 —— 宿主可能在插件之后
 * 才把服务挂上（这是真出现过的情况）。
 */
export function bindHost(ctx) {
  return {
    ctx,
    get controller() {
      return sessionControllerOf(ctx)
    },
    get titles() {
      return sessionTitleOf(ctx)
    },
    get sessions() {
      return sessionsOf(ctx)
    },
    get approval() {
      return approvalOf(ctx)
    },
    get connection() {
      return connectionOf(ctx)
    },
    get webServer() {
      return webServerOf(ctx)
    },
  }
}
