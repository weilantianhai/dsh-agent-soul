/**
 * index.js —— dsh-agent-soul 的宿主半边
 *
 * 只做拼装，不改三个模块的内部逻辑：
 *
 *   1. 归一化配置（写错了也不崩）
 *   2. 先登记会话（Sessions），再挂日志（Log），最后挂注入（Inject）
 *   3. 每一块各自 try/catch —— 一块起不来，其余照常（验收第 8 条）
 *   4. 一处 dispose 串联，卸载时一个不落（验收第 6 条）
 *
 * 顺序不能反：Inject 要读 sessions.json，Log 要知道哪些会话该记。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { normalizeConfig, checkRoot, readOwnership, toLogConfig, toInjectConfig, toToolsConfig, toDailyConfig, readSidebarSessions, derivePaths } from './config.mjs'
import { makeGuard, readOwnershipFile } from './guard.mjs'
import { approvalOf, webServerOf } from './infra/host.mjs'

import { startSummaryWatch } from './summary-watch.mjs'
import { registerRoutes, readSettings, mergeSettings } from './routes.mjs'

export const name = 'dsh-agent-soul'

/** 这次进程里这个模块实例的短 id：看事件流水时用来分辨"同一份代码跑了两遍" */
const INSTANCE = Math.random().toString(36).slice(2, 8)

/**
 * 声明等待 `webServer` 就绪再 apply —— **不是可选项**。
 *
 * 2026-10-28 真机踩到的：写成 `[]` 时 apply 在 web 服务之前就跑完了，
 * `ctx.webServer` 还是 undefined，设置页接口那条路由就永远挂不上
 * （浏览器里 404，但插件其余部分全绿）。同机的 meme / fish-memory / bili-whale
 * 都声明了 webServer。
 *
 * 模块层面的降级不受影响：拿不到某个模块文件，那一块不启用，其余照常。
 */
export const inject = ['webServer', 'agents']

/** 运行态：只给 status / 设置页看，不传给别的模块 */
const runtime = {
  config: null,
  paths: null,
  startedAt: null,
  parts: { Sessions: 'off', Log: 'off', Inject: 'off', Tools: 'off', Daily: 'off', Privacy: 'off', Summary: 'off' },
  registry: null,
  errors: [],
  warnings: [],
  lastError: null,
  /** 当前那次挂载的拆卸函数；热挂时整体替换，不做重复叠加 */
  unmount: null,
  /** 设置页路由的挂载句柄（attachRoutes 返回的 { attached, dispose }） */
  offRoutes: null,
  /** 自述：路由挂了几条、试了几次、apply 时 webServer 在不在 */
  diag: { routes: null, routeTries: 0, webServerAtApply: null },
  logConfigPath: null,
  /** 这次挂上了哪几个工具（find/open/diary/recall） */
  tools: [],
  /** 日记任务的自述（下次几点叫、上回叫了谁） */
  daily: null,
  summary: null,
  /** 根目录能不能写（写不了就别到处 mkdir，尤其别把写错的路径建出来） */
  rootReady: false,
}

const msg = (err) => String((err && err.message) || err)

function makeReporter(ctx) {
  const logger = ctx && ctx.logger
  return (err) => {
    const text = msg(err)
    runtime.lastError = text
    runtime.errors.push({ at: new Date().toISOString(), text })
    if (runtime.errors.length > 50) runtime.errors.shift()
    try {
      logger?.warn?.(`[dsh-agent-soul] ${text}`)
    } catch {
      /* 日志炸了不影响主流程 */
    }
  }
}

/** 动态 import：文件没了 = 这一块未启用，不是插件起不来 */
async function loadPart(rel) {
  return import(new URL(rel, import.meta.url).href)
}

function materializeLogConfig(paths, config, onError, ownership) {
  const file = paths.logConfigPath
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(toLogConfig(config, paths, ownership), null, 2) + '\n')
    runtime.logConfigPath = file
    return file
  } catch (err) {
    onError(new Error(`日志配置写不出来（${file}）：${msg(err)}`))
    return null
  }
}

function materializeInjectConfig(paths, config, onError) {
  const file = paths.injectConfigPath
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(toInjectConfig(config), null, 2) + '\n')
    return file
  } catch (err) {
    onError(new Error(`注入配置写不出来（${file}）：${msg(err)}`))
    return null
  }
}

/**
 * 挂上所有能挂的。返回一个"全拆掉"的函数。
 * 设置页保存后也复用它做一次热重挂。
 */
async function mount(ctx, config, paths, onError) {
  const disposes = []

  /* ---------------------------------------------------------- 1) Sessions */
  if (config.sessions.enabled === false) {
    runtime.parts.Sessions = 'off'
  } else {
    try {
      const mod = await loadPart('../src/Sessions/index.mjs')
      const result = await mod.register(ctx, {
        registryPath: paths.registryPath,
        onError,
        /*
         * 警告单独一路：像"启动时还没扫到会话"这种，防护按设计工作了、
         * 数据也没丢，不该进 errors 让体检变红。
         */
        onWarn: (err) => {
          const text = String((err && err.message) || err)
          runtime.warnings.push({ at: new Date().toISOString(), text })
        },
        // 只登记"人真的聊过、且有名字"的会话（DSH 侧边栏可见的那批），
        // 顺手把三天没再出现、又一直没名字的旧行清掉 —— 它们多半是插件自己开的工作会话
        requireName: true,
        pruneUnnamedAfterDays: 3,
      })
      runtime.registry = (result && result.sessions) || null
      runtime.parts.Sessions = 'on'

      // 启动那一刻还没有任何会话，扫出来必然是空表 —— 所以要让模块盯着宿主：
      // 有会话冒出来（session/created、agent/created，或"表里还没有它"的第一条事件）
      // 就补扫一遍。不然登记表会一直空着，直到下次重启。
      if (typeof mod.watch === 'function') {
        const off = mod.watch(ctx, { registryPath: paths.registryPath, onError })
        if (typeof off === 'function') {
          disposes.push(async () => {
            try {
              off()
            } catch {
              /* 解绑失败不影响退出 */
            }
          })
        }
      }
    } catch (err) {
      runtime.parts.Sessions = 'missing'
      onError(new Error(`Sessions 未启用（登记表不会更新）：${msg(err)}`))
    }
  }

  /* --------------------------------------------------------------- 2) Log */
  if (config.log.enabled === false) {
    runtime.parts.Log = 'off'
  } else {
    try {
      const mod = await loadPart('../src/Log/index.mjs')
      const configPath = materializeLogConfig(paths, config, onError, readOwnership(paths))
      if (configPath) {
        const r = await mod.start({ ctx, configPath, onError })
        if (r && r.running) {
          runtime.parts.Log = 'on'
          disposes.push(async () => {
            try {
              await mod.stop()
            } catch {
              /* 停不下来也要继续拆别的 */
            }
          })
        } else {
          runtime.parts.Log = r && r.reason ? r.reason : 'off'
        }
      } else {
        runtime.parts.Log = 'no-config'
      }
    } catch (err) {
      runtime.parts.Log = 'missing'
      onError(new Error(`Log 未启用（对话不会进日志）：${msg(err)}`))
    }
  }

  /* ------------------------------------------------------------ 3) Inject */
  if (config.inject.enabled === false) {
    runtime.parts.Inject = 'off'
  } else {
    try {
      const mod = await loadPart('../src/Inject/index.mjs')
      const configPath = materializeInjectConfig(paths, config, onError)
      const off = mod.register(ctx, { config: toInjectConfig(config), configPath, onError })
      runtime.parts.Inject = 'on'
      if (typeof off === 'function') {
        disposes.push(async () => {
          try {
            off()
          } catch {
            /* 解绑失败不影响退出 */
          }
        })
      }
    } catch (err) {
      runtime.parts.Inject = 'missing'
      onError(new Error(`Inject 未启用（系统提示里不会有人格和日记）：${msg(err)}`))
    }
  }

  /* ------------------------------------------------------------- 4) Tools */
  // 给 LLM 的四只手：find / open / diary / recall。
  // 少这一块，记忆就只是躺在硬盘上的文件 —— 她只能凭印象说话，那就是编。
  if (config.tools && config.tools.enabled === false) {
    runtime.parts.Tools = 'off'
  } else {
    try {
      const mod = await loadPart('../src/Search/index.mjs')
      const r = mod.register(ctx, {
        rootDir: paths.rootDir,
        config: toToolsConfig(config),
        onError,
      })
      runtime.parts.Tools = r && r.names && r.names.length ? 'on' : r && r.reason ? r.reason : 'off'
      runtime.tools = (r && r.names) || []
      if (r && typeof r.dispose === 'function') {
        disposes.push(async () => {
          try {
            r.dispose()
          } catch {
            /* 摘不下来也要继续拆别的 */
          }
        })
      }
    } catch (err) {
      runtime.parts.Tools = 'missing'
      onError(new Error(`工具区未启用（她够不到自己的记忆）：${msg(err)}`))
    }
  }

  /* ------------------------------------------------------------- 5) Daily */
  // 晚上定点叫醒、让她当场写日记。只做三件：筛、产稿、叫醒 —— 写的是她自己。
  if (config.daily && config.daily.enabled === false) {
    runtime.parts.Daily = 'off'
  } else {
    try {
      const mod = await loadPart('../src/Daily/index.mjs')
      const handle = mod.start(ctx, {
        rootDir: paths.rootDir,
        config: toDailyConfig(config),
        onError,
        /*
         * 侧边栏可见集 —— 定时触发也要用同一份。
         * 从 workspace.json 读，(工作区 ∪ 置顶) − 归档，
         * 和设置页的会话数口径完全一致。
         */
        sidebarSessions: readSidebarSessions(),
      })
      // routes 里 /daily/run 要用它手动触发
      runtime.dailyHandle = handle
      runtime.parts.Daily = 'on'
      runtime.daily = typeof handle.status === 'function' ? handle.status() : null
      disposes.push(async () => {
        try {
          handle.stop()
        } catch {
          /* 定时器拆不掉也要继续拆别的 */
        }
      })
    } catch (err) {
      runtime.parts.Daily = 'missing'
      onError(new Error(`日记任务未启用（晚上不会叫醒她写日记）：${msg(err)}`))
    }
  }

  /* ------------------------------------------------------ 6) 隐私边界 */
  /*
   * 跨 agent 的硬边界：A 不能碰 agents/<B>/，除非 A 就是 B。
   *
   * **不受 DSH 沙箱模式影响** —— 哪怕整个会话是 danger-full-access，
   * 碰别人的目录仍要弹验证。沙箱按路径管，而"人格目录归谁"这个信息
   * 它不知道，只有插件知道。
   *
   * 只拦结构化路径工具（ops_read_files / write / edit / working_directory）；
   * ops_bash 放开 —— 命令里能拼路径、能 cd、能 base64，字符串上做边界
   * 防不住，还会给人虚假的安全感。bash 靠提示词软约束。
   */
  runtime.parts.Privacy = 'off'
  try {
    const guard = makeGuard({
      rootDir: paths.rootDir,
      readOwnership: () => readOwnershipFile(paths.ownershipPath),
      onBlock: (text) => onError(new Error(`隐私边界：${text}`)),
      /*
       * 有没有审批渠道 —— 决定 ask 还是 deny。
       * 宿主没有 approval 服务时，ask 会被它变成一句冷冰冰的
       * "the user rejected tool"，我们写的理由全丢。
       * 那种情况下不如直接 deny，把理由原样送到用户眼前。
       */
      /*
       * 两个条件都满足才 ask：
       *   ① 用户在配置里开了「跨 agent 访问时弹窗确认」
       *   ② 宿主真的有 approval 服务
       *
       * 默认只满足 ②、不满足 ① —— 直接 deny 并带上理由。
       * 因为宿主在没有应答者时会把 ask 换成它自己的
       * 「the user rejected tool」，我们的理由全丢。
       */
      canAsk: () => {
        try {
          if (!(config.privacy && config.privacy.allowPrompt === true)) return false
          const approval = approvalOf(ctx)
          return Boolean(approval && typeof approval.request === 'function')
        } catch {
          return false
        }
      },
    })
    const offGuard = ctx.on('tools/pre-execute', (exec, next) => {
      const decision = guard(exec)
      if (decision.kind === 'allow') return next()
      return decision
    })
    runtime.parts.Privacy = 'on'
    disposes.push(() => {
      try {
        offGuard?.()
      } catch {
        /* 拆不掉就算了 */
      }
    })
  } catch (err) {
    runtime.parts.Privacy = 'missing'
    onError(new Error(`隐私边界挂不上（跨 agent 访问不受保护）：${msg(err)}`))
  }

  /* ---------------------------------------------- 7) 上下文到顶了写总结 */
  /*
   * 到阈值（默认 80%）就叫 agent 写一份交接总结。
   *
   * 占用率用宿主的 contextPressure 投影（pressureTokens / contextWindow），
   * **不自己 tokenize** —— 那是宿主已经算好的东西。
   *
   * 时机：检测到超阈值时**不立即发**，先排队；等 agent 变 idle
   * （agent/status = idle，宿主自己发的）再发。不然会把正在干活的它打断。
   */
  runtime.parts.Summary = 'off'
  try {
    const watch = startSummaryWatch(ctx, {
      rootDir: paths.rootDir,
      ownershipPath: paths.ownershipPath,
      threshold: config.summary && Number.isFinite(config.summary.threshold) ? config.summary.threshold : 0.8,
      onError,
    })
    runtime.parts.Summary = 'on'
    runtime.summary = watch.status()
    disposes.push(() => watch.dispose())
  } catch (err) {
    runtime.parts.Summary = 'missing'
    onError(new Error(`上下文总结看门狗没挂上（到顶了不会提醒）：${msg(err)}`))
  }

  return async () => {
    for (const fn of disposes.reverse()) {
      try {
        await fn()
      } catch {
        /* 一个拆不掉，别的照拆 */
      }
    }
  }
}

/* ---------------------------------------------------------------- 路由挂载 */

/** 写 `system/plugin-status.json`：排查只看这一个文件，不用去翻宿主日志 */
function writeDiag(paths) {
  if (!paths || !paths.statusPath || !runtime.rootReady) return
  try {
    mkdirSync(dirname(paths.statusPath), { recursive: true })
    const payload = {
      at: new Date().toISOString(),
      parts: { ...runtime.parts },
      routes: runtime.diag.routes ?? null,
      tools: runtime.tools.slice(),
      daily: runtime.daily,
    summary: runtime.summary,
      routeTries: runtime.diag.routeTries ?? 0,
      webServerAtApply: runtime.diag.webServerAtApply ?? null,
      inject: inject.slice(),
      errors: runtime.errors.slice(-12),
      warnings: runtime.warnings.slice(-12),
    }
    writeFileSync(paths.statusPath, JSON.stringify(payload, null, 2) + '\n')
  } catch {
    /* 诊断写不出来不该影响主流程 */
  }
}

/** 只追加的事件流水：apply → 路由 → 挂载 → 被拆，一眼看出谁先谁后 */
function logEvent(paths, event, extra = {}) {
  if (!paths || !paths.statusLogPath || !runtime.rootReady) return
  try {
    mkdirSync(dirname(paths.statusLogPath), { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      pid: typeof process !== 'undefined' ? process.pid : null,
      inst: INSTANCE,
      event,
      ...extra,
    })
    appendFileSync(paths.statusLogPath, line + '\n')
  } catch {
    /* 忽略 */
  }
}

/**
 * 挂设置页路由。
 *
 * ⚠️ 为什么还要"等"：inject 已经声明了 webServer，正常情况下第一次就能挂上。
 * 但真机出过一次"apply 跑完了、webServer 还是 undefined"（浏览器里 404，
 * 其余功能全绿）。所以这里做成**可等**的：没有就每 250ms 再看一眼，最多 30 秒。
 * 等到了就挂；等不到就把这次尝试记进 plugin-status.json，别静默。
 */
function attachRoutes(ctx, paths, onError) {
  let off = null
  let timer = null
  let tries = 0

  const attempt = () => {
    if (off) return
    tries++
    runtime.diag.routeTries = tries

    if (!webServerOf(ctx)) {
      if (tries < 120) {
        timer = setTimeout(attempt, 250)
        if (timer && typeof timer.unref === 'function') timer.unref()
      } else {
        onError(new Error('等了 30 秒仍拿不到 webServer —— 设置页接口没挂上（其余功能不受影响）'))
        writeDiag(paths)
      }
      return
    }

    try {
      off = registerRoutes(ctx, {
        getRuntime: () => runtime,
        paths,
        onError,
        remount: async (nextConfig) => {
          // 先拆旧的，再挂新的。挂新的之前把引用清掉 —— 中途抛了也不会留半个挂载。
          const old = runtime.unmount
          runtime.unmount = null
          try {
            await old()
          } catch {
            /* 旧挂载拆不掉也要继续挂新的 */
          }
          runtime.config = nextConfig
          runtime.unmount = await mount(ctx, nextConfig, paths, onError)
        },
        /*
         * 换数据目录 —— 比其他热挂多一步：**paths 要重新算**。
         *
         * 这是最容易写错的一处：如果只换 config 不换 paths，
         * 插件会继续往老目录写人格、日记、日志，界面上却显示新目录。
         * 数据看起来"凭空消失"，其实全写回了原地。
         *
         * 所以这里 derivePaths 之后，用**新 paths** 重新 mount，
         * 并且把 runtime.paths 也换掉（status() / 诊断都读它）。
         */
        remountRoot: async (nextConfig, nextRootDir) => {
          const old = runtime.unmount
          runtime.unmount = null
          try {
            await old()
          } catch {
            /* 旧挂载拆不掉也要继续挂新的 */
          }
          const nextPaths = derivePaths(nextRootDir)
          runtime.paths = nextPaths
          runtime.rootReady = false
          runtime.config = nextConfig
          try {
            checkRoot(nextPaths, onError)
          } catch {
            /* 根目录检查失败不该拦住挂载 —— 挂上之后功能自己会报 */
          }
          runtime.unmount = await mount(ctx, nextConfig, nextPaths, onError)
        },
      })
      runtime.diag.routes = typeof off.count === 'number' ? off.count : null
      runtime.diag.routeAt = new Date().toISOString()
      logEvent(paths, 'routes:attached', { count: runtime.diag.routes })
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            try {
              off?.()
            } catch {
              /* 忽略 */
            }
          },
          'dsh-agent-soul: routes',
        )
      }
      writeDiag(paths)
    } catch (err) {
      onError(new Error(`设置页路由挂不上：${msg(err)}`))
      writeDiag(paths)
    }
  }

  attempt()

  return {
    get attached() {
      return Boolean(off)
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      try {
        off?.()
      } catch {
        /* 忽略 */
      }
      off = null
    },
  }
}

export async function apply(ctx, rawConfig) {
  // 设置页改过的配置存在 system/settings.json，优先级高于 profile 里的种子配置
  const seeded = normalizeConfig(rawConfig)
  const stored = readSettings(seeded.paths)
  const merged = stored
    ? normalizeConfig(mergeSettings(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}, stored))
    : seeded
  const { config, issues, paths } = merged
  const onError = makeReporter(ctx)

  runtime.config = config
  runtime.paths = paths
  runtime.startedAt = new Date().toISOString()
  runtime.errors = []
  runtime.lastError = null
  runtime.diag = { routes: null, routeTries: 0, webServerAtApply: Boolean(webServerOf(ctx)) }

  for (const issue of issues) onError(issue)

  // ⚠️ 顺序要紧：这一步必须在任何写盘之前。
  // logEvent 会往 `<root>/system/` 写流水，mkdir 会把根目录顺带建出来 ——
  // 先判空就永远判到"在"，默认位置也就永远等不到"替你建好"这句。
  if (!existsSync(paths.rootDir)) {
    // 默认位置（没配 rootDir）就替你建出来 —— 别人 clone 下来第一次跑也能用；
    // 显式配了一个不存在的路径，不建（写错的路径不该被"帮忙"造出来）
    if (config.rootIsDefault) {
      try {
        mkdirSync(paths.rootDir, { recursive: true })
        onError(new Error(`记忆根目录还没建，已按默认位置建好：${paths.rootDir}`))
      } catch (err) {
        onError(new Error(`记忆根目录建不出来（${paths.rootDir}）：${msg(err)}`))
      }
    } else {
      onError(checkRoot(paths) || new Error(`记忆根目录不存在：${paths.rootDir}`))
    }
  }

  runtime.rootReady = existsSync(paths.rootDir)
  logEvent(paths, 'apply:start', { webServer: runtime.diag.webServerAtApply, inject: inject.slice() })


  if (existsSync(paths.rootDir)) {
    // 只补子目录，绝不替你造根目录（写错的路径不该被"帮忙"建出来）
    for (const dir of [paths.sessionsDir, dirname(paths.registryPath), dirname(paths.ownershipPath)]) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (err) {
        onError(new Error(`目录建不出来（${dir}）：${msg(err)}`))
      }
    }
  }

  // 路由先挂：这一步不等任何 await，宿主 web 服务在就立刻挂上；
  // 不在就后台每 250ms 再看一眼（最多 30 秒），不阻塞模块启动。
  runtime.offRoutes = attachRoutes(ctx, paths, onError)

  if (!runtime.rootReady) {
    for (const k of Object.keys(runtime.parts)) runtime.parts[k] = 'no-root'
    onError(new Error(`记忆根目录不可用，几块都没启用（配对的 rootDir 要存在、能写）：${paths.rootDir}`))
  } else {
    runtime.unmount = await mount(ctx, config, paths, onError)
  }
  logEvent(paths, 'mount:done', { parts: { ...runtime.parts } })

  async function teardown() {
    logEvent(paths, 'teardown', { parts: { ...runtime.parts } })
    runtime.parts = { Sessions: 'off', Log: 'off', Inject: 'off', Tools: 'off', Daily: 'off' }
    try {
      runtime.offRoutes?.dispose?.()
    } catch {
      /* 路由拆不掉不影响下面 */
    }
    runtime.offRoutes = null
    const fn = runtime.unmount
    runtime.unmount = null
    try {
      await fn?.()
    } catch {
      /* 一个拆不掉，别的照拆 */
    }
    writeDiag(paths)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => teardown, 'dsh-agent-soul: mount')
  }

  writeDiag(paths)
  logEvent(paths, 'apply:end', { parts: { ...runtime.parts }, routes: runtime.diag.routes })

  const summary = Object.entries(runtime.parts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  try {
    ctx.logger?.info?.(`[dsh-agent-soul] 已启动 ${summary} root=${paths.rootDir} routes=${runtime.diag.routes}`)
  } catch {
    /* 忽略 */
  }

  /* ⚠️⚠️ 返回值：这里**必须什么都不返回**。别"顺手"return 个 { parts, errors }。
   *
   * cordis 4（宿主自带的 @deepseek-ai/cordis，Fiber._execute）把 apply 的返回值
   * 当成「这次挂载的 effect」来解释：
   *   函数             → 当 disposer
   *   null / undefined → 什么也不做（对）
   *   有 then 的对象   → 等它，等到的东西还要再按同一套规则判一遍
   *   可迭代           → 逐个当 disposer 收
   *   剩下的一律 TypeError('Invalid effect')
   * 抛出来之后 Fiber._reload 会记 _error、把 epoch 置成 INACTIVE，
   * 接着调 _unload() —— 那会把这次挂载注册的**所有** ctx.effect 清理函数跑一遍，
   * 也就是我们的 teardown：插件当场下线，路由随之消失。
   *
   * 2026-10-28 真机就是这个坑：这里返回了 { parts, errors }，apply 跑完 2ms 后
   * 宿主把整个插件拆了，6 条路由 404；而插件自己的 errors 是空的（错误进了宿主的
   * 日志，写的是 "TypeError: Invalid effect"），所以特别难认。
   *
   * 要看结果就读 status()（设置页 /status 和 system/plugin-status.json 都读它）。
   */
  return
}

/** 给设置页和排查用 */
export function status() {
  return {
    name,
    startedAt: runtime.startedAt,
    rootDir: runtime.paths ? runtime.paths.rootDir : null,
    parts: { ...runtime.parts },
    config: runtime.config,
    paths: runtime.paths,
    registrySessions: runtime.registry ? Object.keys(runtime.registry) : [],
    tools: runtime.tools.slice(),
    daily: runtime.daily,
    lastError: runtime.lastError,
    warnings: runtime.warnings.slice(-10),
    errors: runtime.errors.slice(-10),
    diag: { ...runtime.diag },
  }
}
