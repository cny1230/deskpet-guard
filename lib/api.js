/**
 * deskpet-guard — 本地 HTTP API（纯函数分发，零依赖、可离线单测）。
 *
 * 存在理由：GUI 面板在浏览器里跑，读不到 host 进程内存，也读不到 0600 的
 * 确认密钥文件，所以必须有一条面板 ↔ 守护进程的桥。桥就是本文件。
 *
 * 安全模型（改代码前先读 docs/SECURITY.md）：
 *   · 只读端点（status/events）：无需鉴权。它们只回本机采集到的告警元数据，
 *     不含密钥、不含文件内容，且响应永远不带 CORS 头。
 *   · 变更端点（prepare-kill / confirm-kill）必须同时满足：
 *       ① 带自定义头 x-deskpet-guard: 1     → 强制浏览器发 CORS 预检
 *       ② 带 Origin/Referer 且与本机 Host 同源 → 挡掉跨站表单/图片式触发
 *       ③ content-type: application/json
 *     或者 ②' 带 x-deskpet-guard-secret 且与数据目录里的 0600 secret 相等
 *     （非浏览器调用方：MCP 桥。它读得到那 0600 文件，跨站网页读不到）。
 *   · 任何 OPTIONS（预检）直接 403：我们从不发 Access-Control-Allow-*，
 *     因此浏览器无法把跨站请求升级成"已授权"。
 *   · 不写被监控 agent 的任何目录；只经由注入进来的回调写自己的数据目录。
 */

/** 主前缀（短名，站内相对路径用）。 */
export const API_BASE = '/deskpet-guard/api'
/** 兼容前缀：包名从 `@dsh-external/deskpet-guard` 改为 `deskpet-guard` 期间保留旧路径，
 *  让已经装过旧包的面板/脚本不至于 404。新代码只用 API_BASE。 */
export const API_ALIASES = ['/@dsh-external/deskpet-guard/api']
export const ALL_PREFIXES = [API_BASE, ...API_ALIASES]

const MAX_BODY = 64 * 1024
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** 把 webServer 收到的原始路径裁成 API 内部路径；不属于本插件时返回 null。 */
export function stripApiPrefix(rawPath) {
  const raw = String(rawPath || '')
  // 查询串必须先剥掉，否则 '/events?limit=3' 会匹配不上 '/events' 分支（曾真踩）
  const q = raw.indexOf('?')
  const path = q >= 0 ? raw.slice(0, q) : raw
  for (const prefix of ALL_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      const rest = path.slice(prefix.length)
      return rest === '' ? '/' : rest
    }
  }
  return null
}

function lower(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v)
  }
  return out
}

/** Origin/Referer 是否与本机 Host 同源（只比 host:port，不信任 scheme 声明）。 */
export function isSameOrigin(originish, hostHeader) {
  if (!originish || !hostHeader) return false
  try {
    const u = new URL(String(originish))
    return u.host.toLowerCase() === String(hostHeader).toLowerCase()
  } catch {
    return false
  }
}

/**
 * 组装 API 分发器。
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {string} [deps.version]
 * @param {() => any} [deps.secret]          确认密钥（读 0600 文件；读不到时返回 null）
 * @param {Function} deps.scan               () => { mood, findings, probe }
 * @param {Function} deps.prepareKill        (targetPid) => plan（含 confirmToken）
 * @param {Function} deps.confirmKill        (confirmToken) => { ok, killed?, error? }
 * @param {Function} [deps.readStatus]
 * @param {Function} [deps.readEvents]       (limit) => events[]
 * @param {Function} [deps.secretEquals]     (a,b) => boolean
 */
export function createApi(deps) {
  const {
    dataDir,
    version = '0.0.0',
    mode = 'execute',
    secret,
    scan,
    prepareKill,
    confirmKill,
    readStatus = () => null,
    readEvents = () => [],
    secretEquals = (a, b) => a === b,
    log = () => {},
  } = deps

  function authorise(headers, hostHeader) {
    const h = lower(headers)
    const presented = h['x-deskpet-guard-secret']
    if (presented) {
      let expected = null
      try {
        expected = typeof secret === 'function' ? secret() : secret
      } catch {
        expected = null
      }
      if (expected && secretEquals(presented, expected)) return { ok: true, via: 'secret' }
      return { ok: false, reason: 'secret 不匹配' }
    }
    if (h['x-deskpet-guard'] !== '1') {
      return { ok: false, reason: '缺少自定义头 x-deskpet-guard: 1' }
    }
    const originish = h['origin'] || h['referer']
    if (!originish) {
      return { ok: false, reason: '缺少 Origin/Referer（该端点只接受同源浏览器或持有 secret 的本地调用方）' }
    }
    if (!isSameOrigin(originish, hostHeader)) {
      return { ok: false, reason: '跨源请求被拒绝（Origin=' + originish + '）' }
    }
    if (!String(h['content-type'] || '').includes('application/json')) {
      return { ok: false, reason: 'content-type 必须是 application/json' }
    }
    return { ok: true, via: 'browser' }
  }

  function parseBody(raw) {
    if (raw === undefined || raw === null || raw === '') return {}
    if (typeof raw === 'object') return raw
    const text = String(raw)
    if (text.length > MAX_BODY) throw new Error('body 过大（>' + MAX_BODY + ' bytes）')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body 必须是 JSON 对象')
    }
    return parsed
  }

  /**
   * @param {{method?:string, path:string, headers?:object, body?:any}} req
   * @returns {{status:number, headers:object, body:object}}
   */
  function dispatch(req) {
    const method = String(req.method || 'GET').toUpperCase()
    const path = stripApiPrefix(req.path)
    const headers = req.headers || {}
    const host = lower(headers)['host'] || '127.0.0.1'
    const reply = (status, body) => ({ status, headers: { ...JSON_HEADERS }, body })

    if (path === null) return reply(404, { ok: false, error: 'not a deskpet-guard api path' })
    if (method === 'OPTIONS') {
      // 预检一律拒绝：不发 CORS 头 → 跨站请求无法升级
      return reply(403, { ok: false, error: 'CORS preflight refused' })
    }

    if (method === 'GET' && (path === '/' || path === '/status')) {
      const status = readStatus()
      return reply(200, {
        ok: true,
        version,
        mode,
        apiBase: API_BASE,
        aliases: API_ALIASES,
        dataDir,
        status,
        mood: status?.mood ?? null,
        headline: status?.headline ?? null,
        targets: status?.killTargets || [],
      })
    }

    if (method === 'GET' && path === '/events') {
      const url = safeUrl(req)
      const limit = clampLimit(url?.searchParams.get('limit'))
      return reply(200, { ok: true, limit, events: readEvents(limit) })
    }

    if (method === 'POST' && path === '/scan') {
      const r = scan()
      return reply(200, {
        ok: true,
        mood: r.mood,
        findings: r.findings,
        targets: r.killTargets || [],
        probeErrors: r.probe?.probeErrors || [],
      })
    }

    if (method === 'POST' && path === '/prepare-kill') {
      const auth = authorise(headers, host)
      if (!auth.ok) return reply(403, { ok: false, error: auth.reason })
      let body
      try {
        body = parseBody(req.body)
      } catch (e) {
        return reply(400, { ok: false, error: String(e.message || e) })
      }
      const targetPid = body.targetPid ? Number(body.targetPid) : undefined
      if (body.targetPid !== undefined && !Number.isFinite(targetPid)) {
        return reply(400, { ok: false, error: 'targetPid 必须是数字' })
      }
      const plan = prepareKill(targetPid)
      log('api prepare-kill via=' + auth.via + ' pid=' + (targetPid ?? '(first)'))
      return reply(plan.error ? 409 : 200, { ok: !plan.error, ...plan })
    }

    if (method === 'POST' && path === '/confirm-kill') {
      const auth = authorise(headers, host)
      if (!auth.ok) return reply(403, { ok: false, error: auth.reason })
      let body
      try {
        body = parseBody(req.body)
      } catch (e) {
        return reply(400, { ok: false, error: String(e.message || e) })
      }
      const token = body.confirmToken ? String(body.confirmToken) : ''
      if (!token) return reply(400, { ok: false, error: '缺少 confirmToken' })
      const result = confirmKill(token)
      log('api confirm-kill via=' + auth.via + ' ok=' + (result.ok === true))
      return reply(result.ok ? 200 : 409, result)
    }

    return reply(405, {
      ok: false,
      error: '不支持的请求：' + method + ' ' + path,
      allowed: [
        'GET /status',
        'GET /events?limit=N',
        'POST /scan',
        'POST /prepare-kill',
        'POST /confirm-kill',
      ],
    })
  }

  return { dispatch, authorise, API_BASE, API_ALIASES, stripApiPrefix, MAX_BODY }
}

function safeUrl(req) {
  try {
    return new URL(String(req.path || '/'), 'http://127.0.0.1')
  } catch {
    return null
  }
}

function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(Math.floor(n), 500)
}
