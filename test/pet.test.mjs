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
import {
  readPetState,
  petStatusText,
  launchPet,
  stopPet,
  listPetLocks,
  PET_FACES,
  PET_CLIENTS,
  detectClient,
  resolveWatchTarget,
  parsePetCmdline,
  findRunningPets,
} from '../lib/pet.js'

let pass = 0
let fail = 0
let skipped = 0
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
  assert.match(line, /deskpet-guard-pet2?.ps1/, '没指向桌宠脚本')
  assert.ok(line.includes(DATA), '没传数据目录')
  assert.match(line, /-Client','zcode'/, '没把客户端身份传给窗口')
  assert.match(line, /-Slot','\d+'/, '没传摆放序号')
  // 回归：不加 -WindowStyle Hidden 会弹出一个巨大的 PowerShell 黑窗挡在桌宠位置
  assert.match(line, /-WindowStyle Hidden/, '必须隐藏控制台窗口')
  assert.equal(calls[0].opts.detached, true, '父进程退出后桌宠要能活下来')
})

test('全机单只：第二个客户端拉起会被跳过（0.5 起不再每客户端各一只）', () => {
  // 桌宠窗口是 Windows 实现：非 Windows 上 launchPet 会先返回"不支持"，
  // 这些断言在那边没有意义（CI 的 ubuntu 曾因此整条红掉）→ 显式跳过并计数。
  if (process.platform !== 'win32') {
    skipped++
    console.log('  SKIP  全机单只（桌宠为 Windows 实现）')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-single-'))
  const spawned = []
  const fake = (client) => (cmd, args) => {
    spawned.push({ client, line: args.join(' ') })
    // 用测试进程自己的 pid 当"假桌宠"：锁指向一个**活着**的进程，
    // 才能验证"再拉一次会被跳过"（死 pid 会被判为过期而重新拉起）。
    return { pid: process.pid, unref() {} }
  }
  const a = launchPet({ dataDir: dir, client: 'dsh', force: true, processTable: [], spawnImpl: fake('dsh') })
  assert.equal(a.ok, true)
  assert.equal(spawned.length, 1)
  assert.ok(existsSync(join(dir, 'pet.lock')), '应写全局锁 pet.lock')
  const b = launchPet({ dataDir: dir, client: 'zcode', processTable: [], spawnImpl: fake('zcode') })
  assert.equal(b.skipped, true, '第二个客户端不该再拉一只（全机单只）')
  assert.equal(spawned.length, 1, '桌面上永远只有一只')
  assert.ok(!existsSync(join(dir, 'pet-zcode.lock')), '不再写 per-client 锁')
  const locks = listPetLocks(dir, { processTable: [] })
  assert.deepEqual(locks.map((x) => x.client), ['global'])
  rmSync(dir, { recursive: true, force: true })
})

test('launchPet：已有活着的桌宠时跳过（全机单只，不分客户端）', () => {
  if (process.platform !== 'win32') {
    skipped++
    console.log('  SKIP  已有活着的桌宠时跳过（桌宠为 Windows 实现）')
    return
  }
  writeFileSync(join(DATA, 'pet.lock'), JSON.stringify({ pid: process.pid, at: Date.now(), client: 'zcode' }))
  let spawned = 0
  const r = launchPet({
    dataDir: DATA,
    client: 'dsh',
    processTable: [],
    spawnImpl: () => {
      spawned++
      return { pid: 1, unref() {} }
    },
  })
  assert.equal(r.skipped, true, '应识别出已有实例（DSH 来拉也撞上 ZCode 那只的锁）')
  assert.equal(spawned, 0, '不该重复拉起')
})

test('停掉桌宠后锁被清掉，随即可再次拉起', () => {
  // 用一个"肯定不存在"的 pid 写锁：stopPet 会去 kill 它（失败被吞），并清掉锁。
  // ⚠️ 别用 process.pid 写锁再 stopPet —— 那会把测试进程自己杀掉（踩过）。
  writeFileSync(join(DATA, 'pet.lock'), JSON.stringify({ pid: 999999, at: Date.now(), client: 'manual' }))
  const r = stopPet(DATA, 'manual')
  assert.equal(r.ok, true)
  assert.ok(!existsSync(join(DATA, 'pet.lock')), 'stopPet 应清理锁文件')
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
  const r = stopPet(dir, 'all', { processTable: [] })
  assert.equal(r.ok, true)
  assert.equal(r.closed.length, 2, '应关掉两只')
  assert.equal(listPetLocks(dir, { processTable: [] }).length, 0, '锁都该清掉')
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
  assert.ok(!/Set-Content|Add-Content|Out-File/.test(src), '桌宠除单实例锁外必须只读（不写任何数据文件）')
  assert.match(src, /pet\.lock/, '旧版脚本也要参与全机单只锁（已有桌宠在跑时直接退出）')
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

test('看护对象解析：DSH 用宿主 pid（关 DSH → 桌宠跟着关）', () => {
  const t = resolveWatchTarget({ client: 'dsh', endpoint: { pid: 4242 }, processTable: [] })
  assert.equal(t.pid, 4242)
  assert.match(t.why, /endpoint/)
})

test('看护对象解析：已知客户端按进程名看护（对 npx/cmd 壳免疫）', () => {
  const table = [
    { pid: 111, ppid: 1, name: 'ZCode.exe', cmd: 'ZCode.exe' },
    { pid: 222, ppid: 111, name: 'cmd.exe', cmd: 'cmd /c npx -y deskpet-guard' },
    { pid: 333, ppid: 222, name: 'node.exe', cmd: 'node mcp.js' },
  ]
  const t = resolveWatchTarget({ client: 'zcode', selfPid: 333, processTable: table })
  assert.equal(t.process, 'ZCode', '要按名字看护，而不是拿 npx/cmd 的 pid')
  assert.equal(t.pid, 111)
})

test('看护对象解析：不认识的客户端沿父链跳过短命壳（npx/cmd 不算客户端）', () => {
  const table = [
    { pid: 900, ppid: 1, name: 'some-client.exe', cmd: 'some-client.exe' },
    { pid: 901, ppid: 900, name: 'cmd.exe', cmd: 'cmd /c npx -y deskpet-guard' },
    { pid: 902, ppid: 901, name: 'node.exe', cmd: 'node mcp.js' },
  ]
  const t = resolveWatchTarget({ client: 'mcp', selfPid: 902, processTable: table })
  assert.equal(t.pid, 900, '应跳过 cmd.exe 这个壳，选真客户端')
  assert.match(t.why, /some-client/)
})

test('看护对象解析：解析不出来就如实说（不假装能自动关）', () => {
  const t = resolveWatchTarget({ client: 'mcp', selfPid: 555, processTable: [] })
  assert.equal(t.pid || 0, 0)
  assert.match(t.why, /不会自动关闭/)
})


test('从命令行认出桌宠：解析 client 与看护对象（不再只信锁文件）', () => {
  const cmd =
    '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File D:/deskpet-guard/bin/deskpet-guard-pet.ps1 -DataDir C:/x -Client dsh -Slot 3 -WatchPid 47848 '
  const p = parsePetCmdline(cmd)
  assert.equal(p.client, 'dsh')
  assert.equal(p.watchPid, 47848)
  assert.equal(p.script, 'pet', '旧脚本要认出是 pet')
  const p2 = parsePetCmdline('powershell -File D:/x/bin/deskpet-guard-pet2.ps1 -DataDir C:/x -Client mcp -Slot 0')
  assert.equal(p2.client, 'mcp')
  assert.equal(p2.script, 'pet2', 'pet2 要认出是 pet2（升级替换的依据）')
  assert.equal(parsePetCmdline('C:/Windows/explorer.exe'), null, '无关进程不能被误判成桌宠')
})

test('findRunningPets：锁丢了也能按进程发现孤儿桌宠', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'powershell.exe', cmd: 'powershell -File D:/x/bin/deskpet-guard-pet.ps1 -Client zcode -Slot 0' },
    { pid: 11, ppid: 1, name: 'powershell.exe', cmd: 'powershell -File D:/x/bin/deskpet-guard-pet.ps1 -Client dsh -Slot 3' },
    { pid: 12, ppid: 1, name: 'explorer.exe', cmd: 'C:/Windows/explorer.exe' },
    { pid: 13, ppid: 1, name: 'powershell.exe', cmd: 'powershell -File D:/x/bin/deskpet-guard-pet2.ps1 -Client mcp -Slot 0' },
  ]
  const pets = findRunningPets(table)
  assert.equal(pets.length, 3, 'pet2 也必须能按进程发现（此前正则只匹配旧脚本名，pet2 全靠锁文件）')
  assert.deepEqual(pets.map((x) => x.client).sort(), ['dsh', 'mcp', 'zcode'])
  assert.equal(pets.find((x) => x.pid === 13).script, 'pet2')
})

test('launchPet：已有 pet2 在跑 → 接管（补写全局锁、不重复开）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-adopt-'))
  let spawned = 0
  const table = [
    { pid: 5150, ppid: 1, name: 'powershell.exe', cmd: 'powershell -File D:/x/bin/deskpet-guard-pet2.ps1 -Client dsh -Slot 0' },
  ]
  const r = launchPet({
    dataDir: dir,
    client: 'zcode',
    processTable: table,
    spawnImpl: () => {
      spawned++
      return { pid: 1, unref() {} }
    },
  })
  if (process.platform === 'win32') {
    assert.equal(r.skipped, true, '应按进程发现并接管，而不是再开一只（全机单只，不分客户端）')
    assert.equal(spawned, 0)
    assert.equal(r.pid, 5150)
    assert.ok(existsSync(join(dir, 'pet.lock')), '接管后应补写全局锁')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('launchPet：在跑的是旧版文本宠而本机能跑 pet2 → 升级替换（关旧宠、拉 pet2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-guard-pet-upgrade-'))
  let spawnedLine = ''
  const table = [
    // ZCode hook 拉起的旧版文本宠长这样（没有看板页，也常没有锁文件）
    { pid: 4242424, ppid: 1, name: 'powershell.exe', cmd: 'powershell -File D:/x/bin/deskpet-guard-pet.ps1 -Client zcode -Slot 0' },
  ]
  const r = launchPet({
    dataDir: dir,
    client: 'mcp',
    processTable: table,
    spawnImpl: (cmd, args) => {
      spawnedLine = args.join(' ')
      return { pid: 777, unref() {} }
    },
  })
  if (process.platform === 'win32') {
    assert.equal(r.ok, true, '升级路径应走到全新拉起')
    assert.equal(r.skipped, undefined, '升级不该被当成"已在运行"跳过')
    assert.match(spawnedLine, /deskpet-guard-pet2/, '升级后应拉起 pet2（带看板页）')
    assert.ok(existsSync(join(dir, 'pet.lock')), '升级后应写新锁')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('双击启动器 start-pet.cmd：存在、纯 ASCII、指向真实启动器', () => {
  const f = p('start-pet.cmd')
  assert.ok(existsSync(f), '缺 start-pet.cmd（README 里让用户双击它启动桌宠）')
  const src = readFileSync(f, 'utf8')
  assert.match(src, /deskpet-guard-pet\.js/, '没指向 bin/deskpet-guard-pet.js')
  assert.match(src, /--client dsh/, '默认 client 丢了')
  // 血案：GBK 双字节尾字节可能是 & 或 |，cmd 会把后半行当命令 → 必须纯 ASCII
  assert.ok(!/[^ -]/.test(src), 'start-pet.cmd 必须纯 ASCII（中文请写进 README）')
})

test('MCP 声明用 @latest（否则 npx 会把旧版本缓存住，用户看到旧界面）', () => {
  for (const rel of ['deskpet-guard/.mcp.json', 'deskpet-guard/.zcode-plugin/plugin.json', 'deskpet-guard/.claude-plugin/plugin.json']) {
    const src = readFileSync(p(rel), 'utf8')
    const m = JSON.parse(src)
    const servers = m.mcpServers || {}
    const args = servers['deskpet-guard'] && servers['deskpet-guard'].args
    if (!args) continue
    assert.ok(args.includes('deskpet-guard@latest'), rel + ' 必须写 @latest：npx 缓存会钉住旧版本（真实踩过，用户看到旧界面）')
  }
})

test('ZCode hook 取最新脚本副本（cache/ 与 marketplaces/ 会有多份）', () => {
  const j = JSON.parse(readFileSync(p('deskpet-guard/hooks/hooks.json'), 'utf8'))
  const line = j.hooks.events.SessionStart[0].hooks[0].args.join(' ')
  assert.match(line, /Sort-Object LastWriteTime -Descending/, '必须按时间取最新，不能拿第一个（可能命中旧缓存副本）')
})

test('pet2（WebView2 一体窗）：脚本存在、带 UTF-8 BOM、含运行时探测与旧版回退链', () => {
  const f = p('bin/deskpet-guard-pet2.ps1')
  assert.ok(existsSync(f), 'pet2 脚本应存在')
  const buf = readFileSync(f)
  // PS 5.1 读无 BOM 的中文脚本会按 GBK 误读 → 语法错乱（0.4.0 实测踩过）
  assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'pet2.ps1 必须是带 BOM 的 UTF-8')
  const src = buf.toString('utf8')
  assert.match(src, /EdgeUpdate.Clients/, '应有 WebView2 运行时注册表探测')
  assert.match(src, /deskpet-guard-pet.ps1/, '应有旧版桌宠回退链')
  assert.match(src, /dpg:minimize/, '应处理最小化消息')
  assert.match(src, /dpg:window-drag/, '应处理拖动消息（旧看板页兼容）')
  assert.match(src, /dpg:native-drag/, '应处理原生拖动消息（长按拖动）')
  assert.match(src, /dpg:quit/, '应处理退出消息（全机单只后需手动退出）')
  assert.match(src, /ReleaseCapture/, '原生拖动要先释放鼠标捕获')
  assert.match(src, /TopMost\s*=\s*\$true/, '桌宠必须常驻置顶（全屏应用不能盖住桌宠）')
  assert.match(src, /vendor\\webview2/, '应从随包 vendor 目录加载互操作程序集')
  assert.ok(existsSync(p('vendor/webview2/Microsoft.Web.WebView2.WinForms.dll')), 'vendor 互操作程序集应随包存在')
  assert.ok(existsSync(p('vendor/webview2/WebView2Loader.dll')), '原生加载器应随包存在')
})

test('dashboard 页（pet2 看板）：面板只从右键菜单开 + 有关闭按钮 + 左键不再开面板', () => {
  const src = readFileSync(p('assets/dashboard.html'), 'utf8')
  assert.ok(!/drag&&!drag\.moved\)togglePanel\(\)/.test(src), '左键松开不该再开面板（统一走右键菜单）')
  assert.match(src, /id="panel-close"/, '面板要有关闭按钮')
  assert.match(src, /setPanel\(false\)/, '关闭按钮要能把面板收起')
  assert.match(src, /dpg:native-drag/, 'WebView2 下应请求宿主原生拖动（长按拖动）')
  assert.match(src, /ctx-dash/, '右键菜单里要有开关看板的入口')
  assert.match(src, /firstStartMs/, '自动跟随要按"最早启动"选 agent（全机单只）')
  assert.match(src, /ctx-quit/, '右键菜单里要有退出桌宠入口')
  assert.match(src, /Codex \/ ChatGPT/, 'codex 与 chatgpt 合并为一个 agent（用户口径）')
  assert.match(src, /gemini/, 'Gemini 要进面板 agent 列表')
  assert.match(src, /BAD_MASCOT/, '形象图缺失要自动兜底成 chibi，不留破图')
  // 回归1：收起态窗口 300x240 装不下菜单，开菜单要把窗口撑到菜单+头像都放得下
  assert.match(src, /m\.style\.right=/, '菜单要排到桌宠旁边，不能盖住桌宠')
  assert.match(src, /function closeCtxMenu/, '关菜单要把窗口缩回去')
  // 回归2：窗口外的点击传不进页面，菜单必须还有别的关闭路径（失焦/Esc/点外面）
  assert.match(src, /window\.addEventListener\('blur',closeCtxMenu\)/, '失焦要能关菜单')
  assert.match(src, /Escape/, 'Esc 要能关菜单')
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
