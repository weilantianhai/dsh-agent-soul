/**
 * client.js —— 设置页（浏览器半边）
 *
 * DSH「设置」里多一项 **记忆**。跟 bili-whale / narrator / speak-up 用同一个
 * `settings.section` 槽位 —— 这条是实证过的路子，不是自己造的。
 *
 * 这里只做三件事：
 *   ① 把开关和数字摆出来（日志 / 注入 / 人格）
 *   ② 保存时写回宿主（POST /dsh-agent-soul/api/config）
 *   ③ 选人格时立刻写归属表（下一轮就生效，不用重启）
 *
 * ⚠️ 不碰会话、不发消息、不读文件 —— 文件全在宿主那边读。
 * ⚠️ id 必须等于包名，宿主按包名挂模块。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-soul',

  factory(require) {
    const React = require('react')

    /**
     * createPortal 用来把菜单挂到 body 上。
     *
     * 试两个名字：美化插件用的是 `react-dom/client`，官方包有的是 `react-dom`；
     * 都拿不到就放弃 portal（菜单退回就地渲染）—— 层级会差一点，但不会不显示。
     * 注意 package.json 里**不声明 external**：装了的美化插件同样没声明，
     * 照样 require 得到，声明错反而会让插件加载失败。
     */
    let createPortal = null
    for (const name of ['react-dom/client', 'react-dom']) {
      try {
        const mod = require(name)
        const fn = mod && (mod.createPortal || (mod.default && mod.default.createPortal))
        if (typeof fn === 'function') {
          createPortal = fn
          break
        }
      } catch {
        /* 换下一个名字 */
      }
    }

    /** 把菜单挂到 body；拿不到 createPortal / document 就直接返回原节点 */
    const portal = (node) => {
      if (typeof createPortal !== 'function') return node
      if (typeof document === 'undefined' || !document.body) return node
      return createPortal(node, document.body)
    }
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const B = '/dsh-agent-soul/api'

    const jget = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))

    const jpost = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))

    /* ---------------------------------------------------------------- 样式 */

    const CSS = `    /* ---------------------------------------------------------------- 样式 */

    /**
     * 样式表：注入一个 <style>，由宿主按插件归属认领、卸载时一起清掉。
     *
     * 为什么不用内联 style：内联写不了 :hover / :focus-visible / 过渡 /
     * @keyframes / 媒体查询 —— 这就是之前界面"死板"的根本原因。
     *
     * 为什么自己 createElement 而不是 styles.insert：
     * 宿主在 factory 执行期间会给新出现的、没有 data-plugin 的 <style> 打上归属标记
     * （见 dsh-client-modules 的 claimStyles），插在 apply 里、卸载时由我们自己移除，
     * 两种方式都能活；自己管更直接，也不依赖某个 builtin 一定存在。
     *
     * 所有类名都带 dsas- 前缀（dsh-agent-soul），避免和宿主/其它插件撞车。
     */
    const CSS = \`
/*
 * 宽度：**不设上限**，容器给多少就用多少。
 * 设置弹层里跟着弹层走（700 出头），侧边栏整页里撑满主区。
 * 以前写死 780px —— 小窗口被挤，大屏空一大片。
 */
.dsas-wrap{--dsas-gap:14px;font-size:13px;line-height:1.65;width:100%;max-width:none;padding:2px 2px 32px;color:var(--dsw-alias-label-primary)}
.dsas-wrap *{box-sizing:border-box}

/* ── 头部 ── */
.dsas-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:4px}
.dsas-title{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em;line-height:1.35}
.dsas-sub{margin:3px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}

/* ── 状态条 ── */
.dsas-strip{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 6px}
.dsas-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 8px;border-radius:999px;font-size:11.5px;line-height:1;background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));border:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary);transition:background .15s ease}
.dsas-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))}
.dsas-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9aa);flex:none}
.dsas-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary,#3fb950);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 18%, transparent)}
.dsas-dot[data-bad="1"]{background:var(--dsw-alias-state-error-primary,#d1242f);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary,#d1242f) 18%, transparent)}
.dsas-chip[data-on="1"]{color:var(--dsw-alias-label-primary)}

/* ── 分节卡片 ── */
.dsas-section{margin-top:10px;border:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16));border-radius:12px;background:var(--dsw-alias-bg-layer-1, transparent);overflow:hidden;transition:border-color .15s ease, box-shadow .15s ease}
.dsas-section:hover{border-color:var(--dsw-alias-border-l2, rgba(127,127,127,.28))}
.dsas-section[data-open="1"]{box-shadow:0 1px 2px rgba(0,0,0,.04)}
.dsas-head-btn{display:flex;align-items:center;gap:9px;width:100%;padding:13px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .15s ease}
.dsas-head-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06))}
.dsas-head-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:-2px}
.dsas-caret{flex:none;width:14px;color:var(--dsw-alias-label-tertiary);transition:transform .16s cubic-bezier(.16,1,.3,1)}
.dsas-section[data-open="1"] .dsas-caret{transform:rotate(90deg)}
.dsas-sec-title{flex:1;min-width:0;font-size:13.5px;font-weight:600;letter-spacing:-.005em}
.dsas-sec-meta{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsas-sec-body{padding:0 14px 14px;animation:dsas-in .18s cubic-bezier(.16,1,.3,1)}
@keyframes dsas-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.dsas-sec-hint{margin:0 0 10px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}

/* ── 行 ── */
.dsas-rows{display:flex;flex-direction:column}
.dsas-row{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 20px;padding:11px 0;border-bottom:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12));flex-wrap:wrap;transition:background .12s ease}
.dsas-row:last-child{border-bottom:0}
.dsas-row-main{flex:1;min-width:190px}
.dsas-label{font-size:13px;line-height:1.5}
.dsas-hint{margin:2px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}

/* ── 输入 ── */
.dsas-input,.dsas-select{background:var(--dsw-alias-bg-layer-1, transparent);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));border-radius:7px;color:inherit;font:inherit;font-size:12.5px;height:30px;padding:0 9px;min-width:120px;outline:none;transition:border-color .15s ease, box-shadow .15s ease}
.dsas-input:hover,.dsas-select:hover{border-color:var(--dsw-alias-label-tertiary, rgba(127,127,127,.5))}
.dsas-input:focus,.dsas-select:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary,#4a7dff) 16%, transparent)}
.dsas-input:disabled,.dsas-select:disabled{opacity:.45;cursor:not-allowed}
.dsas-num{width:78px;min-width:78px;text-align:center;font-variant-numeric:tabular-nums}

/* ── 开关 ── */
.dsas-sw{position:relative;flex:0 0 auto;width:38px;height:22px;border:0;border-radius:11px;cursor:pointer;background:var(--dsw-alias-border-l2, rgba(127,127,127,.4));transition:background .18s ease;padding:0}
.dsas-sw:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:2px}
.dsas-sw[data-on="1"]{background:var(--dsw-alias-brand-primary,#4a7dff)}
.dsas-sw:disabled{opacity:.4;cursor:not-allowed}
.dsas-knob{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .18s cubic-bezier(.16,1,.3,1)}
.dsas-sw[data-on="1"] .dsas-knob{left:19px}

/* ── 按钮 ── */
.dsas-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 14px;border:0;border-radius:7px;background:var(--dsw-alias-brand-primary,#4a7dff);color:#fff;font:inherit;font-size:12.5px;cursor:pointer;transition:filter .15s ease,transform .08s ease}
.dsas-btn:hover:not(:disabled){filter:brightness(1.08)}
.dsas-btn:active:not(:disabled){transform:translateY(1px)}
.dsas-btn:disabled{opacity:.5;cursor:default}
.dsas-btn2{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dsas-btn2:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));border-color:var(--dsw-alias-label-tertiary, rgba(127,127,127,.5))}
.dsas-btn2:disabled{opacity:.45;cursor:default}
.dsas-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4a7dff);font:inherit;font-size:12px;cursor:pointer;padding:2px 0}
.dsas-link:hover{text-decoration:underline}

/* ── 动作条 ── */
.dsas-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;padding:12px 2px 0;border-top:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));position:sticky;bottom:0;background:var(--dsw-alias-bg-base, transparent);z-index:2}
.dsas-dirty{margin-left:4px;font-size:12px;color:#d29922;display:inline-flex;align-items:center;gap:5px}
.dsas-dirty::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:dsas-pulse 1.6s ease-in-out infinite}
@keyframes dsas-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── 输出框 ── */
.dsas-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07));border:.5px solid var(--dsw-alias-border-l1, transparent);border-radius:9px;padding:11px 13px;max-height:260px;overflow:auto;margin-top:8px}
.dsas-err{margin-top:10px;padding:9px 12px;border-radius:8px;font-size:12px;line-height:1.5;background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d1242f) 10%, transparent);color:var(--dsw-alias-state-error-primary,#d1242f)}

/* ── 会话分组 ── */
.dsas-groups-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0 2px}
.dsas-ghead{display:flex;align-items:center;gap:8px;width:100%;padding:9px 2px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12));background:transparent;color:inherit;font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:background .12s ease}
.dsas-ghead:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06))}
.dsas-gtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsas-gcount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1));padding:1px 7px;border-radius:999px;font-variant-numeric:tabular-nums}

/* ── 人格编辑 ── */
.dsas-editor{margin-top:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-layer-1, transparent)}
.dsas-textarea{width:100%;min-height:260px;max-height:480px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;padding:11px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.05));color:inherit;outline:none;resize:vertical;transition:border-color .15s ease}
.dsas-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}

/* ── 无内容 ── */
.dsas-empty{padding:22px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.6}
.dsas-empty strong{display:block;color:var(--dsw-alias-label-secondary);font-size:13px;margin-bottom:4px;font-weight:500}
\`

/* ── 平铺布局的老式分组标题 ── */
.dsas-group-head{margin-top:18px;font-size:13px;font-weight:600;line-height:20px;letter-spacing:-.005em}

/* ── 微小修饰 ── */
.dsas-inline-label{cursor:pointer;display:inline-flex;gap:4px;align-items:center;margin:0}
.dsas-time{width:110px;min-width:110px}
.dsas-id{width:120px;min-width:120px}
.dsas-rows-tight{margin-bottom:4px}
.dsas-rows-gap{margin-top:10px}
/* ── 整页面板（侧边栏入口点开后的主区） ── */
.dsas-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent)}
.dsas-page-head{flex:none;display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));background:var(--dsw-alias-bg-layer-1,transparent)}
.dsas-page-back{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 9px 0 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s ease,color .15s ease}
.dsas-page-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary)}
.dsas-page-title{flex:1;min-width:0;display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;letter-spacing:-.005em;color:var(--dsw-alias-label-primary)}
.dsas-page-act{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease}
.dsas-page-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary)}
.dsas-page-body{flex:1;min-height:0;overflow-y:auto;padding:18px 24px 40px}
.dsas-page-body .dsas-wrap{max-width:none;padding-bottom:8px}

/* 窄屏：让给容器，不要跟自己抢那 92vw —— 设置弹层里本来就只有 700 出头 */
@media (max-width:820px){
  .dsas-wrap{max-width:100%}
  .dsas-page-body{padding:14px 12px 32px}
  .dsas-master-row{flex-direction:column;align-items:flex-start;gap:10px}
  .dsas-master-switches{width:100%}
  .dsas-detail-row{flex-direction:column;align-items:flex-start}
}

/* 宽屏：多给点呼吸，但别拉成一行字读不完 */
@media (min-width:1200px){
  /* 宽屏只加呼吸，不限宽 —— 容器多宽就多宽 */
  .dsas-page-body{padding:24px 40px 48px}
}

/*
 * 宽屏时行不会被拉长，但**文字会变得很难读**（一行 2000px 谁看谁累）。
 * 所以不限制容器宽度，只让"说明文字"那部分别铺满整行。
 */
@media (min-width:1400px){
  .dsas-row-main{max-width:720px}
  .dsas-master-main{max-width:620px}
  .dsas-quick-main{max-width:760px}
  .dsas-hint:only-child{max-width:820px}
}
.dsas-page-body .dsas-actions{position:static}

/* ══════ 新版设置页 ══════ */

/* 状态灯 */
.dsas-lights{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px}
.dsas-light{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dsas-light-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#d1242f);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 16%,transparent);transition:background .2s ease}
.dsas-light-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary,#3fb950);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 18%,transparent)}

/* 区块 */
.dsas-block{margin-top:14px;padding:14px 15px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dsas-block-head{font-size:13px;font-weight:600;line-height:1.5;margin-bottom:4px}
.dsas-block-head-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.dsas-block-head-btn{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:4px;text-align:left}

/* 分组 / 人格列表 */
.dsas-gblock{border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}
.dsas-gblock:last-of-type{border-bottom:0}
.dsas-srow{display:flex;align-items:center;gap:8px;padding:8px 4px 8px 2px;cursor:pointer;border-radius:7px;transition:background .12s ease}
/*
 * 从人格详情跳过来时闪一下：告诉用户"就是这一行"。
 * 一屏几十行，只滚动是不够的 —— 眼睛找不到落点。
 */
.dsas-srow[data-flash="1"]{animation:dsas-flash 1.2s ease-out 2;border-radius:7px}
@keyframes dsas-flash{
  0%   {background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 30%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 45%,transparent)}
  60%  {background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 12%,transparent);box-shadow:0 0 0 2px transparent}
  100% {background:transparent;box-shadow:0 0 0 2px transparent}
}
.dsas-srow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}
.dsas-srow[data-open="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}
.dsas-srow-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
/* fork 分支：缩进挂在父会话下面（跟侧边栏一致） */
.dsas-srow-main[data-fork="1"]{padding-left:16px;border-left:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));margin-left:6px}
.dsas-fork-mark{color:var(--dsw-alias-label-tertiary);margin-right:2px}
.dsas-srow-name{font-size:12.5px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsas-srow-id{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 静态值 */
.dsas-pick-sm{min-width:96px}
.dsas-static{font-size:12.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* 字数预算 */
.dsas-budget{padding:11px 12px;margin:8px 0 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.dsas-budget-title{font-size:12.5px;font-weight:600;margin-bottom:3px}
.dsas-budget-grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:9px}
.dsas-budget-item{display:flex;align-items:center;gap:6px}
.dsas-budget-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

/* 新建人格 / 打开目录 */
.dsas-ghostbar{padding:9px 11px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 10%,transparent);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 30%,transparent)}
.dsas-newagent{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.dsas-detail-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}

/* Tools */
.dsas-tools{margin-top:6px}
.dsas-tools .dsas-row:last-child{border-bottom:0}

/* 体检 */
.dsas-checkup{margin-top:10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));overflow:hidden}
.dsas-checkup-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.dsas-checkup-ok{font-size:12.5px;font-weight:600;color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsas-checkup-ok[data-ok="1"]{color:var(--dsw-alias-state-success-primary,#3fb950)}
/* 日记测试结果里"挂了人格的会话"明细 */
.dsas-daily-owned{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dsas-daily-owned-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11.5px;flex-wrap:wrap}
.dsas-daily-owned-name{color:var(--dsw-alias-label-secondary);min-width:80px}
.dsas-daily-owned-id{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsas-daily-owned-res{flex:none;color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsas-daily-owned-res[data-ok="1"]{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dsas-checkup-warns{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));padding-top:8px}
.dsas-checkup-warnhead{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.dsas-checkup-warnout{margin:0!important;border:0!important;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 8%,transparent)!important;max-height:120px;user-select:text}
.dsas-checkup-out{margin:0!important;border-radius:0!important;border:0!important;max-height:220px;user-select:text}

/* 宽弹窗（人格编辑器） */
.dsas-modal-wide{width:min(680px,100%)}

/* ── 总开关条 ── */
.dsas-master{margin:14px 0 6px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:11px;background:var(--dsw-alias-bg-layer-1,transparent);overflow:hidden}
.dsas-master-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;flex-wrap:wrap}
.dsas-master-row + .dsas-master-row{border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dsas-master-main{flex:1;min-width:170px}
.dsas-master-title{font-size:13px;font-weight:600;line-height:1.45}
.dsas-master-switches{display:flex;gap:16px;flex-wrap:wrap}
.dsas-master-item{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsas-default-pick{min-width:150px}

/* ── 一键建人格 ── */
.dsas-quick{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;padding:13px 14px;border-radius:11px;border:.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));flex-wrap:wrap;transition:border-color .15s ease,background .15s ease}
.dsas-quick:hover{border-color:var(--dsw-alias-brand-primary,#4a7dff);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dsas-quick-main{flex:1;min-width:200px}
.dsas-quick-title{font-size:13px;font-weight:600;line-height:1.45}

/* ── 弹窗 ── */
.dsas-modal-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.36);animation:dsas-fade .14s ease}
@keyframes dsas-fade{from{opacity:0}to{opacity:1}}
.dsas-modal{width:min(460px,100%);max-height:86vh;overflow:auto;padding:18px 20px 16px;border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 18px 48px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.12);animation:dsas-pop .18s cubic-bezier(.16,1,.3,1)}
@keyframes dsas-pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.dsas-modal-title{font-size:14.5px;font-weight:600;margin-bottom:8px}
.dsas-modal-field{display:flex;flex-direction:column;gap:5px;margin-top:12px}
.dsas-modal-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsas-modal-input{width:100%!important;min-width:0!important}
.dsas-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}

/* ── 单个会话详情 ── */
.dsas-srow{cursor:pointer}
.dsas-srow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
.dsas-srow[data-open="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.dsas-detail{padding:12px 14px 14px;margin:2px 0 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dsas-detail-grid{display:flex;flex-direction:column;gap:2px}
.dsas-detail-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;flex-wrap:wrap}
.dsas-detail-label{font-size:12.5px}
.dsas-tag{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary);font-weight:400;vertical-align:1px}
.dsas-caret[data-open="1"]{transform:rotate(90deg)}
/* 人格详情里的会话小药丸：点一下跳到那个会话 */
.dsas-sesslist{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dsas-sesschip{max-width:100%;padding:3px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .12s ease,border-color .12s ease}
.dsas-sesschip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));border-color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.5));color:var(--dsw-alias-label-primary)}
/* ── 删除人格（危险区） ──
 * 两步确认：第一步只有一个小链接，点了之后它**消失**，
 * 换成一段说明 + 偏右下的「我确定，继续」；
 * 第二步要求手打人格名，最终按钮在最右下。
 * 这样两次点击在位置上连不起来，双击也点不穿。
 */
.dsas-danger{margin-top:10px;padding-top:9px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))}
.dsas-link-danger{border:0;background:transparent;color:var(--dsw-alias-state-error-primary,#d1242f);font:inherit;font-size:11.5px;cursor:pointer;padding:2px 0;opacity:.75}
.dsas-link-danger:hover{opacity:1;text-decoration:underline}
.dsas-danger-box{padding:10px 12px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 8%,transparent);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 28%,transparent)}
/* 已归档的人格：一条一行，带取消归档 */
.dsas-archived{margin-top:10px;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dsas-archived-row{display:flex;align-items:center;gap:10px;padding:5px 0;flex-wrap:wrap}
.dsas-archived-name{font-size:12.5px;color:var(--dsw-alias-label-secondary);flex:1;min-width:100px}
.dsas-archived-at{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsas-danger-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-state-error-primary,#d1242f);margin-bottom:4px}
.dsas-danger-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}
.dsas-danger-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;align-items:center}
.dsas-danger-next{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 40%,transparent)!important;color:var(--dsw-alias-state-error-primary,#d1242f)!important}
.dsas-danger-typed{margin-top:8px}
.dsas-danger-final{padding:4px 12px;border-radius:7px;border:.5px solid var(--dsw-alias-state-error-primary,#d1242f);background:var(--dsw-alias-state-error-primary,#d1242f);color:#fff;font:inherit;font-size:12px;cursor:pointer;margin-left:auto;transition:opacity .12s ease}
.dsas-danger-final:disabled{opacity:.35;cursor:not-allowed}
/* 数据目录输入框 + 复制勾选 */
.dsas-rootdir{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsas-rootdir-input{flex:1;min-width:240px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dsas-rootdir-copy{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsas-rootdir-copy input{cursor:pointer}
.dsas-detail-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
`

    /**
     * 注入样式表，返回清理函数。
     *
     * 宿主在 factory 执行期间会给新出现且没有 data-plugin 的 <style> 打上归属标记
     * （dsh-client-modules 的 claimStyles），所以这里自己 createElement 是合法的；
     * 卸载时我们再移除一次，双保险。
     */
    function injectStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const el = document.createElement('style')
      el.setAttribute('data-dsas', '')
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        try {
          el.remove()
        } catch {
          /* 拆不掉就算了 */
        }
      }
    }

    /* -------------------------------------------------------------- 小组件 */

    function Switch({ on, onChange, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          disabled: !!disabled,
          onClick: () => onChange(!on),
          style: {
            width: 38,
            height: 22,
            borderRadius: 11,
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            background: on ? 'var(--dsw-alias-brand-primary)' : 'rgba(127,127,127,.35)',
            position: 'relative',
            flex: '0 0 auto',
            opacity: disabled ? 0.5 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 3,
            left: on ? 19 : 3,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: '#fff',
            transition: 'left .12s ease',
          },
        }),
      )
    }

    function Row({ label, hint, children }) {
      return h(
        'div',
        { className: 'dsas-row' },
        h('div', { className: 'dsas-row-main' }, h('div', { className: 'dsas-label' }, label), hint ? h('p', { className: 'dsas-hint' }, hint) : null),
        children,
      )
    }

    /** 状态小药丸：一个点 + 一句话。让颜色说话，别逼人读字才知道坏没坏。 */
    function Badge({ on, text, bad }) {
      return h(
        'span',
        { className: 'dsas-chip', 'data-on': on ? '1' : '0' },
        h('span', { className: 'dsas-dot', 'data-on': on ? '1' : '0', 'data-bad': bad ? '1' : '0' }),
        text,
      )
    }

    const PARTS = { on: '在跑', off: '关着', missing: '缺席', 'no-config': '配置没写成' }

    /**
     * 把会话按工作区分组。会话登记表里只有 id，工作区（谁归谁）得问 DSH。
     * 问不到就全塞进「未分组」—— 宁可退化，不要空着。
     */
    function groupSessions(ids, workspaces) {
      const list = Array.isArray(ids) ? ids : []
      const ws = Array.isArray(workspaces) ? workspaces : []
      const owner = new Map()
      for (const w of ws) for (const sid of w.sessionIds || []) owner.set(String(sid), String(w.workspaceId))
      const groups = []
      const seen = new Set()
      for (const w of ws) {
        const key = String(w.workspaceId)
        const mine = list.filter((sid) => owner.get(String(sid)) === key)
        if (!mine.length) continue
        for (const sid of mine) seen.add(String(sid))
        groups.push({ key: 'ws:' + key, title: w.title || w.path || '工作区', ids: mine })
      }
      const rest = list.filter((sid) => !seen.has(String(sid)))
      if (rest.length) groups.push({ key: 'ungrouped', title: '未分组', ids: rest })
      return groups
    }

    /* ------------------------------------------------------- 折叠分节 */

    /**
     * 设置页的一节。默认收起，点标题展开；展开状态记在 localStorage。
     *
     * 为什么按"人会问的问题"分、而不是按模块分：用户是来找某个开关的，
     * 不是来读代码结构的。所以分组是"Ta 现在怎么样 / 记不记得事 / 像不像 Ta /
     * Ta 能不能自己查 / 出问题了"。
     */
    function Section({ id, title, hint, open, onToggle, children, count }) {
      return h(
        'section',
        { className: 'dsas-section' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsas-head-btn',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => onToggle(id),
          },
          h('span', { className: 'dsas-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'dsas-sec-title' }, title),
          count ? h('span', { className: 'dsas-sec-meta' }, count) : null,
        ),
        open
          ? h('div', { className: 'dsas-sec-body' }, hint ? h('p', { className: 'dsas-sec-hint' }, hint) : null, children)
          : null,
      )
    }

    /** 本地偏好：哪几节是展开的 + 用哪套布局 */
    const UI_KEY = 'dsh-agent-soul:ui'
    const UI_DEFAULT = { layout: 'grouped', open: { status: true } }

    // localStorage 不一定有（无痕模式 / 测试环境）：那样就退回这个进程内的小盒子，
    // 至少同一个页面会话里点开的东西不会一按就弹回去。
    let uiMemo = null

    function readUiPref() {
      if (uiMemo) return { layout: uiMemo.layout, open: { ...uiMemo.open } }
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_KEY) : null
        if (!raw) return { ...UI_DEFAULT }
        const parsed = JSON.parse(raw)
        return {
          layout: parsed && parsed.layout === 'flat' ? 'flat' : 'grouped',
          open: parsed && parsed.open && typeof parsed.open === 'object' ? parsed.open : { ...UI_DEFAULT.open },
        }
      } catch {
        return { ...UI_DEFAULT }
      }
    }

    function writeUiPref(pref) {
      uiMemo = { layout: pref.layout, open: { ...pref.open } }
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(UI_KEY, JSON.stringify(pref))
      } catch {
        /* 存不了也没关系，内存里那份还在 */
      }
    }

/**
     * 「一键建立人格」的小弹窗。
     *
     * 为什么不放在设置页里直接填：建人格是一次性的、要打断的动作，
     * 用一个居中小框问「叫什么名字」就够；填完由后端一次做完
     * （建骨架 → 绑会话 → 投指令），人不用管细节。
     */
    function BootstrapDialog({ open, sessionId, sessionLabel, sessions, labels, onClose, onDone }) {
      const [name, setName] = useState('')
      const [target, setTarget] = useState(sessionId || '')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [result, setResult] = useState(null)

      useEffect(() => {
        if (open) {
          setName('')
          setErr(null)
          setResult(null)
          setBusy(false)
          setTarget(sessionId || '')
        }
      }, [open, sessionId])

      if (!open) return null

      const submit = async () => {
        const id = name.trim()
        if (!id) {
          setErr('给个名字吧，它就是人格目录名')
          return
        }
        setBusy(true)
        setErr(null)
        if (!target) {
          setErr('先选一个会话 —— 人格要绑到某个会话上，它才知道读哪段对话')
          return
        }
        const r = await jpost('/agents/bootstrap', { id, name: id, sessionId: target })
        setBusy(false)
        if (!r || r.ok !== true) {
          setErr((r && r.error) || '没建成')
          return
        }
        setResult(r)
        if (typeof onDone === 'function') onDone(r)
      }

      return h(
        'div',
        {
          className: 'dsas-modal-mask',
          onClick: (e) => {
            if (e && e.target === e.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'dsas-modal' },
          h('div', { className: 'dsas-modal-title' }, '一键建立人格'),
          result
            ? h(
                'div',
                null,
                h('p', { className: 'dsas-hint' }, `「${result.name}」建好了，已经绑到这个会话。`),
                result.pushed
                  ? h('p', { className: 'dsas-hint' }, '已经给它发了指令 —— 它会读这个会话的聊天记录，把人格补全。等它写完就行。')
                  : h(
                      'p',
                      { className: 'dsas-err' },
                      `骨架和绑定都好了，但没能叫醒它：${result.pushError || '未知原因'}。去会话里说一句「把你自己的人格补全」也行。`,
                    ),
                h(
                  'div',
                  { className: 'dsas-modal-actions' },
                  h('button', { type: 'button', className: 'dsas-btn', onClick: onClose }, '知道了'),
                ),
              )
            : h(
                'div',
                null,
                h(
                  'p',
                  { className: 'dsas-hint' },
                  '先选一个会话，再给这个会话起个人格名字。建好后它会读那段对话，把人格、记忆、认识的人自己写出来。',
                ),
                h(
                  'label',
                  { className: 'dsas-modal-field' },
                  h('span', { className: 'dsas-modal-field-label' }, '哪个会话'),
                  h(
                    'select',
                    {
                      className: 'dsas-select dsas-modal-input',
                      value: target,
                      onChange: (e) => setTarget(e.target.value),
                    },
                    h('option', { value: '' }, '（选一个会话）'),
                    (sessions || []).map((sid) =>
                      h('option', { key: 'bs-' + sid, value: sid }, `${(labels && labels[sid]) || sid}`),
                    ),
                  ),
                ),
                h(
                  'label',
                  { className: 'dsas-modal-field' },
                  h('span', { className: 'dsas-modal-field-label' }, '人格名字（就是目录名）'),
                  h('input', {
                    className: 'dsas-input dsas-id dsas-modal-input',
                    placeholder: '例如 xiaoyu、小满',
                    value: name,
                    autoFocus: true,
                    onChange: (e) => setName(e.target.value),
                    onKeyDown: (e) => {
                      if (e && e.key === 'Enter') submit()
                    },
                  }),
                ),
                err ? h('div', { className: 'dsas-err' }, err) : null,
                h(
                  'div',
                  { className: 'dsas-modal-actions' },
                  h('button', { type: 'button', className: 'dsas-btn2', onClick: onClose, disabled: busy }, '取消'),
                  h(
                    'button',
                    { type: 'button', className: 'dsas-btn', onClick: submit, disabled: busy },
                    busy ? '正在建…' : '建，并让它开始写',
                  ),
                ),
              ),
        ),
      )
    }

    /** 一组一组折叠的会话列表。默认全收起，点开才列。 */
    function SessionGroups({ groups, isOpen, onToggle, allOpen, onToggleAll, renderRow, empty, barExtra }) {
      if (!groups || !groups.length) return empty || null
      const total = groups.reduce((n, g) => n + g.ids.length, 0)
      return h(
        'div',
        { className: 'dsas-rows' },
        h(
          'div',
          { className: 'dsas-groups-bar' },
          h('span', { className: 'dsas-hint' }, `${total} 个会话 · ${groups.length} 组`),
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            barExtra || null,
            h('button', { type: 'button', className: 'dsas-link', onClick: onToggleAll }, allOpen ? '全部收起' : '全部展开'),
          ),
        ),
        ...groups.map((g) => {
          const open = isOpen(g.key)
          return h(
            'div',
            { key: g.key },
            h(
              'button',
              {
                type: 'button',
                className: 'dsas-ghead',
                'aria-expanded': open ? 'true' : 'false',
                onClick: () => onToggle(g.key),
              },
              h('span', { className: 'dsas-caret' }, open ? '▾' : '▸'),
              h('span', { className: 'dsas-gtitle' }, g.title),
              h('span', { className: 'dsas-gcount' }, String(g.ids.length)),
            ),
            open ? h('div', null, g.ids.map((sid) => renderRow(sid))) : null,
          )
        }),
      )
    }

    /* ---------------------------------------------------------------- 主体 */

    /* ---------------------------------------------------- 侧边栏图标 */

    /**
     * 侧边栏那颗图标。宿主给 ownerProps：{ size, active }。
     *
     * 用内联 SVG 画一条「灵魂」的意象：一个不闭合的圆 + 内部一个点 ——
     * 不闭合表示"还在长"，点是"核心"。不用 emoji，避免跨平台字形不一致。
     */
    function SoulIcon({ size = 18, active = false }) {
      const s = Number.isFinite(size) ? size : 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M20 12a8 8 0 1 1-3.2-6.4',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', {
          cx: 12,
          cy: 12,
          r: 2.6,
          fill: 'currentColor',
          opacity: active ? 1 : 0.75,
        }),
      )
    }

    /* ------------------------------------------------------ 整页面板 */

    /**
     * 主区页面：把设置页整块放进主区域，而不是挤在设置弹层里。
     *
     * 为什么这么放：设置弹层只有 ~700px 宽、还被强制滚动，
     * 而这里能放"总览 / 日记时间线 / 会话列表"之类要横向空间的东西。
     *
     * 顶部那条是自己画的标题栏（返回对话 / 标题 / 刷新），
     * 因为主区面板没有现成的 header 槽位。
     */
    function SoulPage(props) {
      const panel = (props && props.panel) || {}
      const [tick, setTick] = useState(0)
      const [leaving, setLeaving] = useState(false)

      const backToChat = () => {
        setLeaving(true)
        try {
          const layout = props && props.layout
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
        } catch {
          /* 跳不回去就让用户自己点侧边栏 */
        }
        setTick((n) => n + 1)
      }

      return h(
        'div',
        { className: 'dsas-page' },
        h(
          'header',
          { className: 'dsas-page-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsas-page-back',
              title: '回到对话',
              onClick: backToChat,
            },
            h(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              h('path', {
                d: 'M10 3.5 5.5 8 10 12.5',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
            '对话',
          ),
          h(
            'div',
            { className: 'dsas-page-title' },
            h(SoulIcon, { size: 18, active: true }),
            h('span', null, '记忆与人格'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsas-page-act',
              title: '重新读取',
              onClick: () => setTick((n) => n + 1),
            },
            h(
              'svg',
              { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              h('path', {
                d: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsas-page-body' },
          h(MemorySection, {
            key: 'page-' + tick,
            useWorkspaces: props && props.useWorkspaces,
            useSessions: props && props.useSessions,
            inPage: true,
          }),
        ),
      )
    }

    /**
     * 新版设置页。
     *
     * 按 tianhai 给的规格重排（2026-10-28）：
     *   记忆（状态灯，不给开关）
     *   快速创建人格
     *   默认日志 / 默认日记 / 默认时间 / 新会话默认人格
     *   会话管理（可折叠，按工作区分组；点开单会话显示它自己的设置）
     *   Agent 人格管理（字数预算 + 人格列表 + 编辑 / 打开目录 / 新建 / 打开话板）
     *   Tools（总闸关掉时其余变灰）
     *   出问题了（体检 + 可复制的错误区）
     *   保存 / 重新读取
     *
     * 只有这一套布局，平铺版不要了。
     */
    /** 老名字保留：设置页和整页都用它 */
    const MemorySection = SettingsPage

    function SettingsPage(props) {
      /*
       * ⚠️ 会话列表直接用宿主的 useSessions —— 就是侧边栏那份数据。
       *
       * 绕了一大圈才想明白：这个插件拿到的是标准 props，
       * 里面本来就有 useSessions / useWorkspaces，跟侧边栏用的是同一个 store。
       * 我却一直跑去后端读 workspace.json / projcache.json 自己拼，
       * 结果名字拼不出来、还多出一堆点不开的幽灵。
       *
       * summary 里该有的都有：sessionId / title / blank / cwd / updatedAt。
       * 拿不到 useSessions（比如测试环境）才退回后端接口。
       */
      /*
       * 当前打开的是哪个会话 —— 侧边栏只显示"当前这一个"空白会话。
       * 设置页拿不到（它不在对话里），主面板会传进来。
       * 拿不到时一律不显示空白会话（宁可比侧边栏少一行，也不多几十行）。
       */
      const currentSessionId = (props && props.currentSessionId) || null
      const sessionsHook = props && props.useSessions
      const useSess = typeof sessionsHook === 'function' ? sessionsHook : () => null
      const sessSnap = useSess((s) => s)
      const cfgHook = props && props.useWorkspaces
      const wsSnap = typeof cfgHook === 'function' ? cfgHook((s) => s) : null
      const wsItems = wsSnap && Array.isArray(wsSnap.items) ? wsSnap.items : []
      /*
       * 归档名单也在 useWorkspaces 的 snapshot 里（archivedSessionIds）。
       * 侧边栏不显示归档会话，我们也不能显示 —— 之前漏了这一步，
       * 于是「已归档」的那些全冒出来，看着像一堆未知会话。
       */
      const archivedIds = useMemo(() => {
        const list = wsSnap && Array.isArray(wsSnap.archivedSessionIds) ? wsSnap.archivedSessionIds : []
        return new Set(list.map(String))
      }, [wsSnap])

      const [config, setConfig] = useState(null)
      const [agents, setAgents] = useState([])
      // 每个 agent 的会话统计：{ name, sessions: { total, live, ids } }
      const [agentStats, setAgentStats] = useState([])
      // 归属表里留着、但实际已经不存在的会话
      const [ghosts, setGhosts] = useState([])
      // 已归档的人格：目录还在，只是从列表移走了
      const [archivedAgents, setArchivedAgents] = useState([])
      const [ownership, setOwnership] = useState({})
      const [registry, setRegistry] = useState(null)
      // 宿主给的会话列表（侧边栏那个来源）—— 列表以它为准
      const [hostSessions, setHostSessions] = useState([])
      const [board, setBoard] = useState('')
      const [status, setStatus] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(null)
      const [saved, setSaved] = useState(null)
      const [openGroups, setOpenGroups] = useState({})
      const [openSession, setOpenSession] = useState(null)
      const [flashSession, setFlashSession] = useState(null) // 刚跳过来的那个，闪一下
      /* 手动写日记的两步确认：0=没在问 1=问一遍 2=再问一遍（按钮换位置） */
      const [dailyAsk, setDailyAsk] = useState(0)
      /*
       * 数据目录：草稿 + 两步确认。
       *   rootDraft === null  → 显示当前生效的目录
       *   rootDraft !== null  → 用户改了，跟当前不一样就算 dirty
       *   rootAsk 0/1/2       → 没问 / 问一遍 / 再问一遍（按钮换位置）
       */
      const [rootDraft, setRootDraft] = useState(null)
      const [rootAsk, setRootAsk] = useState(0)
      const [rootMigrate, setRootMigrate] = useState(false)
      const [rootResult, setRootResult] = useState(null)
      const [dailyResult, setDailyResult] = useState(null)
      /*
       * 删除人格的两步确认。
       *   step 1 = 已经点了「删除」，正在问"确定吗"
       *   step 2 = 已经确认过，正在要求**手打人格名**
       *
       * 为什么分两步、按钮还不在同一位置：
       *   同一个位置连点两下是最常见的误操作 —— 手滑、双击、或者没看清。
       *   第二次的按钮换个地方，第一步的按钮**消失**，物理上连不起来。
       */
      const [delStep, setDelStep] = useState({ agent: '', step: 0 })
      const [openAgent, setOpenAgent] = useState(null)
      const [showMissing, setShowMissing] = useState(false)
      const [boot, setBoot] = useState(null)
      const [checkup, setCheckup] = useState(null)
      const [newAgent, setNewAgent] = useState('')
      const [editor, setEditor] = useState(null)
      const [toolsOpen, setToolsOpen] = useState(false)
      const [peopleOpen, setPeopleOpen] = useState(false)

      const load = useCallback(async () => {
        setErr(null)
        const [c, st, ag, pe, se, bo] = await Promise.all([
          jget('/config'),
          jget('/status'),
          jget('/agents'),
          jget('/persona'),
          jget('/sessions'),
          jget('/board'),
        ])
        if (c && c.ok) {
          setConfig(c.config)
          setSaved(JSON.stringify(c.config))
        } else setErr((c && c.error) || '读不到配置')
        if (st && st.ok) setStatus(st)
        if (ag && ag.ok) {
          setAgents(ag.agents || [])
          setAgentStats(ag.detail || [])
          setGhosts(ag.ghosts || [])
          setArchivedAgents(ag.archived || [])
        }
        if (pe && pe.ok) setOwnership(pe.ownership || {})
        if (se && se.ok) {
          setRegistry(se.registry)
          setHostSessions(se.sessions || [])
        } else if (se && se.error) {
          setErr(se.error)
        }
        if (bo && bo.ok) setBoard(bo.text || '')
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const patch = useCallback((fn) => {
        setConfig((prev) => {
          if (!prev) return prev
          const next = JSON.parse(JSON.stringify(prev))
          fn(next)
          return next
        })
      }, [])

      const dirty = Boolean(config) && JSON.stringify(config) !== saved

      const save = useCallback(async () => {
        if (!config) return
        setBusy('save')
        setErr(null)
        // rootIsDefault 是运行时算的，不落盘
        const payload = JSON.parse(JSON.stringify(config))
        delete payload.rootIsDefault
        const r = await jpost('/config', { config: payload })
        setBusy(null)
        if (!r || !r.ok) {
          setErr((r && r.error) || '保存失败')
          return
        }
        setSaved(JSON.stringify(config))
        if (r.hot === false) setErr(`存下了，但热挂没成功：${r.hotError || '重启生效'}`)
        load()
      }, [config, load])

      const pickPersona = useCallback(async (sessionId, agentId) => {
        setBusy('persona:' + sessionId)
        const r = await jpost('/persona', { sessionId, agentId })
        setBusy(null)
        if (!r || !r.ok) {
          setErr((r && r.error) || '写不进归属表')
          return
        }
        setOwnership(r.ownership || {})
      }, [])

      /*
       * ⚠️ 所有 hooks 必须在提前返回之前。
       * 之前 useMemo 写在了 `if (!config) return` 后面 —— 首帧 24 个 hook、
       * 配置到位后 25 个，React 直接抛错，整页白屏。
       */
      /**
       * 侧边栏那份会话（useSessions 的 snapshot）压成数组。
       * 结构是 { byId: { [id]: summary }, order: [...] } —— 用 byId。
       */
      const sidebarSessions = useMemo(() => {
        const byId = sessSnap && sessSnap.byId
        if (!byId || typeof byId !== 'object') return null
        const out = []
        for (const [id, sum] of Object.entries(byId)) {
          if (!sum) continue
          /*
           * 字段名照抄 host 的 projectList（dsh-api-session-controller）：
           *   displayTitle ← 已经算好「标题 → 目录名 → id」的兜底，侧边栏显示的就是它
           *   title        ← 原始标题，可能没有
           *   parentId     ← 父会话（**不是** parentSessionId）
           *   origin       ← 'subagent' 等
           *   blank        ← 新建但没说话
           */
          const name =
            (typeof sum.displayTitle === 'string' && sum.displayTitle) ||
            (typeof sum.title === 'string' && sum.title) ||
            ''
          out.push({
            id: String(id),
            name,
            blank: sum.blank === true,
            cwd: sum.cwd || null,
            origin: sum.origin || null,
            parentId: sum.parentId || null,
            updatedAt: typeof sum.updatedAt === 'number' ? sum.updatedAt : 0,
          })
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt)
        return out
      }, [sessSnap])

      /*
       * 列表来源：优先 useSessions（侧边栏那份），退回后端接口。
       * 登记表只用来"补"人格这类附加信息，不再决定有哪些会话。
       */
      /**
       * 侧边栏的可见性规则 —— 照抄 dsh-client-ui-workspace 的 sessionVisible：
       *
       *   if (session.origin === 'subagent') return false   // 子代理不显示
       *   if (session.blank && session.id !== current) return false
       *   return !archived.has(session.id)                  // 归档不显示
       *
       * 第二条是之前漏掉的：byId 里有几十条"空白会话"（新建了没说话），
       * 侧边栏只显示**当前正打开**的那一个（作为"新会话"占位行）。
       * 不筛掉它们，列表就比侧边栏多出一大截。
       *
       * 为什么不用"属于工作区"来筛：侧边栏按工作区分组显示，
       * 没有 worker 的会落在「未分组」—— 那是要显示的，不能筛。
       */
      /** 诊断用：这次渲染实际看到了什么、筛掉了什么 */
      const diag = useMemo(() => {
        const byId = (sessSnap && sessSnap.byId) || null
        const all = byId ? Object.keys(byId) : []
        const reasons = { subagent: 0, child: 0, blank: 0, archived: 0, kept: 0 }
        for (const id of all) {
          const r = byId[id] || {}
          if (r.origin === 'subagent') reasons.subagent += 1
          else if (r.blank === true && id !== currentSessionId) reasons.blank += 1
          else if (archivedIds.has(String(id))) reasons.archived += 1
          else reasons.kept += 1
        }
        return {
          hasHook: Boolean(byId),
          byIdTotal: all.length,
          archivedCount: archivedIds.size,
          workspaces: wsItems.length,
          workspaceSessions: wsItems.reduce((n, w) => n + (w.sessionIds || []).length, 0),
          reasons,
          sample: all.slice(0, 5),
        }
      }, [sessSnap, archivedIds, currentSessionId, wsItems])

      const sessionRows = useMemo(() => {
        const base = sidebarSessions
          ? sidebarSessions
          : (hostSessions || []).map((x) => ({
              id: String(x.id),
              name: x.name || '',
              blank: x.blank === true,
              cwd: x.cwd || null,
              origin: x.origin || null,
              parentId: x.parentId || null,
              updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : 0,
            }))
        return base.filter((r) => {
          if (r.origin === 'subagent') return false // 子代理不显示
          /* fork 分支要显示（缩进挂在父会话下），不按 parentId 过滤 */
          if (r.blank && r.id !== currentSessionId) return false // 空白只留当前那个
          if (archivedIds.has(r.id)) return false // 归档不显示
          return true
        })
      }, [sidebarSessions, hostSessions, archivedIds, currentSessionId])

      const sessions = useMemo(() => sessionRows.map((r) => r.id), [sessionRows])

      /** 宿主那条记录（有 blank / running / updatedAt / origin） */
      const hostOf = (sid) => sessionRows.find((x) => x.id === sid) || null

      // 放到 window 上：控制台敲 __DSAS_DIAG__ 就能看到
      try {
        if (typeof window !== 'undefined') {
          window.__DSAS_DIAG__ = {
            ...diag,
            /*
             * 排查"活动状态显示 undefined"用：
             * registryOk = /sessions 有没有正常返回登记表
             * registryRows = 登记表条数
             * sampleRow = 随便挑一条，看 firstSeen/lastSeen 在不在
             */
            registryOk: Boolean(registry && registry.sessions),
            registryRows: registry && registry.sessions ? Object.keys(registry.sessions).length : 0,
            sampleRow: (() => {
              const first = sessions[0]
              const r = first ? rowOf(first) : null
              return r ? { id: first, firstSeen: r.firstSeen, lastSeen: r.lastSeen } : null
            })(),
          }
        }
      } catch {
        /* 忽略 */
      }

      if (!config) {
        return h(
          'div',
          { className: 'dsas-wrap' },
          h('h2', { className: 'dsas-title' }, '记忆'),
          h('p', { className: 'dsas-sub' }, '正在读配置…'),
          err ? h('div', { className: 'dsas-err' }, err) : null,
        )
      }

      const parts = (status && status.parts) || {}
      const logOn = config.log && config.log.enabled !== false
      const injectOn = config.inject && config.inject.enabled !== false
      const daily = config.daily || {}
      const dailyOn = daily.enabled !== false
      const toolsOn = config.tools && config.tools.enabled !== false
      const sections = (config.inject && config.inject.sections) || {}
      const budget = (config.inject && config.inject.budget) || {}
      const defAgent = (config.inject && config.inject.defaultAgent) || ''

      const rowOf = (sid) => (registry && registry.sessions && registry.sessions[sid]) || null
      const labelOf = (sid) => {
        const h = hostOf(sid)
        if (h && h.name) return h.name
        const row = rowOf(sid)
        if (row && row.name) return String(row.name)
        // 真没名字：用 id 尾巴，比「未命名」有用
        return sid.length > 14 ? `…${sid.slice(-8)}` : sid
      }

      // 宿主列出来的全部显示 —— 不管有没有对过话、今天有没有活动
      const liveSessions = sessions
      const missingCount = 0
      const shownSessions = sessions
      const groups = groupSessions(shownSessions, wsItems)

      /**
       * 跳到会话管理里的某个会话：展开它所在的分组、滚到它、闪一下。
       *
       * 为什么三步都要（2026-10-29 用户反馈"点了没反应"）：
       *   ① 只 setOpenSession —— 分组是收起的，行根本没渲染
       *   ② 展开分组但不滚动 —— 会话管理在第 4 节，视口还在底下的人格区
       *   ③ 滚过去了但没提示 —— 一屏几十行，不知道哪个是它
       */
      const jumpToSession = (sid) => {
        setOpenSession(sid)
        setOpenGroups((m) => {
          const g = groupSessions([sid], wsItems)[0]
          return g ? { ...m, [g.key]: true } : m
        })
        setFlashSession(sid)
        const scrollTo = (tries) => {
          if (typeof document === 'undefined') return
          const el = document.querySelector('[data-dsas-session="' + String(sid).replace(/"/g, '') + '"]')
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' })
            return
          }
          if (tries > 0) setTimeout(() => scrollTo(tries - 1), 40)
        }
        setTimeout(() => scrollTo(8), 40)
        // 闪完就清掉，免得重渲染又闪
        setTimeout(() => setFlashSession(null), 2400)
      }

      /** 数据目录真的改了没（只比字符串，不做路径归一 —— 免得误判 dirty） */
      const rootDirty = Boolean(
        rootDraft !== null &&
          status &&
          status.rootDir &&
          String(rootDraft).trim() &&
          String(rootDraft).trim() !== String(status.rootDir),
      )

      const isGroupOpen = (key) => Boolean(openGroups[key])
      const toggleGroup = (key) => setOpenGroups((m) => ({ ...m, [key]: !m[key] }))

      /* ── 体检 ── */
      /**
       * 体检。
       *
       * ⚠️ 以前直接把 status().errors 抖出来，但那是**进程内累积的历史**（最多 50 条）——
       * 几小时前的旧错也会被算进来，人看到的就是"一体检一堆红"。
       * 现在只认最近 5 分钟内的错，其余单独计数说明。
       */
      const runCheckup = async () => {
        setBusy('checkup')
        const r = await jget('/status')
        setBusy(null)
        const issues = []
        const p = (r && r.parts) || {}
        for (const [k, label] of [
          ['Sessions', '会话登记'],
          ['Log', '日志'],
          ['Inject', '注入'],
          ['Tools', '工具'],
          ['Daily', '日记'],
        ]) {
          if (p[k] !== 'on') issues.push(`${label}没在跑（现在：${p[k] || '未知'}）`)
        }

        const now = Date.now()
        const WINDOW = 5 * 60 * 1000
        const within = (e) => {
          const t = Date.parse(e && e.at)
          return Number.isFinite(t) && now - t <= WINDOW
        }

        /*
         * 只有**真错误**才算问题。警告单独列，不影响"体检正常"。
         *
         * 为什么分（2026-10-29 用户反馈）：
         * "启动时还没扫到会话"那条其实是防护正常工作的提示，
         * 数据一点没丢，但一直躺在 errors 里让体检变红 —— 看着像坏了。
         */
        const all = (r && r.errors) || []
        const recent = all.filter(within)
        for (const e of recent.slice(-5)) {
          const hm = new Date(Date.parse(e.at)).toLocaleTimeString()
          issues.push(`[${hm}] ${e.text}`)
        }

        const allWarn = (r && r.warnings) || []
        const recentWarn = allWarn.filter(within)
        const warns = recentWarn.slice(-5).map((e) => {
          const hm = new Date(Date.parse(e.at)).toLocaleTimeString()
          return `[${hm}] ${e.text}`
        })

        setCheckup({
          ok: issues.length === 0,
          issues,
          warns,
          at: new Date().toLocaleString(),
          older: all.length - recent.length,
        })
      }

      const switchOf = (on, onChange, disabled) =>
        h(Switch, { on, onChange, disabled })

      return h(
        'div',
        { className: 'dsas-wrap' },

        h('h2', { className: 'dsas-title' }, '记忆'),
        h('p', { className: 'dsas-sub' }, '这套东西管着 Ta 记不记得事、像不像自己。'),

        err ? h('div', { className: 'dsas-err' }, err) : null,

        /* ═══ 1. 状态灯（不给开关） ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h('div', { className: 'dsas-block-head' }, '记忆'),
          h(
            'p',
            { className: 'dsas-hint' },
            '这几项目前必须开着 —— 少一个，Ta 就不完整。绿 = 正常，红 = 报错。',
          ),
          h(
            'div',
            { className: 'dsas-lights' },
            ...['Log', 'Inject', 'Daily'].map((k) =>
              h(
                'span',
                { key: 'light-' + k, className: 'dsas-light', 'data-on': parts[k] === 'on' ? '1' : '0' },
                h('i', { className: 'dsas-light-dot', 'data-on': parts[k] === 'on' ? '1' : '0' }),
                { Log: '日志', Inject: '注入', Daily: '写日记' }[k],
              ),
            ),
          ),
        ),

        /* ═══ 2. 快速创建人格 ═══ */
        h(
          'div',
          { className: 'dsas-quick' },
          h(
            'div',
            { className: 'dsas-quick-main' },
            h('div', { className: 'dsas-quick-title' }, '根据当前会话快速创建人格'),
            h('p', { className: 'dsas-hint' }, '起个名字，它会读完这段对话，把人格、记忆、认识的人自己写出来。'),
          ),
          h('button', { type: 'button', className: 'dsas-btn', onClick: () => setBoot({ sessionId: '' }) }, '创建'),
        ),

        /* ═══ 3. 默认 ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h('div', { className: 'dsas-block-head' }, '默认'),
          h(
            'div',
            { className: 'dsas-rows' },
            /*
             * 数据目录 —— 唯一一个会动 paths 的设置。
             * 改了之后人格、日记、日志、登记表全部换地方，
             * 所以只在"真改了"才允许按，并且两步确认。
             */
            h(
              Row,
              {
                label: '数据目录',
                hint: '人格、日记、日志、登记表都放这里。改了不会自动搬走旧数据。',
              },
              h(
                'div',
                { className: 'dsas-rootdir' },
                h('input', {
                  className: 'dsas-input dsas-rootdir-input',
                  type: 'text',
                  spellCheck: false,
                  placeholder: (status && status.rootDir) || '默认位置',
                  value: rootDraft === null ? ((status && status.rootDir) || '') : rootDraft,
                  onChange: (e) => setRootDraft(e.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsas-btn2',
                    disabled: busy === 'root' || !rootDirty,
                    title: rootDirty ? '' : '和现在一样，没改',
                    onClick: () => setRootAsk(1),
                  },
                  busy === 'root' ? '换着…' : '换到这儿',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsas-link',
                    onClick: () => setRootDraft(null),
                  },
                  '还原',
                ),
              ),
            ),

            h(
              Row,
              {
                label: '默认日志记录',
                hint: '开着的时候，每个有人格的会话都记；关掉的时候，每个会话按自己的设置走。',
              },
              switchOf(Boolean(config.log.defaults && config.log.defaults.log), (v) =>
                patch((c) => (c.log.defaults.log = v)),
              ),
            ),
            h(
              Row,
              { label: '默认日记记录', hint: '同样：开着 = 有人格的会话都写。' },
              switchOf(dailyOn, (v) => patch((c) => (c.daily.enabled = v))),
            ),
            h(
              Row,
              {
                label: '上下文到多少写交接总结',
                hint: '到占比就叫 Ta 写一份"我干到哪了"的总结，存到 agents/<人格>/summary/。只在它不忙的时候叫。',
              },
              h(
                'select',
                {
                  className: 'dsas-select dsas-pick-sm',
                  value: String((config.summary && config.summary.threshold) || 0.8),
                  onChange: (e) => patch((c) => (c.summary = { threshold: Number(e.target.value) })),
                },
                ...[0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9].map((v) =>
                  h('option', { key: 'sm-' + v, value: String(v) }, Math.round(v * 100) + '%'),
                ),
              ),
            ),
            h(
              Row,
              { label: '默认写日记时间', hint: '每天晚上这个点叫醒。' },
              h('input', {
                type: 'time',
                className: 'dsas-input dsas-time',
                value: daily.time || '23:30',
                onChange: (e) => patch((c) => (c.daily.time = e.target.value || '23:30')),
              }),
            ),
            h(
              Row,
              { label: '新会话默认人格', hint: '新开的对话自动用它。「无人格」= 新会话默认当临时会话。' },
              h(
                'select',
                {
                  className: 'dsas-select dsas-default-pick',
                  value: defAgent,
                  onChange: (e) => patch((c) => (c.inject.defaultAgent = e.target.value || null)),
                },
                h('option', { value: '' }, '无人格（临时会话）'),
                agents.map((a) => h('option', { key: 'def-' + a, value: a }, a)),
              ),
            ),
          ),
        ),

        /* ═══ 4. 会话管理 ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h(
            'div',
            { className: 'dsas-block-head dsas-block-head-row' },
            h('span', null, '会话管理'),
            h(
              'span',
              { className: 'dsas-sec-meta' },
              `${liveSessions.length} 个${missingCount ? ` · ${missingCount} 个不在了` : ''}`,
            ),
          ),
          missingCount > 0
            ? h(
                'label',
                { className: 'dsas-inline-label dsas-hint' },
                h('input', {
                  type: 'checkbox',
                  checked: showMissing,
                  onChange: (e) => setShowMissing(e.target.checked),
                }),
                `显示不在了的（${missingCount}）`,
              )
            : null,

          groups.length === 0
            ? h('p', { className: 'dsas-empty' }, '登记表还是空的')
            : groups.map((g) =>
                h(
                  'div',
                  { key: 'g-' + g.key, className: 'dsas-gblock' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsas-ghead',
                      'data-open': isGroupOpen(g.key) ? '1' : '0',
                      onClick: () => toggleGroup(g.key),
                    },
                    h(
                      'span',
                      { className: 'dsas-caret', 'data-open': isGroupOpen(g.key) ? '1' : '0' },
                      h(
                        'svg',
                        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
                        h('path', {
                          d: 'M4.5 3 7.5 6 4.5 9',
                          stroke: 'currentColor',
                          strokeWidth: 1.4,
                          strokeLinecap: 'round',
                          strokeLinejoin: 'round',
                        }),
                      ),
                    ),
                    h('span', { className: 'dsas-gtitle' }, g.title),
                    h('span', { className: 'dsas-gcount' }, String(g.ids.length)),
                  ),
                  isGroupOpen(g.key)
                    ? h('div', null, g.ids.map((sid) => sessionRow(sid)))
                    : null,
                ),
              ),
        ),

        /* ═══ 5. Agent 人格管理 ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h(
            'div',
            { className: 'dsas-block-head dsas-block-head-row' },
            h('span', null, 'Agent 人格管理'),
            h('span', { className: 'dsas-sec-meta' }, `${agents.length} 个`),
          ),

          /* 字数预算 */
          h(
            'div',
            { className: 'dsas-budget' },
            h('div', { className: 'dsas-budget-title' }, '字数预算'),
            h(
              'p',
              { className: 'dsas-hint' },
              '每轮往系统提示里塞多少字。塞太多费钱也让她分心，所以有上限；超了按「人格 → 日记 → 路标」的顺序砍掉后面的。路标是"去哪翻"那句，最后才砍。',
            ),
            h(
              'div',
              { className: 'dsas-budget-grid' },
              ...[
                ['total', '总上限', '四段加起来最多多少字'],
                ['persona', '人格', '"你是谁"那段最多多少字'],
                ['diary', '日记', '最近一篇的总结最多多少字'],
                ['signpost', '路标', '"去哪翻"那句最多多少字'],
              ].map(([k, label, tip]) =>
                h(
                  'label',
                  { key: 'bud-' + k, className: 'dsas-budget-item', title: tip },
                  h('span', { className: 'dsas-budget-label' }, label),
                  h('input', {
                    type: 'number',
                    min: 0,
                    step: 50,
                    className: 'dsas-input dsas-num',
                    value: budget[k] ?? 0,
                    onChange: (e) =>
                      patch((c) => {
                        c.inject.budget[k] = Number(e.target.value) || 0
                      }),
                  }),
                ),
              ),
            ),
          ),

          /* 人格列表 */
          agents.length === 0
            ? h('p', { className: 'dsas-empty' }, h('strong', null, '还没有人格'), '点下面的「新建人格」起一个')
            : agents.map((a) =>
                h(
                  'div',
                  { key: 'a-' + a, className: 'dsas-gblock' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsas-ghead',
                      'data-open': openAgent === a ? '1' : '0',
                      onClick: () => setOpenAgent(openAgent === a ? null : a),
                    },
                    h(
                      'span',
                      { className: 'dsas-caret', 'data-open': openAgent === a ? '1' : '0' },
                      h(
                        'svg',
                        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
                        h('path', {
                          d: 'M4.5 3 7.5 6 4.5 9',
                          stroke: 'currentColor',
                          strokeWidth: 1.4,
                          strokeLinecap: 'round',
                          strokeLinejoin: 'round',
                        }),
                      ),
                    ),
                    h('span', { className: 'dsas-gtitle' }, a),
                    /*
                     * 名下有几个会话。
                     *
                     * 后端只给 total —— 它已经在服务端筛过了：
                     * 只算"侧边栏可见 且 不是空壳"的。
                     * 所以这里不需要再区分 live/活跃，那个字段已经没有了。
                     */
                    (() => {
                      const st = (agentStats.find((x) => x.name === a) || {}).sessions
                      const n = st && Number.isFinite(st.total) ? st.total : 0
                      return h(
                        'span',
                        {
                          className: 'dsas-gcount',
                          title: n === 0 ? '还没有会话归到这个人格' : `${n} 个会话归到这个人格`,
                        },
                        `${n} 会话`,
                      )
                    })(),
                    defAgent === a ? h('span', { className: 'dsas-tag' }, '默认') : null,
                  ),
                  openAgent === a
                    ? h(
                        'div',
                        { className: 'dsas-detail' },
                        /* 这个人格名下的会话：点一行能跳到那个会话 */
                        (() => {
                          const st = (agentStats.find((x) => x.name === a) || {}).sessions
                          const ids = (st && st.ids) || []
                          if (ids.length === 0) {
                            return h(
                              'div',
                              { className: 'dsas-detail-row' },
                              h(
                                'div',
                                null,
                                h('div', { className: 'dsas-detail-label' }, '会话'),
                                h('div', { className: 'dsas-detail-hint' }, '还没有会话归到这个人格'),
                              ),
                            )
                          }
                          return h(
                            'div',
                            { className: 'dsas-detail-row', style: { flexDirection: 'column', alignItems: 'stretch' } },
                            h(
                              'div',
                              null,
                              h('div', { className: 'dsas-detail-label' }, `会话（${ids.length} 个）`),
                              h(
                                'div',
                                { className: 'dsas-detail-hint' },
                                '点一个能在会话管理里看到它的设置',
                              ),
                            ),
                            h(
                              'div',
                              { className: 'dsas-sesslist' },
                              ...ids.map((sid) =>
                                h(
                                  'button',
                                  {
                                    key: 'as-' + sid,
                                    type: 'button',
                                    className: 'dsas-sesschip',
                                    title: sid,
                                    onClick: () => jumpToSession(sid),
                                  },
                                  labelOf(sid),
                                ),
                              ),
                            ),
                          )
                        })(),
                        h(
                          'div',
                          { className: 'dsas-detail-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsas-btn2',
                              onClick: async () => {
                                setBusy('open:' + a)
                                const r = await jpost('/agents/open', { agent: a })
                                setBusy(null)
                                if (!r || r.ok !== true) alert((r && r.error) || '打不开')
                              },
                            },
                            '在资源管理器中打开',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsas-btn2',
                              onClick: async () => {
                                const r = await jget('/agents/file?agent=' + encodeURIComponent(a))
                                if (!r || r.ok !== true) {
                                  setErr((r && r.error) || '读不到人格文件')
                                  return
                                }
                                setEditor({ agent: a, text: r.text, mtime: r.mtime, note: '' })
                              },
                            },
                            '编辑 ' + a,
                          ),

                          /*
                           * 删除人格：两步确认，按钮不在同一位置。
                           *
                           * 第一次点「删除」→ 该按钮消失，换成一段文字说明 + 一个
                           * 【偏右下的】「继续」；第二步要求手打人格名，
                           * 而且最终按钮在**最右下**，和入口隔开一屏。
                           * 物理上连不起来，就不怕双击和手滑。
                           */
                          h('div', { className: 'dsas-danger' },
                            delStep.agent === a && delStep.step > 0
                              ? h(
                                  'div',
                                  { className: 'dsas-danger-box' },
                                  h(
                                    'div',
                                    { className: 'dsas-danger-title' },
                                    `要归档「${a}」吗？`
                                  ),
                                  h(
                                    'div',
                                    { className: 'dsas-danger-hint' },
                                    `它的目录里有 ${(agentStats.find((x) => x.name === a) || {}).sessions?.total || 0} 个会话的归属、还有日记和认识的人。`,
                                  ),
                                  h('div', { className: 'dsas-danger-hint' }, '文件一个都不删。目录改名为「', a, '.archived-时间」，随时可以取消归档让它回来。'),

                                  delStep.step === 1
                                    ? h(
                                        'div',
                                        { className: 'dsas-danger-actions' },
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'dsas-btn2',
                                            onClick: () => setDelStep({ agent: '', step: 0 }),
                                          },
                                          '算了',
                                        ),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'dsas-btn2 dsas-danger-next',
                                            onClick: () => setDelStep({ agent: a, step: 2 }),
                                          },
                                          '我确定，继续 →',
                                        ),
                                      )
                                    : h(
                                        'div',
                                        { className: 'dsas-danger-actions' },
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'dsas-btn2',
                                            onClick: () => setDelStep({ agent: '', step: 0 }),
                                          },
                                          '取消',
                                        ),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'dsas-danger-final',
                                            disabled: delStep.typed !== a,
                                            title: delStep.typed === a ? '' : `先在下面输入 ${a}` ,
                                            onClick: async () => {
                                              setBusy('arch:' + a)
                                              const r = await jpost('/agents/archive', { agent: a, confirm: a })
                                              setBusy(null)
                                              if (!r || r.ok !== true) {
                                                setErr((r && r.error) || '归档失败')
                                                return
                                              }
                                              setDelStep({ agent: '', step: 0 })
                                              load()
                                            },
                                          },
                                          busy === 'arch:' + a ? '归档中…' : '确认归档',
                                        ),
                                      ),

                                  /* 第二步：手打人格名才能按最终按钮 */
                                  delStep.step === 2
                                    ? h(
                                        'div',
                                        { className: 'dsas-danger-typed' },
                                        h('div', { className: 'dsas-danger-hint' }, '在下面输入人格名确认：'),
                                        h('input', {
                                          className: 'dsas-input dsas-id',
                                          placeholder: a,
                                          value: delStep.typed || '',
                                          onChange: (e) => setDelStep({ agent: a, step: 2, typed: e.target.value }),
                                        }),
                                      )
                                    : null,
                                )
                              : h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dsas-link-danger',
                                    onClick: () => setDelStep({ agent: a, step: 1 }),
                                  },
                                  '归档这个人格',
                                ),
                          ),
                        ),
                      )
                    : null,
                ),
              ),

          /* 新建人格 */
          h(
            'div',
            { className: 'dsas-newagent' },
            h('input', {
              className: 'dsas-input dsas-id',
              placeholder: '人格目录名，例如 xiaoyu',
              value: newAgent,
              onChange: (e) => setNewAgent(e.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsas-btn2',
                disabled: busy === 'newagent' || !newAgent.trim(),
                onClick: async () => {
                  const id = newAgent.trim()
                  if (!id) return
                  setBusy('newagent')
                  const r = await jpost('/agents/new', { id })
                  setBusy(null)
                  if (!r || r.ok !== true) {
                    alert((r && r.error) || '建不出来')
                    return
                  }
                  setNewAgent('')
                  load()
                },
              },
              busy === 'newagent' ? '正在建…' : '新建人格',
            ),
          ),

          /* 共享话板 */
          h(
            'div',
            { className: 'dsas-newagent' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsas-btn2',
                onClick: async () => {
                  const r = await jpost('/board/open', {})
                  if (!r || r.ok !== true) alert((r && r.error) || '打不开')
                },
              },
              '在资源管理器中打开共享话板',
            ),

          /*
           * 已归档的人格：目录还在，只是从上面的列表移走了。
           * 归档不是删除 —— 点「取消归档」就能回来（会话归属要重新选）。
           */
          archivedAgents.length > 0
            ? h(
                'div',
                { className: 'dsas-archived' },
                h(
                  'div',
                  { className: 'dsas-danger-hint' },
                  `已归档 ${archivedAgents.length} 个（文件都还在，随时能取消归档）`,
                ),
                ...archivedAgents.map((x) =>
                  h(
                    'div',
                    { key: 'arc-' + x.dir, className: 'dsas-archived-row' },
                    h('span', { className: 'dsas-archived-name' }, x.name),
                    h('span', { className: 'dsas-archived-at' }, `${x.at.slice(0, 4)}-${x.at.slice(4, 6)}-${x.at.slice(6, 8)} ${x.at.slice(9, 11)}:${x.at.slice(11, 13)}`),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsas-btn2',
                        disabled: busy === 'unarch:' + x.name,
                        onClick: async () => {
                          setBusy('unarch:' + x.name)
                          const r = await jpost('/agents/unarchive', { agent: x.name })
                          setBusy(null)
                          if (!r || r.ok !== true) {
                            setErr((r && r.error) || '取消归档失败')
                            return
                          }
                          setErr(null)
                          load()
                        },
                      },
                      busy === 'unarch:' + x.name ? '恢复中…' : '取消归档',
                    ),
                  ),
                ),
              )
            : null,
          ),

          /*
           * 幽灵会话清理：归属表里留着、实际上已经被删掉的会话。
           * 不清理的话，人格列表上的"5 个会话"里可能只有 1 个是真的。
           */
          ghosts.length > 0
            ? h(
                'div',
                { className: 'dsas-newagent dsas-ghostbar' },
                h(
                  'span',
                  { className: 'dsas-hint', style: { margin: 0, flex: 1, minWidth: 200 } },
                  `有 ${ghosts.length} 个会话在归属表里，但其实已经不在了（删了或换过 profile）`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsas-btn2',
                    disabled: busy === 'prune',
                    title: '只删归属表那一条记录，日志和日记一个字不动',
                    onClick: async () => {
                      setBusy('prune')
                      const r = await jpost('/agents/prune-ghosts', {})
                      setBusy(null)
                      if (!r || r.ok !== true) {
                        setErr((r && r.error) || '清不掉')
                        return
                      }
                      load()
                    },
                  },
                  busy === 'prune' ? '清理中…' : `清掉这 ${ghosts.length} 条`,
                ),
              )
            : null,
        ),

        /* ═══ 6. Tools ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsas-block-head dsas-block-head-btn',
              'data-open': toolsOpen ? '1' : '0',
              onClick: () => setToolsOpen(!toolsOpen),
            },
            h(
              'span',
              { className: 'dsas-caret', 'data-open': toolsOpen ? '1' : '0' },
              h(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
                h('path', {
                  d: 'M4.5 3 7.5 6 4.5 9',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
            ),
            h('span', { className: 'dsas-gtitle' }, 'Tools'),
            h('span', { className: 'dsas-sec-meta' }, toolsOn ? '开着' : '关着'),
          ),
          toolsOpen
            ? h(
                'div',
                { className: 'dsas-tools' },
                h(
                  Row,
                  { label: '工具总开关', hint: '关掉 = Ta 够不到记忆，只能凭印象说话。关掉后下面四项不可单独设置。' },
                  switchOf(toolsOn, (v) => patch((c) => (c.tools.enabled = v))),
                ),
                ...[
                  ['index', 'memory_index', '看自己的记忆地图，刚醒来时最有用'],
                  ['find', 'memory_find', '按关键词找人、找事'],
                  ['open', 'memory_open', '打开一本读全文'],
                  ['diary', 'memory_diary', '按日期看日记的总结'],
                  ['recall', 'memory_recall', '查那天的原始对话（原文很长，慎用）'],
                ].map(([k, name, hint]) =>
                  h(
                    Row,
                    { key: 't-' + k, label: name, hint },
                    switchOf(
                      config.tools[k] !== false,
                      (v) => patch((c) => (c.tools[k] = v)),
                      !toolsOn,
                    ),
                  ),
                ),
              )
            : null,
        ),

        /* ═══ 6.5 隐私边界 ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h('div', { className: 'dsas-block-head' }, '隐私边界'),
          h(
            'p',
            { className: 'dsas-hint' },
            'agents/ 下每个目录属于一个人。别人碰它的人格的读写工具会被挡下 —— 这一层不受 DSH 沙箱模式影响，完全权限也拦。',
          ),
          h(
            'div',
            { className: 'dsas-rows' },
            h(
              Row,
              {
                label: '跨 agent 访问时弹窗确认',
                hint: '开着 = 交给 DSH 的确认弹窗（需要它能正常弹）。关着 = 直接拒绝，理由写在错误里 —— 更稳，一定看得到为什么被拦。',
              },
              h(Switch, {
                on: Boolean(config.privacy && config.privacy.allowPrompt),
                onChange: (v) => patch((c) => (c.privacy = { allowPrompt: v })),
              }),
            ),
            h(
              Row,
              { label: '命令行的洞', hint: 'ops_bash 不拦：命令里能拼路径、能 cd，字符串上做边界防不住。那部分靠提示词约束。' },
              h('span', { className: 'dsas-static' }, '已知'),
            ),
          ),
        ),

        /* ═══ 7. 出问题了 ═══ */
        h(
          'section',
          { className: 'dsas-block' },
          h('div', { className: 'dsas-block-head' }, '出问题了'),
          h(
            'div',
            { className: 'dsas-rows' },
            h(
              Row,
              { label: '体检', hint: '检查五块是不是都在跑、有没有报错。' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsas-btn2',
                  disabled: busy === 'checkup',
                  onClick: runCheckup,
                },
                busy === 'checkup' ? '正在查…' : '开始体检',
              ),

            /*
             * 手动跑一轮写日记。
             *
             * 定时器一天只跑一次，出问题没法当场验证。
             * 这个按钮直接走同一个 runOnce，force 忽略"今天已经叫过"。
             * 跟到点自动叫走同一条链路，会话会正常写。
             */
            h(
              Row,
              {
                label: '立刻写日记',
                hint: '不等晚上，现在就按筛选条件叫一遍。和到点自动叫完全一样 —— 会话会正常写。',
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsas-btn2',
                  disabled: busy === 'daily-run',
                  onClick: () => setDailyAsk(1),
                },
                busy === 'daily-run' ? '正在叫…' : '跑一轮',
              ),
            ),
            ),
          ),
          checkup
            ? h(
                'div',
                { className: 'dsas-checkup' },
                h(
                  'div',
                  { className: 'dsas-checkup-head' },
                  h(
                    'span',
                    { className: 'dsas-checkup-ok', 'data-ok': checkup.ok ? '1' : '0' },
                    checkup.ok ? '体检正常' : `${checkup.issues.length} 个问题`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsas-link',
                      onClick: () => {
                        const text = checkup.ok
                          ? '体检正常'
                          : checkup.issues.map((i) => `error: ${i}`).join('\\n')
                        try {
                          navigator.clipboard.writeText(text)
                        } catch {
                          /* 复制不了就让用户自己选 */
                        }
                      },
                    },
                    '复制',
                  ),
                ),
                h(
                  'pre',
                  { className: 'dsas-out dsas-checkup-out' },
                  checkup.ok
                    ? '体检正常'
                    : checkup.issues.map((i) => `error: ${i}`).join('\\n'),
                ),

                /*
                 * 警告单独一块。它们**不影响上面的"体检正常"** ——
                 * 比如"启动时还没扫到会话"，防护按设计工作了，数据没丢。
                 */
                (checkup.warns || []).length > 0
                  ? h(
                      'div',
                      { className: 'dsas-checkup-warns' },
                      h(
                        'div',
                        { className: 'dsas-checkup-warnhead' },
                        `${checkup.warns.length} 条提示（不是问题）`,
                      ),
                      h(
                        'pre',
                        { className: 'dsas-out dsas-checkup-warnout' },
                        checkup.warns.map((w) => `warn: ${w}`).join(String.fromCharCode(10)),
                      ),
                    )
                  : null,
              )
            : null,
        ),

        /* ═══ 保存 ═══ */
        h(
          'div',
          { className: 'dsas-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsas-btn',
              disabled: busy === 'save',
              onClick: save,
            },
            busy === 'save' ? '保存中…' : '保存',
          ),
          h('button', { type: 'button', className: 'dsas-btn2', onClick: load, disabled: busy === 'save' }, '重新读取'),
          dirty ? h('span', { className: 'dsas-dirty' }, '有改动还没保存') : null,
        ),

        /* 弹窗 */
        h(BootstrapDialog, {
          open: Boolean(boot),
          sessionId: (boot && boot.sessionId) || '',
          sessions: liveSessions,
          labels: Object.fromEntries(liveSessions.map((sid) => [sid, labelOf(sid)])),
          onClose: () => {
            setBoot(null)
            load()
          },
          onDone: () => load(),
        }),

        /*
         * 手动跑日记的两步确认。
         *
         * 为什么也做两步：它会真的往所有符合条件的会话里投消息，
         * 那些会话会当场开始写日记。误触的代价不是零 ——
         * 所以第一步问「要跑吗」，第二步换成"真的吗"并且按钮挪位置。
         */
        dailyAsk > 0
          ? h(
              'div',
              { className: 'dsas-modal-mask' },
              h(
                'div',
                { className: 'dsas-modal' },
                h('div', { className: 'dsas-modal-title' }, dailyAsk === 1 ? '现在就跑一轮写日记？' : '确认：真的现在跑？'),
                dailyAsk === 1
                  ? h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, '会按筛选条件（今天动过、有人格、不忙、有内容）挑出会话，给它们各投一条叫醒消息。'),
                      h('p', { className: 'dsas-hint' }, '被叫到的会话会当场开始写日记，和到点自动叫完全一样。'),
                      h('p', { className: 'dsas-hint' }, '不影响今天到点的定时任务 —— 那是分开记的。'),
                      h(
                        'div',
                        { className: 'dsas-modal-actions' },
                        h('button', { type: 'button', className: 'dsas-btn2', onClick: () => setDailyAsk(0) }, '算了'),
                        h('button', { type: 'button', className: 'dsas-btn', onClick: () => setDailyAsk(2) }, '继续'),
                      ),
                    )
                  : h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, '这一步之后就没有别的确认了。'),
                      h(
                        'div',
                        { className: 'dsas-modal-actions' },
                        h('button', { type: 'button', className: 'dsas-btn2', onClick: () => setDailyAsk(0) }, '取消'),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsas-btn',
                            disabled: busy === 'daily-run',
                            onClick: async () => {
                              setBusy('daily-run')
                              setDailyResult(null)
                              const r = await jpost('/daily/run', {})
                              setBusy(null)
                              setDailyAsk(0)
                              setDailyResult(r)
                              if (r && r.ok) load()
                            },
                          },
                          busy === 'daily-run' ? '正在跑…' : '立刻跑',
                        ),
                      ),
                    ),
              ),
            )
          : null,

        /*
         * 换数据目录的两步确认。
         *
         * 这是最危险的一个设置：它会把人格、日记、日志、登记表全部换地方。
         * 所以第一步说清"旧数据不会自动搬"，第二步按钮换位置，
         * 并且提供"连旧数据一起复制过去"的选项 —— 默认不复制。
         */
        rootAsk > 0
          ? h(
              'div',
              { className: 'dsas-modal-mask' },
              h(
                'div',
                { className: 'dsas-modal' },
                h('div', { className: 'dsas-modal-title' }, rootAsk === 1 ? '要把数据目录换掉吗？' : '确认：真的换？'),
                rootAsk === 1
                  ? h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, '从：', h('code', null, (status && status.rootDir) || '（默认）')),
                      h('p', { className: 'dsas-hint' }, '到：', h('code', null, String(rootDraft || '').trim())),
                      h('p', { className: 'dsas-hint' }, '换完之后，人格、日记、日志、登记表都在新目录里找。'),
                      h('p', { className: 'dsas-hint' },
                        '⚠ 旧目录里的东西**不会自动搬过去**。想让它们跟着走，下面那个勾要打上。',
                      ),
                      h('label', { className: 'dsas-rootdir-copy' },
                        h('input', {
                          type: 'checkbox',
                          checked: rootMigrate,
                          onChange: (e) => setRootMigrate(e.target.checked),
                        }),
                        ' 把旧目录的内容复制到新目录（原目录不删）',
                      ),
                      h(
                        'div',
                        { className: 'dsas-modal-actions' },
                        h('button', { type: 'button', className: 'dsas-btn2', onClick: () => setRootAsk(0) }, '算了'),
                        h('button', { type: 'button', className: 'dsas-btn', onClick: () => setRootAsk(2) }, '继续'),
                      ),
                    )
                  : h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, '这一步之后立刻生效，没有别的确认了。'),
                      h('p', { className: 'dsas-hint' }, rootMigrate
                        ? '会先复制旧数据，再切过去。'
                        : '不复制，旧数据留在原处。'),
                      h(
                        'div',
                        { className: 'dsas-modal-actions' },
                        h('button', { type: 'button', className: 'dsas-btn2', onClick: () => setRootAsk(0) }, '取消'),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsas-btn',
                            disabled: busy === 'root',
                            onClick: async () => {
                              setBusy('root')
                              setRootAsk(0)
                              const r = await jpost('/config/root', {
                                rootDir: String(rootDraft || '').trim(),
                                migrate: rootMigrate,
                              })
                              setBusy(null)
                              if (!r || r.ok !== true) {
                                setErr((r && r.error) || '换不了')
                                return
                              }
                              setErr(null)
                              setRootDraft(null)
                              setRootMigrate(false)
                              setRootResult(r)
                              load()
                            },
                          },
                          busy === 'root' ? '换着…' : '立刻换',
                        ),
                      ),
                    ),
              ),
            )
          : null,

        /* 换完的结果 */
        rootResult
          ? h(
              'div',
              {
                className: 'dsas-modal-mask',
                onClick: (e) => {
                  if (e && e.target === e.currentTarget) setRootResult(null)
                },
              },
              h(
                'div',
                { className: 'dsas-modal' },
                h('div', { className: 'dsas-modal-title' }, rootResult.changed ? '换好了' : '没换'),
                rootResult.changed
                  ? h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, '现在的数据目录：', h('code', null, rootResult.rootDir)),
                      rootResult.migrated
                        ? h('p', { className: 'dsas-hint' }, '旧数据已复制过来了（原目录没删）。')
                        : h('p', { className: 'dsas-hint' }, '旧数据留在原目录，没动。'),
                      rootResult.migrateError
                        ? h('p', { className: 'dsas-err' }, `但复制失败：${rootResult.migrateError}`)
                        : null,
                      rootResult.hot
                        ? h('p', { className: 'dsas-hint' }, '已经生效，不用重启。')
                        : h('p', { className: 'dsas-err' }, `重挂失败，可能要重启：${rootResult.hotError || ''}`),
                    )
                  : h('p', { className: 'dsas-hint' }, rootResult.note || '目录没变。'),
                h(
                  'div',
                  { className: 'dsas-modal-actions' },
                  h('button', { type: 'button', className: 'dsas-btn', onClick: () => setRootResult(null) }, '知道了'),
                ),
              ),
            )
          : null,

        /* 跑完的结果 */
        dailyResult
          ? h(
              'div',
              { className: 'dsas-modal-mask', onClick: (e) => { if (e && e.target === e.currentTarget) setDailyResult(null) } },
              h(
                'div',
                { className: 'dsas-modal' },
                h('div', { className: 'dsas-modal-title' }, dailyResult.ok ? '跑完了' : '没跑成'),
                dailyResult.ok
                  ? h(
                      'div',
                      null,
                      h('p', { className: 'dsas-hint' }, `叫醒 ${(dailyResult.woke || []).length} 个会话，跳过 ${(dailyResult.skipped || []).length} 个。`),
                      (dailyResult.woke || []).length > 0
                        ? h('pre', { className: 'dsas-out' }, '叫醒：' + String.fromCharCode(10) + dailyResult.woke.join(String.fromCharCode(10)))
                        : h(
                            'div',
                            null,
                            h('p', { className: 'dsas-hint' }, dailyResult.reason ? `原因：${dailyResult.reason}` : '没有一个会话符合条件。'),
                            /*
                             * 把中间量摆出来 —— 光说"没有符合条件"没法排查。
                             * 一眼能看出是"宿主没给列表"、"都没人格"、还是"今天没活动"。
                             */
                            dailyResult.diag
                              ? h(
                                  'pre',
                                  { className: 'dsas-out' },
                                  [
                                    `宿主给了 ${dailyResult.diag.hostItems} 个会话`,
                                    `  其中挂了人格的：${dailyResult.diag.withAgent}`,
                                    `  其中今天活动过的：${dailyResult.diag.activeToday}`,
                                    `  过完筛子的：${dailyResult.diag.readyAfterFilter}`,
                                    `  被跳过的：${dailyResult.diag.skippedTotal}`,
                                  ].join(String.fromCharCode(10)),
                                )
                              : null,
                          ),

                        /* 有人格的会话，逐个说清下场 —— 这才是排查时真正要看的东西 */
                        dailyResult.diag && (dailyResult.diag.owned || []).length > 0
                          ? h(
                              'div',
                              { className: 'dsas-daily-owned' },
                              h('div', { className: 'dsas-hint' }, '挂了人格的会话：'),
                              ...dailyResult.diag.owned.map((o) =>
                                h(
                                  'div',
                                  { key: 'do-' + o.sessionId, className: 'dsas-daily-owned-row' },
                                  h('span', { className: 'dsas-daily-owned-name' }, o.agent),
                                  h('span', { className: 'dsas-daily-owned-id' }, o.sessionId.slice(0, 20)),
                                  h(
                                    'span',
                                    {
                                      className: 'dsas-daily-owned-res',
                                      'data-ok': o.result.startsWith('ready') ? '1' : '0',
                                    },
                                    o.result === 'ready'
              ? '已叫醒'
              : o.result === 'ready(queued)'
                ? '已发（它当时在跑，排队等这一轮结束）'
                : o.result,
                                  ),
                                ),
                              ),
                            )
                          : null,
                    )
                  : h('p', { className: 'dsas-err' }, dailyResult.error || '未知原因'),
                h(
                  'div',
                  { className: 'dsas-modal-actions' },
                  h('button', { type: 'button', className: 'dsas-btn', onClick: () => setDailyResult(null) }, '知道了'),
                ),
              ),
            )
          : null,

        /* 人格编辑器 */
        editor
          ? h(
              'div',
              { className: 'dsas-modal-mask' },
              h(
                'div',
                { className: 'dsas-modal dsas-modal-wide' },
                h('div', { className: 'dsas-modal-title' }, `编辑 ${editor.agent}/人格.md`),
                h('p', { className: 'dsas-hint' }, '改的是「人」，不是配置项。保存前会自动备份。'),
                h('textarea', {
                  className: 'dsas-textarea',
                  value: editor.text,
                  onChange: (e) => setEditor({ ...editor, text: e.target.value }),
                }),
                h(
                  'div',
                  { className: 'dsas-modal-actions' },
                  h('button', { type: 'button', className: 'dsas-btn2', onClick: () => setEditor(null) }, '取消'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsas-btn',
                      disabled: busy === 'savepersona',
                      onClick: async () => {
                        setBusy('savepersona')
                        const r = await jpost('/agents/file', {
                          agent: editor.agent,
                          text: editor.text,
                          baseMtime: editor.mtime,
                        })
                        setBusy(null)
                        if (!r || r.ok !== true) {
                          alert((r && r.error) || '没写进去')
                          return
                        }
                        setEditor(null)
                        load()
                      },
                    },
                    busy === 'savepersona' ? '保存中…' : '保存',
                  ),
                ),
              ),
            )
          : null,
      )

      /* ── 单个会话的一行 + 展开详情 ── */
      function sessionRow(sid) {
        const isOpen = openSession === sid
        const owner = Object.prototype.hasOwnProperty.call(ownership, sid) ? ownership[sid] : null
        const row = rowOf(sid) || {}
        const perLog = config.log.sessions && config.log.sessions[sid]
        const logOnFor = perLog && typeof perLog.log === 'boolean' ? perLog.log : Boolean(config.log.defaults && config.log.defaults.log)
        const perDaily = config.daily.sessions && config.daily.sessions[sid]
        const dailyOnFor = perDaily && typeof perDaily.enabled === 'boolean' ? perDaily.enabled : dailyOn
        const logLocked = !logOn
        const dailyLocked = !dailyOn

        return h(
          'div',
          { key: 's-' + sid },
          h(
            'div',
            {
              className: 'dsas-srow',
              'data-open': isOpen ? '1' : '0',
              /* 供"从人格详情跳过来"用：滚到这一行 */
              'data-dsas-session': String(sid),
              'data-flash': flashSession === sid ? '1' : '0',
              onClick: () => setOpenSession(isOpen ? null : sid),
            },
            h(
              'span',
              { className: 'dsas-caret', 'data-open': isOpen ? '1' : '0' },
              h(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
                h('path', {
                  d: 'M4.5 3 7.5 6 4.5 9',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
            ),
            h(
              'span',
              { className: 'dsas-srow-main', 'data-fork': row.parentId ? '1' : '0' },
              h(
                'span',
                { className: 'dsas-srow-name' },
                row.parentId ? h('span', { className: 'dsas-fork-mark' }, '↳ ') : null,
                labelOf(sid),
              ),
              h('span', { className: 'dsas-srow-id' }, sid),
            ),
            h(
              'span',
              { className: 'dsas-tag' },
              owner === null ? (defAgent ? `默认 ${defAgent}` : '无人格') : owner || '无人格',
            ),
          ),
          isOpen
            ? h(
                'div',
                { className: 'dsas-detail' },
                h(
                  Row,
                  {
                    label: '日志记录',
                    hint: logLocked ? '总默认日志关着，这里没法单独开' : '',
                  },
                  switchOf(
                    logOnFor,
                    (v) =>
                      patch((c) => {
                        c.log.sessions = c.log.sessions || {}
                        c.log.sessions[sid] = { ...(c.log.sessions[sid] || {}), log: v }
                      }),
                    logLocked,
                  ),
                ),
                h(
                  Row,
                  {
                    label: '日记记录',
                    hint: dailyLocked ? '总默认日记关着，这里没法单独开' : '',
                  },
                  switchOf(
                    dailyOnFor,
                    (v) =>
                      patch((c) => {
                        c.daily.sessions = c.daily.sessions || {}
                        c.daily.sessions[sid] = { ...(c.daily.sessions[sid] || {}), enabled: v }
                      }),
                    dailyLocked,
                  ),
                ),
                h(
                  Row,
                  { label: '几点写日记', hint: '跟默认走，不能单独设' },
                  h('span', { className: 'dsas-static' }, daily.time || '23:30'),
                ),
                h(
                  Row,
                  { label: '会话人格' },
                  h(
                    'select',
                    {
                      className: 'dsas-select',
                      value: owner === null ? '__default__' : owner || '',
                      disabled: busy === 'persona:' + sid,
                      onChange: (e) => {
                        const v = e.target.value
                        pickPersona(sid, v === '__default__' ? null : v)
                      },
                    },
                    h('option', { value: '__default__' }, defAgent ? `跟随默认（${defAgent}）` : '跟随默认（无）'),
                    h('option', { value: '' }, '无人格'),
                    agents.map((a) => h('option', { key: 'ps-' + a, value: a }, a)),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsas-detail-actions' },
                  h(
                    'span',
                    { className: 'dsas-hint' },
                    `首次 ${row.firstSeen || '—'} · 最近 ${row.lastSeen || '—'}`,
                  ),
                ),
              )
            : null,
        )
      }
    }


    /* ------------------------------------------------- 新会话那行的「人格」 */

    /**
     * 新会话那行的人格选择器。
     *
     * 外观照 DSH 自己的**模型选择器**（`ModelSelect`）复刻，而不是另造一个下拉：
     *   收起 = 一行小触发器（16px 图标 + 名字 + 展开箭头，28px 高、无边框、hover 有底色）
     *   展开 = 浮层菜单（固定定位、圆角、阴影、每行 34px、选中的打勾）
     *
     * 为什么不用 `select`：原生下拉框跟旁边 DSH 自己的控件完全不搭 ——
     * 一个圆角药丸，一个系统灰框，并排放着像两个时代的东西。
     *
     * 为什么不用 `styles.insert` / `react-dom`：宿主只给插件 `react` 一个外部依赖，
     * 浮层就用 `position: fixed` + 绝对坐标自己算，不依赖 portal，也不依赖样式表注入。
     */
    function HeroPersona({ sessionId }) {
      const [agents, setAgents] = useState(null)
      const [current, setCurrent] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState(null)
      const [fallback, setFallback] = useState(null)
      const rootRef = typeof useRef === 'function' ? useRef(null) : { current: null }
      const menuRef = typeof useRef === 'function' ? useRef(null) : { current: null }

      useEffect(() => {
        let alive = true
        Promise.all([jget('/agents'), jget('/persona'), jget('/config')]).then(([a, p, c]) => {
          if (!alive) return
          setAgents(a && Array.isArray(a.agents) ? a.agents : [])
          const table = (p && p.ownership) || {}
          // 三态：没记录 = 走默认；'' = 明说不要；名字 = 用这个
          const has = sessionId && Object.prototype.hasOwnProperty.call(table, sessionId)
          setCurrent(has ? table[sessionId] || '' : null)
          setFallback((c && c.config && c.config.inject && c.config.inject.defaultAgent) || null)
          if (a && a.ok === false) setErr(a.error || '读不到人格列表')
        })
        return () => {
          alive = false
        }
      }, [sessionId])

      // 点外面 / 按 Esc 收起
      useEffect(() => {
        if (!open) return undefined
        // 宿主一定给 document；测试环境没有，就跳过绑定（点外面收起这件事在测试里不验）
        if (typeof document === 'undefined') return undefined
        const onDown = (e) => {
          const t = e && e.target
          if (!t || !(t instanceof Object)) {
            setOpen(false)
            return
          }
          // 触发器在 rootRef 里；**菜单已经 portal 到 body 了，不在 rootRef 里** ——
          // 只判 rootRef 会把点菜单当成"点外面"，mousedown 就把菜单卸了，
          // 于是 click 永远等不到（"菜单点了没反应"就是这么来的）。
          const root = rootRef.current
          if (root && root.contains && root.contains(t)) return
          const menuEl = menuRef.current
          if (menuEl && menuEl.contains && menuEl.contains(t)) return
          setOpen(false)
        }
        const onKey = (e) => {
          if (e && e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const pick = async (value) => {
        if (!sessionId) return
        setOpen(false)
        setBusy(true)
        setErr(null)
        // __default__ → null（清除设置，回到默认）；'' → 显式不要；名字 → 用它
        const agentId = value === '__default__' ? null : value
        const r = await jpost('/persona', { sessionId, agentId })
        setBusy(false)
        if (!r || r.ok !== true) {
          setErr((r && r.error) || '没写进去')
          return
        }
        setCurrent(value === '__default__' ? null : value || '')
      }

      // 没有会话 id 就什么都不画 —— 宁可空着，也不要挂个点了没反应的控件
      if (!sessionId) return null

      const list = agents || []
      const loading = agents === null
      // current: null = 跟随默认；'' = 不要；名字 = 用它
      const label = loading
        ? '读取中…'
        : current === null
          ? fallback
            ? `默认 · ${fallback}`
            : '没选人格'
          : current || '不要人格'

      const show = () => {
        const el = rootRef.current
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
        // 跟模型菜单一样：贴着触发器向上弹，左右夹在视口里
        // 拿不到几何（首帧 / 测试环境）就先给一份兜底，别让菜单因为没坐标而不画
        const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024
        const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768
        const anchorLeft = rect ? rect.left : 8
        const anchorTop = rect ? rect.top : vh - 40
        const anchorWidth = rect ? rect.width : 120
        const width = Math.max(240, Math.min(320, anchorWidth + 120))
        const anchorBottom = rect ? rect.bottom : vh - 34
        // 上方空间够就往上弹（跟模型菜单一致）；不够就往下，别顶出屏幕
        const roomAbove = anchorTop
        const roomBelow = vh - anchorBottom
        const place = roomAbove < 260 && roomBelow > roomAbove ? 'below' : 'above'
        setPos({
          left: Math.max(8, Math.min(anchorLeft, vw - width - 8)),
          width,
          ...(place === 'above'
            ? { bottom: Math.max(8, vh - anchorTop + 6) }
            : { top: Math.min(anchorBottom + 6, vh - 60) }),
        })
        setOpen(true)
      }

      /**
       * 选项三态：
       *   key = '__default__' → 清除这条设置，回落到默认人格
       *   key = ''            → 显式不要（这一趟当临时会话）
       *   key = 人格名        → 用这个
       */
      const rows = [
        {
          key: '__default__',
          name: fallback ? `跟随默认（${fallback}）` : '不设（没有默认人格）',
          hint: fallback ? '新会话自动用这个人格' : '去设置页「③ 像不像 Ta」里挑一个默认',
        },
        { key: '', name: '不要人格（临时会话）', hint: '这一趟不记日记、不注入人格' },
      ].concat(list.map((a) => ({ key: a, name: a, hint: '' })))

      // 触发器本身留在原地（它是 hero 那一行的一部分），
      // 菜单挂到 body 上 —— 见下面 createPortal 的注释。
      const trigger = h(
        'button',
        {
          ref: rootRef,
          type: 'button',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': '给这个新会话选人格',
          title: '这个新会话用谁的记忆和口气 —— 人格决定日记写进谁的目录、注入用谁的口吻',
          disabled: busy || loading,
          onClick: () => (open ? setOpen(false) : show()),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            height: 28,
            minWidth: 0,
            maxWidth: 'min(360px, 45cqw)',
            padding: '0 4px 0 8px',
            border: 'none',
            outline: 'none',
            background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' : 'transparent',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            color: busy || loading ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
            fontSize: 13,
            fontWeight: 400,
            lineHeight: '20px',
            fontFamily: 'inherit',
            cursor: busy || loading ? 'default' : 'pointer',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            style: { flex: 'none' },
          },
          h('circle', { cx: 8, cy: 5.2, r: 2.6, stroke: 'currentColor', strokeWidth: 1.3 }),
          h(
            'path',
            { d: 'M2.9 13.4c.5-2.6 2.6-4.1 5.1-4.1s4.6 1.5 5.1 4.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' },
          ),
        ),
        h(
          'span',
          { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          label,
        ),
        h(
          'svg',
          {
            width: 12,
            height: 12,
            viewBox: '0 0 12 12',
            fill: 'none',
            'aria-hidden': 'true',
            style: {
              flex: 'none',
              color: 'var(--dsw-alias-label-tertiary)',
              transition: 'transform .12s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M3 4.5 6 7.5 9 4.5',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )

      const menu =
        open && pos
          ? h(
              'div',
              {
                ref: menuRef,
                role: 'menu',
                // 皮肤（dsh-claude-style 等）按 role + 这套 data 属性接管，
                // 不按 hash 类名（那些是 CSS Module 生成的，版本一变就废）。
                // ⚠️ 别加 data-menu-material：皮肤会在"账号菜单准备中"把这类菜单整块隐藏。
                'data-dsh-claude-hero-menu': 'persona',
                style: {
                  position: 'fixed',
                  left: pos.left,
                  bottom: pos.bottom,
                  width: pos.width,
                  zIndex: 1100,
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 4,
                  border: '0',
                  borderRadius: 'var(--dsw-radius-lg, 12px)',
                  // 下面几条是「没装美化插件时」的默认外观；装了皮肤它会用 !important 覆盖
                  background: 'var(--dsw-alias-bg-overlay, #fff)',
                  boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.18))',
                  maxHeight: 'min(360px, 60vh)',
                  overflowY: 'auto',
                  color: 'var(--dsw-alias-label-primary)',
                  // 字体跟宿主一致：父容器可能被皮肤换过字体，这里显式继承一次，
                  // 免得挂到 body 之后退回浏览器的默认字体
                  fontFamily: 'inherit',
                  fontSize: 13,
                  lineHeight: '20px',
                },
              },
              rows.map((row) =>
                // ⚠️ part 打在**外面这层 div** 上，按钮是它的直接子元素。
                // 皮肤的规则是 `[data-...part~=menu-item] > [role=menuitem]`（子选择器），
                // 打在按钮自己身上永远匹配不到 —— 这正是"内部样式不一样"的原因。
                h(
                  'div',
                  { key: 'wrap-' + (row.key || 'none'), 'data-dsh-claude-part': 'menu-item' },
                  h(
                  'button',
                  {
                    type: 'button',
                    // 皮肤按 [role=menuitem] 上样式；aria-checked 仍然按单选语义给
                    role: 'menuitem',
                    'aria-checked': (current === null ? '__default__' : current) === row.key ? 'true' : 'false',
                    onClick: () => pick(row.key),
                    style: {
                      boxSizing: 'border-box',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 32,
                      padding: '2px 7px',
                      width: 'auto',
                      minWidth: '100%',
                      border: 'none',
                      outline: 'none',
                      borderRadius: 6,
                      background: 'transparent',
                      color: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: '20px',
                      fontFamily: 'inherit',
                    },
                  },
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 2 } },
                    h(
                      'span',
                      {
                        'data-dsh-claude-part': 'menu-item-name',
                        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      },
                      row.name,
                    ),
                    row.hint
                      ? h(
                          'span',
                          {
                            'data-dsh-claude-part': 'menu-item-desc',
                            style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
                          },
                          row.hint,
                        )
                      : null,
                  ),
                  h(
                    'span',
                    { style: { flex: '0 0 14px', display: 'grid', placeItems: 'center' } },
                    (current === null ? '__default__' : current) === row.key
                      ? h(
                          'svg',
                          { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
                          h('path', {
                            d: 'M2.5 7.4 5.6 10.5 11.5 4',
                            stroke: 'currentColor',
                            strokeWidth: 1.6,
                            strokeLinecap: 'round',
                            strokeLinejoin: 'round',
                          }),
                        )
                      : null,
                  ),
                  ),
                ),
              ),
            )
          : null

      return h(
        'div',
        { style: { position: 'relative', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6 } },
        trigger,
        /*
         * 菜单挂到 document.body 上，不留在 hero 容器里。
         *
         * 为什么：美化插件会给 hero 容器加 transform / filter / contain，
         * 这些东西会把 position:fixed 的子孙"关"进那个层叠上下文 ——
         * 结果就是菜单被后面的会话框盖住、层级算不对。
         * 挂到 body 就没有这个祖先，fixed 才是真的相对视口。
         *
         * 拿不到 react-dom（老宿主 / 测试）就退回就地渲染 —— 至少能用。
         */
        menu ? portal(menu) : null,
        err
          ? h('span', { style: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary)' } }, err)
          : null,
      )
    }

    /* ---------------------------------------------------------------- 挂载 */

    const inject = ['slots']
    const TITLE = '记忆'

    function apply(ctx) {
      // 样式表跟着插件生命周期：进 apply 插，卸载时拔
      ctx.effect(() => injectStyles(), 'dsh-agent-soul: styles')

      ctx.effect(
        () =>
          ctx.slots.inject(
            'settings.section',
            () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'dsh-agent-soul', order: 7, label: () => TITLE },
                MemorySection,
              ),
            'dsh-agent-soul: settings section',
          ),
        'dsh-agent-soul: settings section',
      )

      /*
       * 侧边栏「记忆与人格」入口 + 整页主面板。
       *
       * 两个槽位靠同一个 id 配对：
       *   sidebar.panellist 的 id  → 画那颗图标
       *   main 的同名 key         → 点开后在主区渲染整页
       * id 用 'dsh-agent-soul'，跟别的插件不撞。
       */
      const PANEL_ID = 'dsh-agent-soul'

      ctx.effect(
        () =>
          ctx.slots.inject(
            'sidebar.panellist',
            () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '记忆与人格' },
                SoulIcon,
              ),
            'dsh-agent-soul: sidebar entry',
          ),
        'dsh-agent-soul: sidebar entry',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(
            'main',
            () =>
              ctx.slots.register(
                { name: 'main', key: PANEL_ID },
                (panelProps) =>
                  h(SoulPage, {
                    ...(panelProps || {}),
                    layout: ctx.get ? ctx.get('layout') : undefined,
                  }),
              ),
            'dsh-agent-soul: main page',
          ),
        'dsh-agent-soul: main page',
      )

      // 新建会话时那一行：跟工作区 / Agent 预设并排的一个「人格」下拉
      ctx.effect(
        () =>
          ctx.slots.inject(
            'conversation.hero.options',
            () =>
              ctx.slots.register(
                { name: 'conversation.hero.options', id: 'dsh-agent-soul-persona', order: 20, label: () => '人格' },
                HeroPersona,
              ),
            'dsh-agent-soul: hero persona',
          ),
        'dsh-agent-soul: hero persona',
      )
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.MemorySection = MemorySection
    module.exports.groupSessions = groupSessions
    module.exports.SessionGroups = SessionGroups
    module.exports.HeroPersona = HeroPersona
    module.exports.SoulPage = SoulPage
    module.exports.SoulIcon = SoulIcon
    return module.exports
  },
})
