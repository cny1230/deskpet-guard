/**
 * deskpet-guard — DSH 插件装配测试（假 ctx，离线、零 OS 依赖）。
 *
 * 目的：证明 apply() 在真实宿主里会**真的把东西挂上去**，而不是静默降级：
 *   · 5 个 host 工具都注册成功，且走 ctx.effect（卸载时能被 fiber 回收，不留僵尸工具）；
 *   · 工具对象形状符合 defineTool 的 registry-ready 约定（parameters 是 JSON Schema、
 *     output.render 返回 content 数组）—— 这是"零依赖也能被 registry 吃下"的关键；
 *   · HTTP API 挂到了 webServer 的主前缀 + 别名前缀，并且 handler 真能回包；
 *   · endpoint.json 落盘（面板/MCP 靠它发现端口）；
 *   · 两步确认链路在 API 上真的连通，且 audit 模式必然拒绝执行。
 *
 * 关键：测试注入 config.scan（假采样）——否则真实探针会去调 PowerShell，
 * 在这个沙箱里每次都要等超时。config.scan / config.killMode 都是生产接缝，
 * 不是测试专用后门（audit 模式 = "只要预警、绝不动手"的部署形态）。
 *
 * 运行：node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, VERSION } from '../lib/index.js'
import { API_BASE, API_ALIASES } from '../lib/api.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-plugin-'))
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

const T = 1_800_000_000_000
const CRITICAL_PID = 4242

function stubScan() {
  return {
    atMs: T,
    probe: {
      atMs: T,
      platform: 'win32',
      probeErrors: [],
      processes: [{ pid: CRITICAL_PID, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [{ pid: CRITICAL_PID, processName: 'ZCode.exe', remoteAddress: 'oss-cn-beijing.aliyuncs.com', remotePort: 443 }],
      dns: [],
      bundles: [],
      secrets: [],
    },
    findings: [
      {
        ruleId: 'R1-agent-to-object-storage',
        severity: 'critical',
        profileId: 'zcode',
        title: 'ZCode 正在连接对象存储服务',
        evidence: { pid: CRITICAL_PID, process: 'ZCode.exe', remote: 'oss-cn-beijing.aliyuncs.com:443' },
        suggest: 'kill',
      },
    ],
    mood: { mood: 'panic', headline: '检测到对象存储直传', worstSeverity: 'critical' },
    killTargets: [
      { pid: CRITICAL_PID, process: 'ZCode.exe', reason: 'ZCode 正在连接对象存储服务', remote: 'oss-cn-beijing.aliyuncs.com:443' },
    ],
  }
}

function fakeCtx() {
  const tools = {
    registered: [],
    register(tool) {
      if (this.registered.some((t) => t.name === tool.name)) throw new Error('duplicate tool: ' + tool.name)
      this.registered.push(tool)
    },
  }
  const routes = []
  const effects = []
  const intervals = []
  const webServer = {
    port: 4567,
    register(route) {
      routes.push(route)
    },
  }
  const services = { tools, webServer }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools,
    webServer,
    get: (k) => services[k],
    effect: (fn, label) => {
      effects.push(label)
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return 1
    },
  }
  return { ctx, tools, routes, effects, intervals, webServer }
}

/** 把捕获到的 webServer handler 当成 node http handler 驱动。 */
function invoke(handler, { method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(body))
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      writeHead(status, h) {
        this.statusCode = status
        this.headers = h
      },
      end(payload) {
        try {
          resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(String(payload)) })
        } catch (e) {
          reject(e)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const HOST = '127.0.0.1:3080'
const browserHeaders = { host: HOST, origin: 'http://' + HOST, 'x-deskpet-guard': '1', 'content-type': 'application/json' }

const { ctx, tools, routes, effects, intervals } = fakeCtx()
let applyError = null
try {
  apply(ctx, { dataDir: DATA, intervalMs: 60000, profiles: [], scan: stubScan, killMode: 'audit' })
} catch (e) {
  applyError = e
}

test('apply() 不抛错（宿主服务齐全时）', () => {
  assert.equal(applyError, null, applyError && String(applyError.message))
})

test('注册了 5 个 host 工具，名字与 MCP 清单一致', () => {
  const names = tools.registered.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'guard_confirm_kill',
    'guard_events',
    'guard_prepare_kill',
    'guard_scan',
    'guard_status',
  ])
})

test('工具注册走 ctx.effect（卸载时随 fiber 回收，不留僵尸工具）', () => {
  for (const name of tools.registered.map((t) => t.name)) {
    assert.ok(effects.includes('deskpet-guard: ' + name), 'missing effect label for ' + name)
  }
})

test('工具形状符合 defineTool 约定（JSON Schema 参数 + render 返回 content 数组）', () => {
  for (const t of tools.registered) {
    assert.equal(typeof t.description, 'string')
    assert.ok(t.description.length > 10, t.name + ' 的 description 太短')
    assert.equal(t.parameters.type, 'object')
    assert.equal(typeof t.parameters.properties, 'object')
    assert.equal(typeof t.execute, 'function')
    assert.equal(typeof t.output.render, 'function')
    const rendered = t.output.render({}, { hello: 1 })
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  }
})

test('guard_confirm_kill 的 confirmToken 声明为必填（防模型漏参）', () => {
  const t = tools.registered.find((x) => x.name === 'guard_confirm_kill')
  assert.deepEqual(t.parameters.required, ['confirmToken'])
  assert.equal(t.parameters.properties.confirmToken.type, 'string')
})

test('采样周期被真正挂上（setInterval 收到 60000）', () => {
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 60000)
})

test('HTTP API 挂到 webServer：主前缀 + 别名前缀，都是 prefix 路由', async () => {
  assert.equal(routes.length, 1 + API_ALIASES.length)
  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, [API_BASE, ...API_ALIASES].sort())
  for (const r of routes) {
    assert.equal(r.kind, 'prefix')
    assert.equal(typeof r.handler, 'function')
  }
})

test('endpoint.json 落盘（面板/MCP 靠它发现端口）', () => {
  const f = join(DATA, 'endpoint.json')
  assert.ok(existsSync(f), 'endpoint.json 未写入')
  const j = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(j.endpoint, 'http://127.0.0.1:4567')
  assert.equal(j.apiBase, API_BASE)
})

test('guard-status.json 落盘：含 mood / 候选目标 / 探针错误', () => {
  const f = join(DATA, 'guard-status.json')
  assert.ok(existsSync(f))
  const j = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(j.mood, 'panic')
  assert.equal(j.killTargets.length, 1)
  assert.equal(j.killTargets[0].pid, CRITICAL_PID)
  assert.deepEqual(j.probeErrors, [])
})

test('host 工具 guard_status 能读到刚落盘的状态', async () => {
  const t = tools.registered.find((x) => x.name === 'guard_status')
  const out = await t.execute({})
  assert.equal(out.mood, 'panic')
  assert.equal(out.killTargets[0].pid, CRITICAL_PID)
})

test('host 工具 guard_events：info 级不落库时返回空数组而不是报错', async () => {
  const t = tools.registered.find((x) => x.name === 'guard_events')
  const out = await t.execute({ limit: 5 })
  assert.ok(Array.isArray(out))
  assert.ok(out.length >= 1, 'critical 事件应当已落库')
  assert.equal(out[0].ruleId, 'R1-agent-to-object-storage')
})

test('host 工具 guard_scan：立刻重扫返回 mood/findings/targets', async () => {
  const t = tools.registered.find((x) => x.name === 'guard_scan')
  const out = await t.execute({})
  assert.equal(out.mood.mood, 'panic')
  assert.equal(out.findings.length, 1)
  assert.equal(out.targets[0].pid, CRITICAL_PID)
})

test('工具 execute 是异步的（与 defineTool 约定一致，宿主按 Promise 消费）', () => {
  for (const t of tools.registered) {
    const r = t.execute({})
    assert.ok(r instanceof Promise, t.name + ' 的 execute 应返回 Promise')
    r.catch(() => {})
  }
})

test('HTTP GET /status：只读、免鉴权、带候选目标与 mode=audit', async () => {
  const handler = routes[0].handler
  const r = await invoke(handler, { method: 'GET', url: API_BASE + '/status', headers: { host: HOST } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.mode, 'audit')
  assert.equal(r.body.dataDir, DATA)
  assert.equal(r.body.targets[0].pid, CRITICAL_PID)
})

test('HTTP POST /confirm-kill 无鉴权 → 403（桥的闸门在真实装配下也生效）', async () => {
  const handler = routes[0].handler
  const r = await invoke(handler, {
    method: 'POST',
    url: API_BASE + '/confirm-kill',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: '{"confirmToken":"x"}',
  })
  assert.equal(r.status, 403)
})

test('HTTP 两步确认全链路连通，audit 模式下第二步必然拒绝执行', async () => {
  const handler = routes[0].handler
  const prepared = await invoke(handler, {
    method: 'POST',
    url: API_BASE + '/prepare-kill',
    headers: browserHeaders,
    body: JSON.stringify({ targetPid: CRITICAL_PID }),
  })
  assert.equal(prepared.status, 200)
  assert.equal(prepared.body.policy, 'one-target-per-confirmation')
  assert.ok(prepared.body.confirmToken, 'api 应签发 token')
  assert.equal(prepared.body.confirmTarget.pid, CRITICAL_PID)

  const confirmed = await invoke(handler, {
    method: 'POST',
    url: API_BASE + '/confirm-kill',
    headers: browserHeaders,
    body: JSON.stringify({ confirmToken: prepared.body.confirmToken }),
  })
  assert.equal(confirmed.status, 409)
  assert.equal(confirmed.body.ok, false)
  assert.match(confirmed.body.error, /audit/)
  assert.deepEqual(confirmed.body.killed, [])

  // token 一次性：重复用同一 token 也不行（此时已作废）
  const again = await invoke(handler, {
    method: 'POST',
    url: API_BASE + '/confirm-kill',
    headers: browserHeaders,
    body: JSON.stringify({ confirmToken: prepared.body.confirmToken }),
  })
  assert.equal(again.status, 409)
})

test('HTTP handler 对超大 body 返回 413 而不是崩掉', async () => {
  const handler = routes[0].handler
  const huge = '{"x":"' + 'a'.repeat(70 * 1024) + '"}'
  const r = await invoke(handler, {
    method: 'POST',
    url: API_BASE + '/scan',
    headers: browserHeaders,
    body: huge,
  })
  assert.equal(r.status, 413)
  assert.equal(r.body.ok, false)
})

test('VERSION 与 package.json 一致（对外报的版本号不能各说各话）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
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
