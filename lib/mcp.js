/**
 * deskpet-guard — MCP（Model Context Protocol）暴露层。
 *
 * 目标（用户原始要求）："其它 agent 也能搜到并使用"。
 * host 内的 ctx.tools 只对同一个 DSH 实例可见；跨 agent / 跨工具要靠 MCP。
 *
 * 传输：**stdio + 按行分隔的 JSON-RPC 2.0**（MCP 规范对 stdio 的约定）。
 * 零依赖：只用 node 内置能力；不引 @modelcontextprotocol/sdk，避免离线装不上。
 *
 * 数据面：MCP 进程通常是**另一个进程**（Claude Desktop / 别的 agent 起的），
 * 它拿不到 host 进程内存里的 prepareKill token，所以：
 *   · 优先走 HTTP API（lib/api.js）—— 单一事实源，token 也在 host 里签发/核销；
 *   · 只读工具在 host 不可达时降级为直接读数据目录（status/events）或本地采样；
 *   · 终止类工具在 host 不可达时**明确拒绝**（绝不本地签一个 host 不认的 token）。
 *
 * 鉴权：变更端点需要 x-deskpet-guard-secret = 数据目录里 0600 的 confirm-secret。
 * 本进程以同一用户身份运行，读得到它；跨站网页读不到 —— 这就是那条界。
 *
 * 用法：
 *   node bin/deskpet-guard-mcp.js                 # stdio MCP server
 *   node lib/mcp.js --list                         # 人类可读的工具清单
 *   node lib/mcp.js --call guard_status            # 直接调一次（自检用）
 *   node lib/mcp.js --call guard_events '{"limit":5}'
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import {
  resolveDataDir,
  readStatus,
  readEvents,
  readEndpoint,
} from './events.js'
import { scan as localScan, VERSION } from './index.js'
import { launchPet, detectClient } from './pet.js'

const SERVER_NAME = 'deskpet-guard'
const DEFAULT_PROTOCOL = '2024-11-05'

/** 与 host 工具表一一对应（名字必须一致 —— test/mcp.test.mjs 会锁这条）。 */
export const TOOL_SPECS = [
  {
    name: 'guard_status',
    description:
      'deskpet-guard 的守护状态快照：agent 进程数、外发连接数、打包产物数、探针健康度、最坏告警等级与候选处置目标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    http: { method: 'GET', path: '/status' },
    kind: 'read',
  },
  {
    name: 'guard_events',
    description: '读取最近的可疑外传事件（来自只追加的 guard-events.jsonl）。用于跨 agent 审计与自查。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '条数，默认 20，上限 500' } },
      additionalProperties: false,
    },
    http: { method: 'GET', path: '/events' },
    kind: 'read',
  },
  {
    name: 'guard_scan',
    description: '立刻重新采样一次，返回当前 mood、findings、候选处置目标与探针错误。只读，不写事件流。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    http: { method: 'POST', path: '/scan' },
    kind: 'read',
  },
  {
    name: 'guard_prepare_kill',
    description:
      '为**单个**候选目标生成"终止进程"的待确认计划（不执行）。返回 confirmToken，需人工把 token 交给 guard_confirm_kill。策略：逐个确认，一次一个。',
    inputSchema: {
      type: 'object',
      properties: { targetPid: { type: 'number', description: '目标进程 pid（来自 guard_status 的候选列表）' } },
      additionalProperties: false,
    },
    http: { method: 'POST', path: '/prepare-kill', bodyFrom: 'args' },
    kind: 'mutate',
  },
  {
    name: 'guard_confirm_kill',
    description:
      '执行终止：必须带 guard_prepare_kill 返回的 confirmToken。token 一次性、10 分钟有效。仅供在明确知道后果时调用。',
    inputSchema: {
      type: 'object',
      properties: { confirmToken: { type: 'string', description: 'prepare 返回的 token' } },
      required: ['confirmToken'],
      additionalProperties: false,
    },
    http: { method: 'POST', path: '/confirm-kill', bodyFrom: 'args' },
    kind: 'mutate',
  },
]

export function toolSpec(name) {
  return TOOL_SPECS.find((t) => t.name === name) || null
}

/** 读 0600 确认密钥（不创建；创建是 host 的事）。 */
export function readSecret(dataDir) {
  if (process.env.DESKPET_GUARD_SECRET) return process.env.DESKPET_GUARD_SECRET
  const f = join(dataDir, 'confirm-secret.json')
  if (!existsSync(f)) return null
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    return j && j.secret ? String(j.secret) : null
  } catch {
    return null
  }
}

/** 推断 host 端点：env → endpoint.json → 默认 3080。 */
export function resolveEndpoint(dataDir) {
  if (process.env.DESKPET_GUARD_ENDPOINT) return String(process.env.DESKPET_GUARD_ENDPOINT).replace(/\/+$/, '')
  const rec = readEndpoint(dataDir)
  if (rec && rec.endpoint) return String(rec.endpoint).replace(/\/+$/, '')
  const p = Number(process.env.DSH_PORT || process.env.PORT)
  if (Number.isFinite(p) && p > 0) return 'http://127.0.0.1:' + p
  return 'http://127.0.0.1:3080'
}

/**
 * 造一个"调用后端"：优先 HTTP，失败时对只读工具降级。
 * @returns {(spec:object, args:object) => Promise<{ok:boolean, data?:any, error?:string, via:string}>}
 */
export function createBackend(opts = {}) {
  const dataDir = opts.dataDir || resolveDataDir()
  const endpoint = opts.endpoint || resolveEndpoint(dataDir)
  const secret = opts.secret !== undefined ? opts.secret : readSecret(dataDir)
  const apiBase = opts.apiBase || '/deskpet-guard/api'
  const timeoutMs = Number(opts.timeoutMs) || 8000
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  async function viaHttp(spec, args) {
    const url = endpoint + apiBase + spec.http.path + (spec.name === 'guard_events' ? '?limit=' + clampLimit(args.limit) : '')
    const headers = { 'x-deskpet-guard': '1', accept: 'application/json' }
    if (secret) headers['x-deskpet-guard-secret'] = secret
    const init = { method: spec.http.method, headers }
    if (spec.http.method === 'POST') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(spec.http.bodyFrom === 'args' ? args || {} : {})
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { ...init, signal: ac.signal })
      const json = await res.json()
      if (!res.ok || json.ok === false) {
        return { ok: false, error: json.error || 'HTTP ' + res.status, via: 'http' }
      }
      return { ok: true, data: json, via: 'http' }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), via: 'http' }
    } finally {
      clearTimeout(timer)
    }
  }

  function viaLocal(spec, args) {
    if (spec.kind === 'mutate') {
      return {
        ok: false,
        via: 'local',
        error:
          '守护进程（host）不可达：' + endpoint + apiBase +
          '。终止类操作必须在 host 内签发/核销 token，本地降级不做这件事。',
      }
    }
    if (spec.name === 'guard_status') {
      return { ok: true, via: 'local', data: { ok: true, status: readStatus(dataDir), degraded: 'host 不可达，读的是落盘快照' } }
    }
    if (spec.name === 'guard_events') {
      return { ok: true, via: 'local', data: { ok: true, events: readEvents(dataDir, clampLimit(args.limit)) } }
    }
    if (spec.name === 'guard_scan') {
      const r = localScan({})
      return {
        ok: true,
        via: 'local',
        data: { ok: true, mood: r.mood, findings: r.findings, targets: r.killTargets, degraded: 'host 不可达，本进程内采样' },
      }
    }
    return { ok: false, via: 'local', error: '未知工具: ' + spec.name }
  }

  return async function call(spec, args) {
    const first = await viaHttp(spec, args || {})
    if (first.ok) return first
    const fallback = viaLocal(spec, args || {})
    if (fallback.ok) return { ...fallback, warning: 'HTTP 失败已降级本地: ' + first.error }
    return { ok: false, error: first.error ? first.error + '；本地降级也不可用: ' + fallback.error : fallback.error, via: fallback.via }
  }
}

/**
 * 纯消息处理器（可离线单测，不需要 stdio）。
 * @returns {object|null} 需要回包时返回 JSON-RPC 响应，通知类返回 null
 */
export function createMcpServer({ call, version = VERSION, name = SERVER_NAME, log = () => {} }) {
  function ok(id, result) {
    return { jsonrpc: '2.0', id, result }
  }
  function err(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  async function handleMessage(msg, state = {}) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return err(null, -32600, 'Invalid Request')
    }
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null

    switch (method) {
      case 'initialize': {
        const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL
        return ok(id, {
          protocolVersion: asked,
          capabilities: { tools: {} },
          serverInfo: { name, version },
          instructions:
            'deskpet-guard：跨 agent 的可疑外传预警与两步确认处置。先 guard_status 看状态，' +
            'guard_events 看历史；发现 critical 时用 guard_prepare_kill 拿 token，' +
            '由**人**确认后再 guard_confirm_kill（token 一次性、10 分钟有效）。',
        })
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, {
          tools: TOOL_SPECS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        })
      case 'tools/call': {
        const toolName = params && params.name
        const spec = toolSpec(toolName)
        if (!spec) return err(id, -32602, '未知工具: ' + String(toolName))
        const args = (params && params.arguments) || {}
        const res = await call(spec, args)
        const text = res.ok
          ? JSON.stringify(res.data, null, 2) + (res.warning ? '\n[降级] ' + res.warning : '')
          : '调用失败: ' + res.error
        log((res.ok ? 'ok ' : 'fail ') + toolName + ' via=' + res.via)
        return ok(id, { content: [{ type: 'text', text }], isError: res.ok !== true })
      }
      default:
        if (isNotification) return null
        return err(id, -32601, 'Method not found: ' + String(method))
    }
  }

  return { handleMessage, TOOL_SPECS }
}

/** stdio 主循环：一行一条 JSON-RPC，写回也是一行一条（绝不往 stdout 写日志）。 */
export function serveStdio(opts = {}) {
  if (serving) {
    // 防御：bin 入口 import 本模块时，若"是否直接执行"判定过宽就会起第二个 server
    // 抢同一份 stdin → 每个请求被回两遍（2026-09 实测踩到，见 test/mcp-stdio.test.mjs）
    errStreamOf(opts).write('[deskpet-guard-mcp] serveStdio 已在运行，忽略重复调用\n')
    return null
  }
  serving = true

  const dataDir = opts.dataDir || resolveDataDir()
  const backend = opts.call ? opts.call : createBackend({ dataDir })

  // 桌宠：客户端拉起本 MCP server 时顺带把桌面窗口带出来（幂等，不会开两个）。
  // 这就是"装了插件、启动 agent 就能看到桌宠"的通用实现 ——
  // 因为 ZCode/Claude Desktop 这类客户端的插件 API 没有 UI 插槽，只能靠独立窗口。
  if (opts.pet !== false && process.env.DESKPET_GUARD_NO_PET !== '1' && !opts.stdin) {
    try {
      const r = launchPet({ dataDir, client: opts.client || detectClient(), reason: 'mcp-start', watch: opts.watch || { pid: process.ppid } })
      if (!r.ok) errStreamOf(opts).write('[deskpet-guard-mcp] 桌宠未拉起: ' + r.message + '\n')
    } catch (e) {
      errStreamOf(opts).write('[deskpet-guard-mcp] 桌宠拉起异常: ' + String(e && e.message) + '\n')
    }
  }
  const input = opts.stdin || process.stdin
  const output = opts.stdout || process.stdout
  const errStream = errStreamOf(opts)
  const exitOnClose = opts.exitOnClose !== false
  const server = createMcpServer({
    call: backend,
    log: (msg) => errStream.write('[deskpet-guard-mcp] ' + msg + '\n'),
  })
  const state = {}
  /** 在途请求：close 时必须等它们写完，否则最后一个响应会被 exit 吃掉 */
  const inflight = new Set()

  const write = (obj) => output.write(JSON.stringify(obj) + '\n')

  const rl = createInterface({ input, terminal: false })
  rl.on('line', (line) => {
    const text = String(line || '').trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const batch = Array.isArray(msg) ? msg : [msg]
    const task = Promise.all(batch.map((m) => server.handleMessage(m, state)))
      .then((responses) => {
        const out = responses.filter(Boolean)
        if (!out.length) return
        write(Array.isArray(msg) ? out : out[0])
      })
      .catch((e) => {
        write({ jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32603, message: String(e?.message || e) } })
      })
      .finally(() => inflight.delete(task))
    inflight.add(task)
  })
  rl.on('close', () => {
    Promise.allSettled([...inflight]).then(() => {
      if (exitOnClose) process.exit(0)
    })
  })
  return server
}

/** 仅供测试：serveStdio 是否已在运行。 */
export function _isServing() {
  return serving
}

function errStreamOf(opts) {
  return opts.stderr || process.stderr
}

let serving = false

function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(Math.floor(n), 500)
}

// ── CLI（自检 / 人肉排查）────────────────────────────────────
// ⚠️ 必须**精确**判断"是不是自己被直接执行"：早期用 endsWith('mcp.js')，
// 结果 bin/deskpet-guard-mcp.js import 本模块时被误判成直接执行，
// 于是同一个进程起了两个 stdio server 抢 stdin（每个请求回两遍、tools/call 丢响应）。
const invokedDirectly = isMainModule()

function isMainModule() {
  try {
    if (!process.argv[1]) return false
    const self = fileURLToPath(import.meta.url)
    const argv1 = resolve(process.argv[1])
    return argv1 === self || argv1 + '.js' === self || argv1 === self.replace(/\.js$/, '')
  } catch {
    return false
  }
}

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const dataDir = resolveDataDir()
  if (argv.includes('--list')) {
    console.log(JSON.stringify({ dataDir, endpoint: resolveEndpoint(dataDir), secretFound: Boolean(readSecret(dataDir)), tools: TOOL_SPECS.map((t) => t.name) }, null, 2))
  } else if (argv.includes('--call')) {
    const i = argv.indexOf('--call')
    const toolName = argv[i + 1]
    const spec = toolSpec(toolName)
    if (!spec) {
      console.error('未知工具: ' + String(toolName) + '（可用: ' + TOOL_SPECS.map((t) => t.name).join(', ') + '）')
      process.exit(2)
    }
    let args = {}
    if (argv[i + 2]) {
      try {
        args = JSON.parse(argv[i + 2])
      } catch (e) {
        console.error('参数不是合法 JSON: ' + String(e.message || e))
        process.exit(2)
      }
    }
    const call = createBackend({ dataDir })
    call(spec, args).then((res) => {
      console.log(JSON.stringify(res, null, 2))
      process.exit(res.ok ? 0 : 1)
    })
  } else {
    serveStdio({ dataDir })
  }
}
