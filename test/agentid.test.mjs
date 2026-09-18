/**
 * deskpet-guard — agent 归属层测试。
 *
 * 这一层决定"每只桌宠显示谁的数据"，错了就会出现"两只桌宠都以为是自己干的"
 * 或者"把别人的锅扣到本 agent 头上"——比不显示更糟。所以：
 *   · 认得出的必须认对；
 *   · 认不出的必须进 unknown，**不许瞎猜**；
 *   · 桌宠取自己那份时，未归属要单独可见、不能混进自己的计数。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  agentOfProcess,
  agentOfPath,
  agentOfProfile,
  agentOfFinding,
  agentOfCommandLine,
  buildPidResolver,
  attributeScan,
  viewForClient,
} from '../lib/agentid.js'
import { readPetState, petStatusText } from '../lib/pet.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

test('进程名 → agent（含大小写/带 .exe）', () => {
  assert.equal(agentOfProcess('ZCode'), 'zcode')
  assert.equal(agentOfProcess('zcode.exe'), 'zcode')
  assert.equal(agentOfProcess('Claude'), 'claude')
  assert.equal(agentOfProcess('Cursor.exe'), 'cursor')
  assert.equal(agentOfProcess('codex'), 'codex')
})

test('进程名认不出 → unknown（不瞎猜）', () => {
  for (const n of ['Weixin', '微信开发者工具', 'svchost', 'node', '', null, 'chrome']) {
    assert.equal(agentOfProcess(n), 'unknown', `${n} 不该被归属到某个 agent`)
  }
})

test('路径 → agent（数据目录/工作区标记）', () => {
  assert.equal(agentOfPath('C:\\Users\\chen\\.zcode\\cli\\config.json'), 'zcode')
  assert.equal(agentOfPath('C:\\Users\\chen\\.dsh\\super-injector\\deskpet-guard'), 'dsh')
  assert.equal(agentOfPath('C:\\Users\\chen\\.claude\\projects\\x'), 'claude')
  assert.equal(agentOfPath('C:\\Users\\chen\\Desktop\\report.docx'), 'unknown')
})

test('画像 id → agent；"*" 属全机 → unknown', () => {
  assert.equal(agentOfProfile('claude-code'), 'claude')
  assert.equal(agentOfProfile('*'), 'unknown')
  assert.equal(agentOfProfile(''), 'unknown')
})

test('finding 归属优先级：进程名 > 路径 > 画像', () => {
  assert.equal(agentOfFinding({ evidence: { process: 'ZCode.exe' } }), 'zcode')
  assert.equal(agentOfFinding({ evidence: { path: 'C:\\x\\.cursor\\y' } }), 'cursor')
  assert.equal(agentOfFinding({ profileId: 'cline', evidence: {} }), 'cline')
  assert.equal(agentOfFinding({ profileId: '*', evidence: { process: 'svchost' } }), 'unknown')
})

test('attributeScan：按 agent 拆计数与目标，且 unknown 单独一桶', () => {
  const findings = [
    { ruleId: 'R1', severity: 'critical', evidence: { process: 'ZCode.exe' } },
    { ruleId: 'R2', severity: 'high', evidence: { path: 'C:\\u\\.zcode\\ws\\a.tar.gz.enc' } },
    { ruleId: 'R4', severity: 'medium', evidence: { file: 'C:\\Users\\chen\\.ssh\\id_rsa' } },
  ]
  const targets = [{ pid: 1, process: 'ZCode.exe' }, { pid: 2, process: 'explorer' }]
  const a = attributeScan({ findings, killTargets: targets })
  assert.equal(a.perAgent.zcode.alerts, 2, 'zcode 应认领两条')
  assert.equal(a.perAgent.zcode.critical, 1)
  assert.equal(a.perAgent.zcode.targets, 1)
  assert.equal(a.perAgent.unknown.alerts, 1, 'ssh 那条认不出进程/路径 → unknown')
  assert.equal(a.perAgent.unknown.targets, 1, 'explorer 不是 agent → unknown')
  assert.deepEqual(a.agents, ['unknown', 'zcode'])
})

test('viewForClient：自己的归自己，未归属单独可见', () => {
  const a = attributeScan({
    findings: [
      { ruleId: 'R1', severity: 'critical', evidence: { process: 'ZCode' } },
      { ruleId: 'R4', severity: 'medium', evidence: { file: 'C:\\x\\y' } },
    ],
    killTargets: [],
  })
  const z = viewForClient(a, 'zcode')
  assert.equal(z.mine.alerts, 1)
  assert.equal(z.unattributed.alerts, 1)
  const d = viewForClient(a, 'dsh')
  assert.equal(d.mine.alerts, 0, 'DSH 不该认领 ZCode 的告警')
  assert.equal(d.unattributed.alerts, 1)
})

test('桌宠视图：有归属数据时只显示自己那家（含未归属提示）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-agentid-'))
  writeFileSync(
    join(dir, 'guard-status.json'),
    JSON.stringify({
      atMs: Date.now(),
      cycles: 7,
      mood: 'panic',
      headline: '全机：检测到对象存储直传',
      activeFindings: 3,
      agentProcessCount: 327,
      egressConnections: 13,
      bundleArtifacts: 3,
      probeErrors: [],
      killTargets: [],
      perAgent: {
        zcode: { alerts: 1, critical: 1, high: 0, medium: 0, low: 0, info: 0, targets: 1, findings: [] },
        dsh: { alerts: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, targets: 0, findings: [] },
        unknown: { alerts: 2, critical: 1, high: 0, medium: 0, low: 0, info: 0, targets: 0, findings: [] },
      },
    }),
  )
  writeFileSync(join(dir, 'guard-events.jsonl'), '')

  const z = readPetState(dir, { client: 'zcode' })
  assert.equal(z.scoped, true)
  assert.equal(z.client, 'zcode')
  assert.equal(z.mine.alerts, 1)
  assert.equal(z.unattributed.alerts, 2)
  assert.match(z.headline, /ZCODE/, 'zcode 的桌宠标题要带自己的名字')
  assert.match(z.headline, /未归属 2/, '未归属必须在标题里可见，不能悄悄吞掉')

  const d = readPetState(dir, { client: 'dsh' })
  assert.equal(d.mine.alerts, 0, 'DSH 的桌宠不该看到 ZCode 的告警')
  assert.match(d.headline, /DSH/)
  assert.match(petStatusText(dir, { client: 'dsh' }), /本客户端【dsh】告警 0/)
  rmSync(dir, { recursive: true, force: true })
})

test('桌宠视图：宿主还没写归属数据时，如实退化并标注（不假装各自监控）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-agentid-old-'))
  writeFileSync(
    join(dir, 'guard-status.json'),
    JSON.stringify({ atMs: Date.now(), cycles: 3, mood: 'alert', headline: '全机：有中等级别异常', activeFindings: 1, probeErrors: [] }),
  )
  writeFileSync(join(dir, 'guard-events.jsonl'), '')
  const s = readPetState(dir, { client: 'zcode' })
  assert.equal(s.scoped, false, '没有 perAgent 时必须标记未归属视图')
  assert.match(petStatusText(dir, { client: 'zcode' }), /还没写按 agent 归属的数据/)
  rmSync(dir, { recursive: true, force: true })
})


test('cmdline → agent：node 形态的 agent 靠命令行认（进程名认不出）', () => {
  // 用正斜杠写 Windows 路径：测试的可读性优先，正则对 / 和 \ 都认
  assert.equal(agentOfCommandLine('node "C:/Program Files/nodejs/node_modules/pnpm/bin/pnpm.mjs" dlx @deepseek-ai/dsh web'), 'dsh')
  assert.equal(agentOfCommandLine('C:/Program Files/ZCode/ZCode.exe --type=renderer'), 'zcode')
  assert.equal(agentOfCommandLine('node -e "console.log(1)"'), 'unknown')
  assert.equal(agentOfCommandLine('C:/Windows/system32/svchost.exe -k netsvcs'), 'unknown')
})

test('父进程链：node 子进程归到拉起它的客户端（MCP server 的真实形态）', () => {
  const details = [
    { pid: 100, ppid: 50, name: 'ZCode.exe', cmd: 'C:/Program Files/ZCode/ZCode.exe' },
    { pid: 200, ppid: 100, name: 'node.exe', cmd: 'node "D:/x/node_modules/.bin/mcp" --stdio' },
    { pid: 300, ppid: 1, name: 'node.exe', cmd: 'node something-else.js' },
  ]
  const resolve = buildPidResolver(details)
  assert.equal(resolve(100), 'zcode', '客户端本体')
  assert.equal(resolve(200), 'zcode', '它的 node 子进程要沿父链归到 zcode')
  assert.equal(resolve(300), 'unknown', '无关 node 进程不许瞎归')
  assert.equal(resolve(999999), 'unknown', '不存在的 pid')
})

test('attributeScan 带 pid 解析器时，node 形态的告警能归到正确 agent', () => {
  const details = [
    { pid: 100, ppid: 1, name: 'ZCode.exe', cmd: 'D:/ZCode/ZCode.exe' },
    { pid: 200, ppid: 100, name: 'node.exe', cmd: 'node mcp.js' },
  ]
  const a = attributeScan(
    {
      findings: [{ ruleId: 'R1', severity: 'critical', evidence: { pid: 200, process: 'node' } }],
      killTargets: [{ pid: 200, process: 'node' }],
    },
    { resolvePid: buildPidResolver(details) },
  )
  assert.equal(a.perAgent.zcode.alerts, 1, 'node 子进程的告警应归到 zcode')
  assert.equal(a.perAgent.zcode.targets, 1)
  assert.equal(a.perAgent.unknown, undefined, '不该落到 unknown')
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
