/**
 * deskpet-guard — 独立采样守护测试。
 *
 * 覆盖 0.4.0 的核心承诺（问题②的解）：
 *   · leader 循环真的在采样落盘，并托管本地 HTTP API（/status、/dashboard、/assets）；
 *   · 第二份守护对同一数据目录会让位（锁选主），不开第二个端口；
 *   · ensureSampler 幂等：没有守护才拉起，有（身份锁新鲜）就跳过；
 *   · --stop 只杀守护自己的身份锁，绝不碰共享选主锁里的 DSH 宿主。
 *
 * 离线：scan 全注入（不碰 PowerShell）；HTTP 走 127.0.0.1 随机端口；临时目录退出清理。
 * 运行：node test/sampler.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { startSampler, ensureSampler, stopSampler, samplerAlive } from '../lib/sampler.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const fakeScan = () => ({
  // 必须与真 scan() 同构：sampleOnce 读 r.probe.procDetails 做归属
  probe: {
    atMs: Date.now(),
    platform: 'win32',
    probeErrors: [],
    processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
    connections: [],
    dns: [],
    bundles: [],
    secrets: [],
    uploads: [],
  },
  findings: [],
  mood: { mood: 'watching', headline: 'x', worstSeverity: 'info' },
  killTargets: [],
})

const mkData = () => mkdtempSync(join(tmpdir(), 'deskpet-guard-sampler-'))
const waitPort = async (h) => {
  for (let i = 0; i < 100 && !(h.state.port > 0 && h.state.cycles >= 1); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!(h.state.port > 0)) throw new Error('守护没有在限时内开出 HTTP 端口')
}

const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-sampler-'))
process.on('exit', () => {
  try { rmSync(DATA, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('leader 守护：采样落盘 + 托管 /status、/dashboard、/assets', async () => {
  setTimeout(() => { console.log('WATCHDOG: 挂起 25 秒'); for (const h of process._getActiveHandles()) console.log('  handle:', h && h.constructor && h.constructor.name); process.exit(9) }, 25000)
  console.log('C1-0: 用例开始')
  const h = startSampler({ dataDir: DATA, intervalMs: 200, scan: fakeScan })
  try {
    console.log('C1-1: startSampler 返回 leader=' + h.state.leader)
    await waitPort(h)
    console.log('C1-2: waitPort 通过 port=' + h.state.port)
    assert.equal(h.state.leader, true, '应成为选主赢家')
    assert.ok(existsSync(join(DATA, 'guard-status.json')), '状态文件应已落盘')
    const st = JSON.parse(readFileSync(join(DATA, 'guard-status.json'), 'utf8'))
    assert.ok(st.cycles >= 1, '轮次应已累计')
    assert.equal(st.mood, 'watching')

    const base = 'http://127.0.0.1:' + h.state.port
    await new Promise((r) => setTimeout(r, 300)) // listen 回调后留出 accept 就绪时间（Windows 回环偶发瞬态拒绝）
    const fetchRetry = async (u) => { let e; for (let i = 0; i < 3; i++) { try { return await new Promise((resolve, reject) => { const rq = httpRequest(u, (rs) => { const chunks = []; rs.on('data', (c) => chunks.push(c)); rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, text: Buffer.concat(chunks).toString('utf8'), json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) })) }); rq.on('error', reject); rq.setTimeout(2000, () => rq.destroy(new Error('请求超时 2s'))); rq.end() }) } catch (err) { e = err; await new Promise((r2) => setTimeout(r2, 300)) } throw e } }
    const jsBody = (await fetchRetry(base + '/deskpet-guard/api/status')).json()
    assert.equal(jsBody.ok, true, '/status 应回 ok')
    assert.equal(jsBody.status.mood, 'watching', '/status 应带最新状态')
    const dash = (await fetchRetry(base + '/deskpet-guard/dashboard')).text
    assert.ok(dash.includes('监控看板'), 'dashboard 页应包含看板标题')
    assert.ok(dash.includes("'/deskpet-guard/api'"), 'dashboard 页应轮询真实 API')
    // 回归锁：左键展开依赖这条规则——缺失时面板 open 了仍是 display:none（0.4.0 实测踩过）
    assert.ok(dash.includes('.panelopen #panel{display:flex}'), 'dashboard 页必须含 #panel.open 展开规则')
    const png = await fetchRetry(base + '/deskpet-guard/assets/mascot-zcode.png')
    assert.equal(png.status, 200, '形象图应可被守护托管')
    assert.equal(png.headers['content-type'], 'image/png')
    const ep = JSON.parse(readFileSync(join(DATA, 'endpoint.json'), 'utf8'))
    assert.ok(ep.endpoint.includes(String(h.state.port)), 'endpoint.json 应带真实端口')
    assert.equal(ep.pid, process.pid)
  } finally {
    h.stop()
  }
})

test('第二份守护对同一数据目录让位（锁选主），不开第二个端口', async () => {
  const leader = startSampler({ dataDir: DATA, intervalMs: 200, scan: fakeScan })
  try {
    await waitPort(leader)
    const follower = startSampler({ dataDir: DATA, intervalMs: 200, scan: fakeScan })
    // 给 follower 至少一个 tick 的时间确认让位
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(follower.state.leader, false, '后到者应为跟随者')
    assert.equal(follower.state.port, 0, '跟随者不得开第二个 HTTP 端口')
    assert.equal(leader.state.leader, true, '先到者应保持 leader')
    follower.stop()
  } finally {
    leader.stop()
  }
})

test('ensureSampler：无守护才拉起；身份锁新鲜则跳过（幂等）', () => {
  // 总闸（all.mjs）会拦住 ensureSampler —— 本用例专测拉起逻辑，临时摘闸（spy 注入，不会真拉起）
  const savedGate = process.env.DESKPET_GUARD_NO_SAMPLER
  delete process.env.DESKPET_GUARD_NO_SAMPLER
  const DATA2 = mkData()
  try {
    const calls = []
    const spy = (cmd, args, o) => { calls.push({ cmd, args, o }); return { pid: 4321, unref() {} } }
    const r1 = ensureSampler({ dataDir: DATA2, spawnImpl: spy })
    assert.equal(r1.ok, true)
    assert.equal(r1.skipped, undefined, '首次应真的拉起')
    assert.equal(calls.length, 1)
    assert.ok(calls[0].args[0].includes('deskpet-guard-sampler.js'), '应拉起守护入口')
    assert.ok(calls[0].o.detached, '必须是 detached（与调用方生命周期解耦）')
    // 写一份新鲜的守护身份锁 → 第二次调用应跳过
    writeFileSync(join(DATA2, 'sampler-daemon.lock'), JSON.stringify({ pid: process.pid, atMs: Date.now() }))
    const r2 = ensureSampler({ dataDir: DATA2, spawnImpl: spy })
    assert.equal(r2.skipped, true, '已有活着的守护应跳过')
    assert.equal(calls.length, 1, '不得重复拉起')
    assert.equal(samplerAlive(DATA2), true)
  } finally {
    if (savedGate === undefined) delete process.env.DESKPET_GUARD_NO_SAMPLER
    else process.env.DESKPET_GUARD_NO_SAMPLER = savedGate
    rmSync(DATA2, { recursive: true, force: true })
  }
})

test('stopSampler：只按守护身份锁杀进程（不碰共享选主锁里的别人）', async () => {
  const DATA3 = mkData()
  // 起一个真的守护子进程（本地 sleeper，不用任何系统探针）
  const dummy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { detached: false })
  try {
    writeFileSync(join(DATA3, 'sampler-daemon.lock'), JSON.stringify({ pid: dummy.pid, atMs: Date.now() }))
    // 共享选主锁里故意放一个"无辜 pid"（本测试进程）——绝不能被误杀
    writeFileSync(join(DATA3, 'guard-sampler.lock'), JSON.stringify({ pid: process.pid, inst: 'x', atMs: Date.now() }))
    const r = stopSampler(DATA3)
    assert.equal(r.ok, true)
    assert.equal(r.pid, dummy.pid)
    await new Promise((r2) => setTimeout(r2, 250))
    assert.ok(dummy.killed || dummy.exitCode !== null, '守护子进程应被停止')
    assert.equal(process.pid !== dummy.pid, true)
  } finally {
    try { dummy.kill() } catch { /* ignore */ }
    rmSync(DATA3, { recursive: true, force: true })
  }
})

test('stop() 之后不再采样（可干净退出）', async () => {
  const h = startSampler({ dataDir: mkData(), intervalMs: 200, scan: fakeScan, serve: false })
  const cycles = h.state.cycles
  h.stop()
  assert.equal(h.state.stopped, true)
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(h.state.cycles, cycles, 'stop 后轮次不得再涨')
})

// ── 执行 ──
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
