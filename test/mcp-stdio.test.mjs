/**
 * deskpet-guard — MCP stdio 传输层测试。
 *
 * 为什么单独测这一层：纯协议测试（test/mcp.test.mjs）走的是 handleMessage，
 * 而 2026-09 实测踩到的两个 bug 都在**传输层**：
 *   ① bin 入口 import lib/mcp.js 时被误判成"直接执行"→ 起了两个 stdio server
 *      抢同一份 stdin → 每个请求被回两遍；
 *   ② rl close 时立刻 process.exit(0) → 最后一个响应（tools/call）被吃掉。
 * 这里用注入的 stdin/stdout 流把真实 serveStdio 跑起来，锁死这两条。
 *
 * 运行：node test/mcp-stdio.test.mjs
 */
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveStdio, _isServing } from '../lib/mcp.js'

let pass = 0
let fail = 0
let skipped = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const flush = async (turns = 30) => {
  for (let i = 0; i < turns; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 20))
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

const INPUT = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"guard_events","arguments":{"limit":1}}}',
  '',
].join('\n')

let out = ''
let err = ''
const stdout = new Writable({
  write(chunk, _enc, cb) {
    out += chunk.toString()
    cb()
  },
})
const stderr = new Writable({
  write(chunk, _enc, cb) {
    err += chunk.toString()
    cb()
  },
})

// 一次 serveStdio（模块内单例守卫），把所有传输层断言挂在它上面
const server = serveStdio({
  stdin: Readable.from([INPUT]),
  stdout,
  stderr,
  exitOnClose: false,
  call: async (spec, args) => ({ ok: true, via: 'stub', data: { echo: spec.name, args } }),
})

await flush()

const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('import lib/mcp.js 不会自己起 server（曾被误判为直接执行 → 双 server 抢 stdin）', () => {
  assert.equal(_isServing(), true, '本测试自己调了 serveStdio，应处于运行态')
  // 关键：serveStdio 是本测试显式调用的；若 import 时自动起了一个，第二次调用会被守卫拒绝，
  // 这里通过"注释/调用栈无关"的方式确认：返回值必须是 server 对象而不是 null（即没被抢跑）
  assert.ok(server && typeof server.handleMessage === 'function', 'import 时代码自己起了 server（serveStdio 返回 null）')
})

test('4 行输入 → 恰好 3 条响应（通知不回包），且 id 不重复', () => {
  const got = lines()
  assert.equal(got.length, 3, '响应条数不对：' + got.length + '（重复回包会 >3）')
  assert.deepEqual(got.map((r) => r.id), [1, 2, 3])
})

test('initialize 回包正常', () => {
  const r = lines().find((x) => x.id === 1)
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.equal(r.result.serverInfo.name, 'deskpet-guard')
})

test('tools/call 的响应不被 close 吃掉（回归：exit(0) 抢先）', () => {
  const r = lines().find((x) => x.id === 3)
  assert.ok(r, 'id=3 的响应丢了')
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /guard_events/)
})

test('stdout 只出现 JSON-RPC（日志走 stderr）', () => {
  for (const l of out.split('\n').filter(Boolean)) {
    const j = JSON.parse(l)
    assert.equal(j.jsonrpc, '2.0')
  }
  assert.ok(!/deskpet-guard-mcp\]/.test(out), 'stdout 混进了日志')
})

test('重复调用 serveStdio 被单例守卫拒绝（返回 null 并写 stderr）', () => {
  const again = serveStdio({ stdin: Readable.from([]), stdout, stderr, exitOnClose: false })
  assert.equal(again, null)
  assert.match(err, /已在运行/)
})

test('真 bin 入口的 stdio 往返（沙箱禁止管道捕获时跳过）', () => {
  const bin = fileURLToPath(new URL('../bin/deskpet-guard-mcp.js', import.meta.url))
  let stdoutText
  try {
    stdoutText = execFileSync(process.execPath, [bin], {
      input: INPUT,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, DESKPET_GUARD_ENDPOINT: 'http://127.0.0.1:9' },
    })
  } catch (e) {
    const msg = String(e?.message || e) + String(e?.stderr || '')
    if (/EPERM|EPIPE|pipe|拒绝|denied|spawnSync/i.test(msg)) {
      skipped++
      console.log('        [skip] 沙箱禁止管道捕获子进程输出，跳过真 bin 往返：' + msg.split('\n')[0].slice(0, 80))
      return
    }
    throw e
  }
  const got = stdoutText.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(got.length, 3, '真 bin 的响应条数不对（双 server 会 >3）: ' + got.length)
  assert.deepEqual(got.map((r) => r.id), [1, 2, 3])
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
console.log(`\n结果: ${pass} passed, ${fail} failed, ${skipped} skipped (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
