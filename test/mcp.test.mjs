/**
 * deskpet-guard — MCP 暴露层测试（离线、零网络）。
 *
 * 目的：证明"别的 agent 能用"这条不是口号：
 *   · MCP 工具清单与 host 端注册的工具名**一一对应**（名字漂了就等于两套 API）；
 *   · 每个 MCP 工具映射到的 HTTP 路径，都在 lib/api.js 里真有分支；
 *   · JSON-RPC 往返正确（initialize / tools/list / tools/call / ping / 通知不回包 / 错误码）；
 *   · host 不可达时：只读工具降级本地（读落盘快照），终止类工具**明确拒绝**，
 *     绝不本地签一个 host 不认的 token。
 *
 * 运行：node test/mcp.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMcpServer, createBackend, TOOL_SPECS, readSecret, resolveEndpoint } from '../lib/mcp.js'
import { VERSION } from '../lib/index.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const ROOT = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-mcp-'))
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

// 造一份落盘快照 + 事件流（模拟 host 跑过一轮）
writeFileSync(
  join(DATA, 'guard-status.json'),
  JSON.stringify({ mood: 'alert', headline: '探针降级', atMs: 123, killTargets: [] }),
)
writeFileSync(
  join(DATA, 'guard-events.jsonl'),
  JSON.stringify({ ruleId: 'R2-fresh-bundle-artifact', severity: 'high', title: '新鲜打包产物', atMs: 100 }) + '\n',
)

let lastCall = null
const server = createMcpServer({
  call: async (spec, args) => {
    lastCall = { name: spec.name, args }
    if (spec.name === 'guard_scan') return { ok: false, error: 'host 不可达（stub）', via: 'http' }
    return { ok: true, via: 'stub', data: { ok: true, echo: spec.name, args } }
  },
  log: () => {},
})

// ───────────────────────── 协议往返 ─────────────────────────
test('initialize：回显客户端协议版本并给出 serverInfo', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(r.jsonrpc, '2.0')
  assert.equal(r.id, 1)
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.equal(r.result.serverInfo.name, 'deskpet-guard')
  assert.equal(r.result.serverInfo.version, VERSION)
  assert.ok(r.result.capabilities.tools)
})

test('initialize：客户端不给版本时用规范默认值', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
  assert.equal(r.result.protocolVersion, '2024-11-05')
})

test('notifications/initialized 是通知：不回包', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(r, null)
})

test('ping → 空结果', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.deepEqual(r.result, {})
})

test('tools/list：5 个工具，都带 name/description/inputSchema', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
  assert.equal(r.result.tools.length, 5)
  for (const t of r.result.tools) {
    assert.equal(typeof t.name, 'string')
    assert.ok(t.description.length > 10, t.name + ' 缺像样的 description')
    assert.equal(t.inputSchema.type, 'object')
  }
})

test('tools/call 成功：content + isError=false', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'guard_events', arguments: { limit: 5 } } })
  assert.equal(r.result.isError, false)
  assert.equal(r.result.content[0].type, 'text')
  assert.match(r.result.content[0].text, /guard_events/)
  assert.deepEqual(lastCall, { name: 'guard_events', args: { limit: 5 } })
})

test('tools/call 失败：isError=true 且把原因写进文本', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'guard_scan', arguments: {} } })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /host 不可达/)
})

test('tools/call 未知工具 → -32602', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'guard_nope' } })
  assert.equal(r.error.code, -32602)
})

test('未知 method → -32601；非对象消息 → -32600', async () => {
  const m = await server.handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/list' })
  assert.equal(m.error.code, -32601)
  assert.equal((await server.handleMessage('nope')).error.code, -32600)
  assert.equal((await server.handleMessage(null)).error.code, -32600)
})

// ───────────────────────── 跨文件一致性（真正的"桥"防漂移）─────────────────────────
test('MCP 工具名与 host 端 ctx.tools.register 的名字一一对应', () => {
  const hostSrc = read('lib/index.js')
  const hostNames = new Set([...hostSrc.matchAll(/name: '(guard_[a-z_]+)'/g)].map((m) => m[1]))
  for (const spec of TOOL_SPECS) {
    assert.ok(hostNames.has(spec.name), 'host 没有注册 ' + spec.name)
  }
  assert.equal(hostNames.size, TOOL_SPECS.length, 'host 工具数与 MCP 清单不一致: ' + [...hostNames].join(','))
})

test('每个 MCP 工具映射的 HTTP 路径，在 lib/api.js 里真有分支', () => {
  const apiSrc = read('lib/api.js')
  for (const spec of TOOL_SPECS) {
    assert.ok(apiSrc.includes("'" + spec.http.path + "'"), 'api.js 里没有 ' + spec.http.path + ' 分支（' + spec.name + '）')
  }
})

test('MCP 侧 API 基址与 host 侧 API_BASE 一致', () => {
  const apiSrc = read('lib/api.js')
  const m = apiSrc.match(/export const API_BASE = '([^']+)'/)
  assert.ok(m, 'api.js 里找不到 API_BASE')
  assert.ok(read('lib/mcp.js').includes("'" + m[1] + "'"), 'mcp.js 未使用 ' + m[1])
})

// ───────────────────────── 后端降级语义 ─────────────────────────
test('createBackend：HTTP 正常时走 http', async () => {
  const call = createBackend({
    dataDir: DATA,
    endpoint: 'http://127.0.0.1:9',
    secret: null,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: { mood: 'watching' }, got: url }),
    }),
  })
  const spec = TOOL_SPECS.find((t) => t.name === 'guard_status')
  const res = await call(spec, {})
  assert.equal(res.ok, true)
  assert.equal(res.via, 'http')
  assert.equal(res.data.status.mood, 'watching')
})

test('createBackend：guard_events 的 limit 拼进查询串', async () => {
  let seenUrl = ''
  const call = createBackend({
    dataDir: DATA,
    endpoint: 'http://127.0.0.1:9',
    secret: null,
    fetchImpl: async (url) => {
      seenUrl = url
      return { ok: true, status: 200, json: async () => ({ ok: true, events: [] }) }
    },
  })
  await call(TOOL_SPECS.find((t) => t.name === 'guard_events'), { limit: 7 })
  assert.match(seenUrl, /\/events\?limit=7$/)
})

test('createBackend：host 不可达时只读工具降级读落盘快照', async () => {
  const call = createBackend({
    dataDir: DATA,
    endpoint: 'http://127.0.0.1:9',
    secret: null,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const status = await call(TOOL_SPECS.find((t) => t.name === 'guard_status'), {})
  assert.equal(status.ok, true)
  assert.equal(status.via, 'local')
  assert.equal(status.data.status.mood, 'alert')
  assert.match(status.warning || '', /降级/)

  const events = await call(TOOL_SPECS.find((t) => t.name === 'guard_events'), { limit: 3 })
  assert.equal(events.ok, true)
  assert.equal(events.data.events.length, 1)
  assert.equal(events.data.events[0].ruleId, 'R2-fresh-bundle-artifact')
})

test('createBackend：host 不可达时终止类工具必须拒绝（不本地签 token）', async () => {
  const call = createBackend({
    dataDir: DATA,
    endpoint: 'http://127.0.0.1:9',
    secret: null,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  for (const name of ['guard_prepare_kill', 'guard_confirm_kill']) {
    const res = await call(TOOL_SPECS.find((t) => t.name === name), { confirmToken: 'x' })
    assert.equal(res.ok, false, name + ' 不该在 host 不可达时"成功"')
    assert.match(res.error, /host|守护进程/)
  }
})

test('createBackend：变更请求带上 secret 头（跨站网页读不到那个文件）', async () => {
  let headers = null
  const call = createBackend({
    dataDir: DATA,
    endpoint: 'http://127.0.0.1:9',
    secret: 'FROM-FILE',
    fetchImpl: async (url, init) => {
      headers = init.headers
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  await call(TOOL_SPECS.find((t) => t.name === 'guard_confirm_kill'), { confirmToken: 't' })
  assert.equal(headers['x-deskpet-guard-secret'], 'FROM-FILE')
  assert.equal(headers['x-deskpet-guard'], '1')
  assert.equal(headers['content-type'], 'application/json')
})

test('readSecret：无文件返回 null；有文件读得出值；env 优先', () => {
  assert.equal(readSecret(DATA), null)
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, 'confirm-secret.json'), JSON.stringify({ secret: 's3c' }))
  assert.equal(readSecret(DATA), 's3c')
  process.env.DESKPET_GUARD_SECRET = 'from-env'
  assert.equal(readSecret(DATA), 'from-env')
  delete process.env.DESKPET_GUARD_SECRET
})

test('resolveEndpoint：env > endpoint.json > 默认 3080', () => {
  process.env.DESKPET_GUARD_ENDPOINT = 'http://127.0.0.1:7777/'
  assert.equal(resolveEndpoint(DATA), 'http://127.0.0.1:7777')
  delete process.env.DESKPET_GUARD_ENDPOINT

  assert.equal(resolveEndpoint(DATA), 'http://127.0.0.1:3080')
  writeFileSync(join(DATA, 'endpoint.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:4567' }))
  assert.equal(resolveEndpoint(DATA), 'http://127.0.0.1:4567')
})

for (const [n, f] of cases) {
  try {
    await f()
    pass++
    console.log(`  PASS  ${n}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${n}`)
    console.log(`        ${String(e.message).split('\n')[0]}`)
  }
}
console.log(`\n结果: ${pass} passed, ${fail} failed (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
