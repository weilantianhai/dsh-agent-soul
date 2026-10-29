/**
 * http.mjs —— 这个插件的 HTTP 骨架：响应格式、本机校验、信任栅栏、读请求体。
 *
 * 这些原来都长在 routes.mjs 里。抽出来的理由：
 *   每个资源路由都要用它们，而 routes.mjs 已经 1200 多行，
 *   想改一行栅栏逻辑要在一堆业务代码里翻。
 *
 * 安全相关的只有一条铁律：**写操作必须过 fence，栅栏不可用就拒（fail-closed）**。
 * GET/HEAD 在没有栅栏时放行 —— 只读不该因为栅栏没起来而全废。
 */

import { connectionOf } from '../infra/host.mjs'

/** 请求体上限：这些接口都是小的 JSON，不需要收文件 */
export const MAX_BODY = 4 * 1024 * 1024

const msg = (err) => String((err && err.message) || err)

/** 统一的 JSON 响应。不缓存 —— 这些数据一直在变 */
export function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * 只认本机。
 *
 * Host 头必须是我们认识的（`127.0.0.1` / `localhost` / `[::1]`），
 * socket 对端也必须是回环。**Host 缺失直接拒** ——
 * HTTP/1.1 本来就要求带 Host，没有多半是被构造的请求。
 */
export function isLoopback(host, remote) {
  let h = String(host || '').toLowerCase().trim()
  if (h.startsWith('[')) h = h.slice(0, h.indexOf(']') + 1)
  else h = h.split(':')[0]

  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  if (!hosts.has(h)) return false

  const r = String(remote || '')
  if (!r) return true
  return r === '127.0.0.1' || r === '::1' || r === '::ffff:127.0.0.1'
}

/**
 * 信任栅栏：写操作的前置检查。
 *
 * 为什么 fail-closed：栅栏拿不到时**宁可拒绝**。放行等于把"谁都能改"的口子
 * 开在本机端口上 —— 浏览器里的任何页面都能往这里 POST。
 *
 * @returns {(req, res) => boolean}  true = 放行；false = 已经写过响应，别再往下走
 */
export function fence(ctx) {
  return (req, res) => {
    if (!isLoopback(req.headers?.host, req.socket?.remoteAddress)) {
      json(res, 403, { ok: false, error: '只接受本机访问' })
      return false
    }

    const isRead = req.method === 'GET' || req.method === 'HEAD'
    try {
      const conn = connectionOf(ctx)
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (isRead) return true
        json(res, 503, { ok: false, error: '信任栅栏不可用，写操作已拒绝' })
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return true
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return false
    } catch (err) {
      if (isRead) return true
      json(res, 503, { ok: false, error: `信任栅栏异常，写操作已拒绝：${msg(err)}` })
      return false
    }
  }
}

/** 读请求体（JSON）。空体当 `{}` */
export async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}
