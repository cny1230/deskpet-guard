/**
 * deskpet-guard — 处置链路（终止动作）安全测试。
 *
 * 目的：证明"终止目标 agent 进程"不可能在没有两步确认的情况下发生。
 * 关键点：全部用注入的 exec 假实现，绝不真的杀进程。
 *
 * 运行：node test/kill.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { confirmPlan, prepareKill, killByPids } from '../lib/index.js'

const T = 1_800_000_000_000
const critical = (pid) => ({
  atMs: T,
  probe: { atMs: T, platform: 'win32', probeErrors: [], processes: [], connections: [], dns: [], bundles: [], secrets: [] },
  findings: [
    {
      ruleId: 'R1-agent-to-object-storage',
      severity: 'critical',
      profileId: 'zcode',
      title: 'ZCode 正在连接对象存储服务',
      evidence: { pid, process: 'ZCode.exe', remote: 'oss-cn-beijing.aliyuncs.com:443' },
      suggest: 'kill',
    },
  ],
  mood: { mood: 'panic', headline: 'x', worstSeverity: 'critical' },
})

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

// 测试用数据目录：建在系统临时目录，退出时清理，绝不在仓库/系统位置留残留
const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-test-'))
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

test('confirmPlan: 只对 critical + suggest=kill 生成目标，且不自动执行', () => {
  const plan = confirmPlan(critical(1234))
  assert.equal(plan.requiresConfirmation, true)
  assert.equal(plan.action, 'kill')
  assert.equal(plan.targets.length, 1)
  assert.equal(plan.targets[0].pid, 1234)
  assert.equal(plan.policy, 'one-target-per-confirmation', '处置策略应为逐个确认')
  assert.equal(plan.targetCount, 1)
  assert.equal(plan.confirmToken, null, '仅 confirmPlan 不应签发 token')
})

test('prepareKill: 签发 token，但此时仍不得杀任何东西', () => {
  let called = false
  const plan = prepareKill(DATA, critical(2222))
  assert.ok(plan.confirmToken, '应签发 confirmToken')
  assert.equal(called, false)
  assert.equal(plan.targets[0].pid, 2222)
})

test('killByPids: 错误 token 必须被拒绝且不执行', () => {
  prepareKill(DATA, critical(3333))
  let execCalled = false
  const r = killByPids(DATA, 'kill-wrong-token', {
    exec: () => {
      execCalled = true
      return { ok: true }
    },
  })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /不匹配/)
  assert.equal(execCalled, false, 'token 错误时绝不能调 exec')
})

test('killByPids: 无待确认计划时必须被拒绝', () => {
  const r = killByPids(DATA, 'kill-anything', { exec: () => ({ ok: true }) })
  assert.equal(r.ok, false)
})

test('killByPids: 正确 token + 注入 exec 时才执行，并回传被杀 PID', () => {
  const plan = prepareKill(DATA, critical(4444))
  let got = null
  const r = killByPids(DATA, plan.confirmToken, {
    exec: (pids) => {
      got = pids
      return { ok: true }
    },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(got, [4444])
  assert.deepEqual(r.killed, [4444])
})

test('killByPids: 一次性 — 同一 token 不能复用', () => {
  const plan = prepareKill(DATA, critical(5555))
  const first = killByPids(DATA, plan.confirmToken, { exec: () => ({ ok: true }) })
  assert.equal(first.ok, true)
  const second = killByPids(DATA, plan.confirmToken, { exec: () => ({ ok: true }) })
  assert.equal(second.ok, false, 'token 必须一次性')
})

test('confirmPlan: 非 critical 行为不产生终止目标（防误杀）', () => {
  const high = {
    ...critical(6666),
    findings: [
      {
        ruleId: 'R2-fresh-bundle-artifact',
        severity: 'high',
        profileId: 'zcode',
        title: '刚生成打包产物',
        evidence: { path: 'x.tar.gz.enc', pid: 6666 },
        suggest: 'alert',
      },
    ],
  }
  const plan = confirmPlan(high)
  assert.equal(plan.targets.length, 0, 'high 级别不应建议杀进程')
})

test('confirmPlan: 多个 critical 目标去重', () => {
  const multi = critical(7777)
  multi.findings.push({ ...multi.findings[0], evidence: { pid: 7777, remote: 's3.amazonaws.com:443' } })
  const plan = confirmPlan(multi)
  assert.equal(plan.targets.length, 1, '同一 PID 只应出现一次')
})

// ── 逐个确认（用户 2026-09-18 决定）──
test('逐个确认: 默认只针对第一个目标签发 token（不批量）', () => {
  const two = critical(1111)
  two.findings.push({
    ...two.findings[0],
    evidence: { pid: 2222, process: 'Other.exe', remote: 'oss-cn-x.aliyuncs.com:443' },
  })
  assert.equal(confirmPlan(two).targets.length, 2, '候选应列出 2 个')
  const plan = prepareKill(DATA, two)
  assert.equal(plan.confirmTarget.pid, 1111)
  assert.ok(plan.note, '多候选时应提示"本次仅针对第一个"')
})

test('逐个确认: 一次确认只能终止一个进程', () => {
  const two = critical(1111)
  two.findings.push({
    ...two.findings[0],
    evidence: { pid: 2222, process: 'Other.exe', remote: 'oss-cn-x.aliyuncs.com:443' },
  })
  const plan = prepareKill(DATA, two)
  let got = null
  const r = killByPids(DATA, plan.confirmToken, {
    exec: (pids) => {
      got = pids
      return { ok: true }
    },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(got, [1111], '绝不能一次杀两个')
  assert.equal(r.target, 1111)
})

test('逐个确认: 可用 targetPid 指定目标', () => {
  const two = critical(1111)
  two.findings.push({
    ...two.findings[0],
    evidence: { pid: 2222, process: 'Other.exe', remote: 'oss-cn-x.aliyuncs.com:443' },
  })
  const plan = prepareKill(DATA, two, { targetPid: 2222 })
  assert.equal(plan.confirmTarget.pid, 2222)
})

test('逐个确认: 指定不存在的 targetPid 必须报错且不签发 token', () => {
  const plan = prepareKill(DATA, critical(1111), { targetPid: 999999 })
  assert.match(String(plan.error), /不在候选目标中/)
  assert.equal(plan.confirmToken, null)
})

test('逐个确认: 两个目标可分别确认，互不影响', () => {
  const two = critical(1111)
  two.findings.push({
    ...two.findings[0],
    evidence: { pid: 2222, process: 'Other.exe', remote: 'oss-cn-x.aliyuncs.com:443' },
  })
  const p1 = prepareKill(DATA, two, { targetPid: 1111 })
  const p2 = prepareKill(DATA, two, { targetPid: 2222 })
  const got = []
  const r2 = killByPids(DATA, p2.confirmToken, {
    exec: (pids) => {
      got.push(...pids)
      return { ok: true }
    },
  })
  assert.equal(r2.ok, true)
  assert.deepEqual(got, [2222])
  // 第一个 token 仍然有效（未被误作废）
  const r1 = killByPids(DATA, p1.confirmToken, {
    exec: (pids) => {
      got.push(...pids)
      return { ok: true }
    },
  })
  assert.equal(r1.ok, true)
  assert.deepEqual(got, [2222, 1111])
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
