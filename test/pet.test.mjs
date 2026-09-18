/**
 * deskpet-guard — 桌宠测试。
 *
 * 为什么单独测：桌宠是"用户唯一看得见"的那层，却也是最容易悄悄坏掉的
 * （脚本编码、锁文件、幂等、dataDir 解析、客户端不再拉起）。这里用纯 JS 断言
 * 把能测的全测掉；GUI 窗口本身不在这里跑（由人工截图复核）。
 *
 * 运行：node test/pet.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readPetState, petStatusText, launchPet, stopPet, listPetLocks, PET_FACES, PET_CLIENTS, detectClient } from '../lib/pet.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const ROOT = new URL('..', import.meta.url)
const p = (rel) => fileURLToPath(new URL(rel, ROOT))

const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-'))
process.on('exit', () => {
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// 造一份"守护跑过一轮"的快照
writeFileSync(
  join(DATA, 'guard-status.json'),
  JSON.stringify({
    atMs: Date.now() - 1500,
    cycles: 42,
    mood: 'panic',
    headline: '检测到对象存储直传',
    worstSeverity: 'critical',
    activeFindings: 2,
    agentProcessCount: 3,
    egressConnections: 1,
    bundleArtifacts: 3,
    probeErrors: [],
    killTargets: [{ pid: 4242 }],
  }),
)
writeFileSync(
  join(DATA, 'guard-events.jsonl'),
  [
    JSON.stringify({ seq: 1, severity: 'info', ruleId: 'R6-agent-alive-quiet', title: '进程存活' }),
    JSON.stringify({ seq: 2, severity: 'high', ruleId: 'R2-fresh-bundle-artifact', title: '有新的打包产物' }),
    JSON.stringify({ seq: 3, severity: 'critical', ruleId: 'R1-agent-to-object-storage', title: '连向对象存储' }),
  ].join('\n') + '\n',
)

// ───────────────────────── 状态读取（纯 JS，跨平台）─────────────────────────
test('readPetState：mood/表情/headline/计数都取到', () => {
  const s = readPetState(DATA)
  assert.equal(s.mood, 'panic')
  assert.equal(s.face, PET_FACES.panic.face)
  assert.equal(s.headline, '检测到对象存储直传')
  assert.equal(s.cycles, 42)
  assert.deepEqual(s.counts, { agents: 3, egress: 1, bundles: 3, alerts: 2, targets: 1 })
  assert.equal(s.dataDir, DATA)
})

test('readPetState：事件流只挑非 info，且最新在前', () => {
  const s = readPetState(DATA)
  assert.ok(s.lastEvents.length >= 2)
  assert.ok(!s.lastEvents.some((e) => e.severity === 'info'), 'info 级不该进桌宠列表')
  assert.equal(s.lastEvents[0].ruleId, 'R1-agent-to-object-storage', '最新事件应排在最前')
})

test('readPetState：没有快照时不炸，给出"尚无采样"', () => {
  const empty = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-empty-'))
  const s = readPetState(empty)
  assert.equal(s.mood, 'unknown')
  assert.match(s.headline, /尚无采样/)
  rmSync(empty, { recursive: true, force: true })
})

test('petStatusText：一行版包含表情/headline/计数/dataDir', () => {
  const t = petStatusText(DATA)
  assert.match(t, /✖﹏✖/)
  assert.match(t, /检测到对象存储直传/)
  assert.match(t, /打包产物 3/)
  assert.match(t, new RegExp(DATA.replace(/\\/g, '\\\\')))
})

// ───────────────────────── 拉起 / 幂等 / 停止 ─────────────────────────
test('launchPet：用 PowerShell 的 Start-Process 分离启动（不是 Node 的 detached）', () => {
  const calls = []
  const r = launchPet({
    dataDir: DATA,
    client: 'zcode',
    reason: 'test',
    force: true,
    spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args: args.join(' '), opts })
      return { pid: 12345, unref() {} }
    },
  })
  if (process.platform !== 'win32') {
    assert.equal(r.ok, false)
    assert.match(r.message, /Windows/)
    return
  }
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].cmd, /powershell\.exe$/i)
  const line = calls[0].args
  // 回归：Node 的 { detached:true } 在 Windows 上以 DETACHED_PROCESS 起 powershell，
  // 控制台连不上就直接退出（实测进程 3 秒内消失、日志空白）→ 必须用 Start-Process。
  assert.match(line, /Start-Process/, '必须用 PowerShell 的 Start-Process 分离')
  assert.match(line, /deskpet-guard-pet\.ps1/, '没指向桌宠脚本')
  assert.ok(line.includes(DATA), '没传数据目录')
  assert.match(line, /-Client','zcode'/, '没把客户端身份传给窗口')
  assert.match(line, /-Slot','\d+'/, '没传摆放序号')
  // 回归：不加 -WindowStyle Hidden 会弹出一个巨大的 PowerShell 黑窗挡在桌宠位置
  assert.match(line, /-WindowStyle Hidden/, '必须隐藏控制台窗口')
  assert.equal(calls[0].opts.detached, true, '父进程退出后桌宠要能活下来')
})

test('不同客户端各开一只（DSH 有、ZCode 也有），互不顶掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-multi-'))
  const spawned = []
  const fake = (client) => (cmd, args) => {
    spawned.push({ client, line: args.join(' ') })
    // 用测试进程自己的 pid 当"假桌宠"：这样锁指向一个**活着**的进程，
    // 才能验证"同一客户端再拉一次会被跳过"（死 pid 会被判为过期而重新拉起）。
    return { pid: process.pid, unref() {} }
  }
  const a = launchPet({ dataDir: dir, client: 'zcode', force: true, spawnImpl: fake('zcode') })
  const b = launchPet({ dataDir: dir, client: 'dsh', force: true, spawnImpl: fake('dsh') })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(spawned.length, 2, '两个客户端应各拉起一只，而不是共享一只')
  // 锁文件按客户端分开
  assert.ok(existsSync(join(dir, 'pet-zcode.lock')), '缺 zcode 的锁')
  assert.ok(existsSync(join(dir, 'pet-dsh.lock')), '缺 dsh 的锁')
  // 摆放序号不同 → 窗口不重叠
  const slot = (line) => Number((line.match(/-Slot','(\d+)'/) || [])[1])
  assert.notEqual(slot(spawned[0].line), slot(spawned[1].line), '两只桌宠的摆放序号必须不同')
  // 同一客户端再拉一次 → 跳过（不重复开）
  const again = launchPet({ dataDir: dir, client: 'dsh', spawnImpl: fake('dsh') })
  assert.equal(again.skipped, true, '同一客户端不该开出第二只')
  assert.equal(spawned.length, 2)
  const locks = listPetLocks(dir)
  assert.deepEqual(locks.map((x) => x.client).sort(), ['dsh', 'zcode'])
  rmSync(dir, { recursive: true, force: true })
})

test('launchPet：同一客户端已有活着的实例时跳过', () => {
  writeFileSync(join(DATA, 'pet-zcode.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), client: 'zcode' }))
  let spawned = 0
  const r = launchPet({
    dataDir: DATA,
    client: 'zcode',
    spawnImpl: () => {
      spawned++
      return { pid: 1, unref() {} }
    },
  })
  assert.equal(r.skipped, true, '应识别出已有实例')
  assert.equal(spawned, 0, '不该重复拉起')
})

test('停掉桌宠后锁被清掉，随即可再次拉起', () => {
  // 用一个"肯定不存在"的 pid 写锁：stopPet 会去 kill 它（失败被吞），并清掉锁。
  // ⚠️ 别用 process.pid 写锁再 stopPet —— 那会把测试进程自己杀掉（踩过）。
  writeFileSync(join(DATA, 'pet-manual.lock'), JSON.stringify({ pid: 999999, at: Date.now(), client: 'manual' }))
  const r = stopPet(DATA, 'manual')
  assert.equal(r.ok, true)
  assert.ok(!existsSync(join(DATA, 'pet-manual.lock')), 'stopPet 应清理锁文件')
  const r2 = launchPet({
    dataDir: DATA,
    client: 'manual',
    force: true,
    spawnImpl: () => ({ pid: 999, unref() {} }),
  })
  if (process.platform === 'win32') assert.equal(r2.ok, true)
})

test('stopPet all：一次关掉所有客户端的桌宠', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-all-'))
  for (const c of ['zcode', 'dsh']) {
    writeFileSync(join(dir, `pet-${c}.lock`), JSON.stringify({ pid: 999998, at: Date.now(), client: c }))
  }
  const r = stopPet(dir, 'all')
  assert.equal(r.ok, true)
  assert.equal(r.closed.length, 2, '应关掉两只')
  assert.equal(listPetLocks(dir).length, 0, '锁都该清掉')
  rmSync(dir, { recursive: true, force: true })
})

test('桌宠脚本存在、带 UTF-8 BOM（Win PowerShell 5.1 读中文必需）、且是只读的', () => {
  const f = p('bin/deskpet-guard-pet.ps1')
  assert.ok(existsSync(f), '缺 bin/deskpet-guard-pet.ps1')
  const buf = readFileSync(f)
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '丢了 BOM → 5.1 下中文会乱码')
  const src = buf.toString('utf8')
  assert.match(src, /guard-status\.json/, '脚本得读状态快照')
  assert.match(src, /Get-Content -Tail 1/, '脚本得读最近事件')
  assert.match(src, /TopMost/, '桌宠要置顶')
  assert.ok(!/Set-Content|Add-Content|Out-File/.test(src), '桌宠必须是只读的（不写任何文件）')
})

test('ZCode 插件的 SessionStart hook：不依赖 npx，直接拉起壳里的脚本', () => {
  const f = p('deskpet-guard/hooks/hooks.json')
  assert.ok(existsSync(f), '缺 deskpet-guard/hooks/hooks.json（ZCode 的插件组件之一）')
  const j = JSON.parse(readFileSync(f, 'utf8'))
  const ev = j.hooks && j.hooks.events
  assert.ok(ev && Array.isArray(ev.SessionStart), '缺 hooks.events.SessionStart')
  const hook = ev.SessionStart[0].hooks[0]
  assert.equal(hook.command, 'powershell.exe', 'hook 应由 powershell.exe 直接跑，不经 npx')
  const line = hook.args.join(' ')
  assert.match(line, /deskpet-guard-pet\.ps1/, 'hook 没指向桌宠脚本')
  assert.match(line, /Get-ChildItem/, 'hook 应自行在 ~/.zcode 下找脚本（不依赖变量替换）')
  assert.match(line, /WindowStyle Hidden/, 'hook 拉起的进程要隐藏控制台（否则弹黑窗）')
  // 壳里的脚本副本必须与 bin/ 下的那份逐字节相同，否则改了本体忘了同步
  const a = readFileSync(p('bin/deskpet-guard-pet.ps1'))
  const b = readFileSync(p('deskpet-guard/scripts/deskpet-guard-pet.ps1'))
  assert.ok(a.equals(b), 'deskpet-guard/scripts/ 下的桌宠脚本与 bin/ 下的不一致')
  assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf], '壳里的脚本副本丢了 BOM')
})

test('MCP server 启动时会顺带拉起桌宠（"启动 agent 就看到"），且可被关掉', () => {
  const src = readFileSync(p('lib/mcp.js'), 'utf8')
  assert.match(src, /launchPet\(\{[\s\S]{0,160}?reason: 'mcp-start'/, 'mcp.js 没在启动时拉起桌宠')
  assert.match(src, /client: opts\.client \|\| detectClient\(\)/, 'mcp.js 拉起桌宠时没带上客户端身份（各自都要有一只）')
  assert.match(src, /DESKPET_GUARD_NO_PET/, '缺少关闭开关（测试/无头环境需要）')
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
