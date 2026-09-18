/**
 * deskpet-guard — 本地 HTTP API 的纯函数测试（离线、零 OS 依赖）。
 *
 * 目的：把"面板/MCP 与守护进程之间的桥"钉死在测试里，重点是**鉴权边界**：
 *   ① 只读端点免鉴权但不发 CORS 头；
 *   ② 变更端点必须过同源 + 自定义头 + JSON 三重闸门，或持 secret；
 *   ③ 预检（OPTIONS）一律拒绝 —— 跨站网页无法把请求升级成"已授权"。
 *
 * 运行：node test/api.test.mjs
 */
import assert from 'node:assert/strict'
import { createApi, API_BASE, stripApiPrefix, isSameOrigin } from '../lib/api.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const HOST = '127.0.0.1:3080'
const STATUS = {
  mood: 'panic',
  headline: 'ZCode 正在连接对象存储服务',
  atMs: 1_800_000_000_000,
  cycles: 7,
  killTargets: [{ pid: 4242, process: 'ZCode.exe', reason: 'R1', remote: 'oss-cn-beijing.aliyuncs.com:443' }],
}

const calls = { scan: 0, prepared: [], confirmed: [] }
const api = createApi({
  dataDir: 'D:/fake-data',
  version: '9.9.9',
  mode: 'execute',
  secret: () => 'S3CRET',
  secretEquals: (a, b) => a === b,
  readStatus: () => STATUS,
  readEvents: (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, title: 'e' + i })),
  scan: () => {
    calls.scan += 1
    return { mood: { mood: 'watching', headline: 'ok' }, findings: [], killTargets: [], probe: { probeErrors: [] } }
  },
  prepareKill: (pid) => {
    calls.prepared.push(pid)
    return {
      requiresConfirmation: true,
      policy: 'one-target-per-confirmation',
      targets: [{ pid: 4242, process: 'ZCode.exe' }],
      targetCount: 1,
      warning: 'w',
      confirmToken: 'tok-1',
      confirmTarget: { pid: pid ?? 4242, process: 'ZCode.exe' },
    }
  },
  confirmKill: (tok) => {
    calls.confirmed.push(tok)
    return tok === 'tok-1' ? { ok: true, killed: [4242] } : { ok: false, error: 'confirmToken 不匹配或已被使用' }
  },
  log: () => {},
})

const dispatch = (o) => api.dispatch({ headers: { host: HOST }, ...o })
const browserHeaders = {
  host: HOST,
  origin: 'http://' + HOST,
  'x-deskpet-guard': '1',
  'content-type': 'application/json',
}

test('stripApiPrefix: 主前缀 / 别名前缀 / 非本插件路径', () => {
  assert.equal(stripApiPrefix('/deskpet-guard/api/status'), '/status')
  assert.equal(stripApiPrefix('/deskpet-guard/api'), '/')
  assert.equal(stripApiPrefix('/@dsh-external/deskpet-guard/api/events'), '/events')
  // 查询串必须被剥掉，否则 /events?limit=N 会落到 405（回归用例）
  assert.equal(stripApiPrefix('/deskpet-guard/api/events?limit=3'), '/events')
  assert.equal(stripApiPrefix('/deskpet-guard/api?x=1'), '/')
  assert.equal(stripApiPrefix('/other/api/status'), null)
  assert.equal(stripApiPrefix('/deskpet-guard/apix'), null)
})

test('isSameOrigin: 同源通过，跨源/畸形拒绝', () => {
  assert.equal(isSameOrigin('http://' + HOST, HOST), true)
  assert.equal(isSameOrigin('http://127.0.0.1:9999', HOST), false)
  assert.equal(isSameOrigin('http://evil.example', HOST), false)
  assert.equal(isSameOrigin('', HOST), false)
  assert.equal(isSameOrigin('not a url', HOST), false)
})

test('GET /status：200 + 快照 + 候选目标 + mode', () => {
  const r = dispatch({ method: 'GET', path: API_BASE + '/status' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.version, '9.9.9')
  assert.equal(r.body.mode, 'execute')
  assert.equal(r.body.apiBase, API_BASE)
  assert.equal(r.body.dataDir, 'D:/fake-data')
  assert.equal(r.body.targets.length, 1)
  assert.equal(r.body.targets[0].pid, 4242)
  assert.equal(r.headers['cache-control'], 'no-store')
  // 只读端点绝不发 CORS 头
  assert.equal(r.headers['access-control-allow-origin'], undefined)
})

test('GET 别名前缀（带 scope）同样可用', () => {
  const r = dispatch({ method: 'GET', path: '/@dsh-external/deskpet-guard/api/status' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
})

test('GET /events：limit 生效且被夹到 1..500', () => {
  assert.equal(dispatch({ method: 'GET', path: API_BASE + '/events?limit=3' }).body.events.length, 3)
  assert.equal(dispatch({ method: 'GET', path: API_BASE + '/events?limit=99999' }).body.limit, 500)
  assert.equal(dispatch({ method: 'GET', path: API_BASE + '/events?limit=abc' }).body.limit, 20)
  assert.equal(dispatch({ method: 'GET', path: API_BASE + '/events' }).body.limit, 20)
})

test('OPTIONS 预检一律 403（从不发 CORS 头 → 跨站无法升级）', () => {
  const r = dispatch({ method: 'OPTIONS', path: API_BASE + '/confirm-kill', headers: browserHeaders })
  assert.equal(r.status, 403)
  assert.equal(r.headers['access-control-allow-origin'], undefined)
})

test('POST /prepare-kill 无自定义头 → 403，且不产生任何计划', () => {
  const before = calls.prepared.length
  const r = dispatch({ method: 'POST', path: API_BASE + '/prepare-kill', body: '{}' })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /自定义头/)
  assert.equal(calls.prepared.length, before)
})

test('POST /prepare-kill 跨源 Origin → 403', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/prepare-kill',
    headers: { host: HOST, origin: 'http://evil.example', 'x-deskpet-guard': '1', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /跨源/)
})

test('POST /prepare-kill 同源但 content-type 非 JSON → 403', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/prepare-kill',
    headers: { host: HOST, origin: 'http://' + HOST, 'x-deskpet-guard': '1', 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /content-type/)
})

test('POST /prepare-kill 同源 + 自定义头 + JSON → 200 且签发 token', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/prepare-kill',
    headers: browserHeaders,
    body: JSON.stringify({ targetPid: 4242 }),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.confirmToken, 'tok-1')
  assert.equal(calls.prepared.at(-1), 4242)
})

test('POST /prepare-kill 持正确 secret（无 Origin）→ 200（MCP 桥路径）', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/prepare-kill',
    headers: { host: HOST, 'x-deskpet-guard-secret': 'S3CRET' },
    body: '{}',
  })
  assert.equal(r.status, 200)
})

test('POST /prepare-kill secret 错误 → 403', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/prepare-kill',
    headers: { host: HOST, 'x-deskpet-guard-secret': 'WRONG' },
    body: '{}',
  })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /secret/)
})

test('POST /confirm-kill 缺 token → 400', () => {
  const r = dispatch({ method: 'POST', path: API_BASE + '/confirm-kill', headers: browserHeaders, body: '{}' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /confirmToken/)
})

test('POST /confirm-kill 错误 token → 409（不执行）', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/confirm-kill',
    headers: browserHeaders,
    body: JSON.stringify({ confirmToken: 'nope' }),
  })
  assert.equal(r.status, 409)
  assert.equal(r.body.ok, false)
})

test('POST /confirm-kill 正确 token → 200 且回传被终止的 pid', () => {
  const r = dispatch({
    method: 'POST',
    path: API_BASE + '/confirm-kill',
    headers: { host: HOST, 'x-deskpet-guard-secret': 'S3CRET' },
    body: JSON.stringify({ confirmToken: 'tok-1' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.killed, [4242])
})

test('POST body 非 JSON 对象 → 400（不是字符串/数组也能糊过去）', () => {
  const bad = dispatch({ method: 'POST', path: API_BASE + '/confirm-kill', headers: browserHeaders, body: '"str"' })
  assert.equal(bad.status, 400)
  const arr = dispatch({ method: 'POST', path: API_BASE + '/confirm-kill', headers: browserHeaders, body: '[1,2]' })
  assert.equal(arr.status, 400)
})

test('POST /scan 免鉴权（只读重扫）且计数增长', () => {
  const before = calls.scan
  const r = dispatch({ method: 'POST', path: API_BASE + '/scan', body: '{}' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(calls.scan, before + 1)
})

test('未知路径 → 405 + allowed 清单；非本插件路径 → 404', () => {
  const r = dispatch({ method: 'GET', path: API_BASE + '/nope' })
  assert.equal(r.status, 405)
  assert.ok(Array.isArray(r.body.allowed))
  assert.equal(dispatch({ method: 'GET', path: '/totally/other' }).status, 404)
})

for (const [n, f] of cases) {
  try {
    f()
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
