/**
 * deskpet-guard — 桌面桌宠（跨 agent 的"看得见"那一层）。
 *
 * 为什么是**独立窗口**而不是往客户端里插组件：
 *   · DSH 有 client slot（shell.overlay），所以 DSH 里桌宠是画在 GUI 内的；
 *   · ZCode / Claude Code / Cursor 这类 agent 的插件 API 只有
 *     skills / commands / agents / hooks / MCP —— **没有"往界面插悬浮组件"的能力**，
 *     任何插件都画不出桌宠。
 * 所以这里把桌宠做成一个**独立的桌面窗口进程**，由各客户端在启动时拉起：
 *   · ZCode：插件 hooks/hooks.json 的 SessionStart（官方插件同款机制）
 *   · 任何会启动本包 MCP server 的客户端：serveStdio 启动时顺带拉起（幂等）
 *   · 手动：node bin/deskpet-guard-mcp.js --pet
 *
 * 零依赖：窗口本身用 Windows 自带的 PowerShell + WinForms 画（不装 Electron/Tauri）。
 * 非 Windows 平台直接返回 unsupported，不假装成功。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir, readStatus, readEvents, readEndpoint } from './events.js'
import { UNKNOWN_AGENT } from './agentid.js'
import { queryProcessTable } from './probe.js'
import { ensureSampler } from './sampler.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PET_SCRIPT = join(HERE, '..', 'bin', 'deskpet-guard-pet.ps1')
// 0.4.0：优先用 WebView2 一体窗（形象+看板同窗，随包 vendor 程序集）；
// vendor 缺失（裁剪安装）时回退旧版 WinForms 桌宠脚本。pet2 自身还会探测运行时再兜底一次。
const PET2_SCRIPT = join(HERE, '..', 'bin', 'deskpet-guard-pet2.ps1')
const LOG_NAME = 'pet.log'

/**
 * 0.4.1 起桌宠改为**全机一只**：任何客户端（DSH/ZCode/MCP/CLI）拉起时发现已有一只
 * 就跳过，不再每客户端各一只。PET_CLIENTS 现在只用来清理旧版本遗留的 per-client 锁。
 */
export const PET_CLIENTS = ['zcode', 'claude', 'cursor', 'dsh', 'mcp', 'manual']
export const PET_LOCK = 'pet.lock'
const legacyLockName = (client) => `pet-${client}.lock`

/**
 * 从进程命令行里认出"这是我们的一只桌宠"，并解析出它属于哪个客户端、在看护谁、
 * 跑的是哪份脚本（pet2 = WebView2 一体窗有看板页；pet = 旧版 WinForms 文本宠）。
 * 为什么按命令行找而不是只信锁文件：锁文件可能被删/丢（真实踩过：删了锁之后
 * 两只孤儿桌宠谁都管不到，宿主看不到锁又拉起一只 → 桌面上出现两只）。
 */
export function parsePetCmdline(cmd) {
  const s = String(cmd || '')
  if (!/deskpet-guard-pet2?\.ps1/i.test(s)) return null
  const unq = (x) => String(x || '').replace(/^["']|["']$/g, '')
  const client = unq((s.match(/-Client\s+("[^"]*"|'[^']*'|\S+)/i) || [])[1])
  const watchPid = Number((s.match(/-WatchPid\s+(\d+)/i) || [])[1] || 0) || 0
  const watchProcess = unq((s.match(/-WatchProcess\s+("[^"]*"|'[^']*'|\S+)/i) || [])[1])
  // pet2 的文件名也含 "deskpet-guard-pet" 前缀，用带 2 的完整名区分
  const script = /deskpet-guard-pet2\.ps1/i.test(s) ? 'pet2' : 'pet'
  return { client: client || 'unknown', watchPid, watchProcess, script }
}

/** 找出当前真正在跑的桌宠进程（不依赖锁文件）。 */
export function findRunningPets(processTable) {
  const table = processTable || []
  const out = []
  for (const d of table) {
    const parsed = parsePetCmdline(d.cmd)
    if (parsed) out.push({ pid: Number(d.pid) || 0, ppid: Number(d.ppid) || 0, ...parsed })
  }
  return out
}

/**
 * 客户端进程名（用于"按名字看护"，比 pid 稳：npx/cmd 这类壳拉起真身就退了）。
 */
export const CLIENT_PROCESS_NAME = {
  zcode: 'ZCode',
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  cline: 'Cline',
  windsurf: 'Windsurf',
}

/** 拉起方常见的"短命壳"：拿它们当看护对象会导致桌宠秒退（真实踩过）。 */
const TRANSIENT_PROC = /^(cmd|powershell|pwsh|conhost|sh|bash|npx|npm|node_repl).exe$/i

/**
 * 解析"该看护谁"。纯函数，便于测试。
 *
 * 血案：ZCode 用 `npx -y deskpet-guard` 拉起 MCP server → 进程链是
 * ZCode → npx → node(mcp)，而 npx 起完 node 就退了。若把 process.ppid（那个 npx 壳）
 * 当看护对象，桌宠会在几秒后判定"客户端没了"自己关掉（用户实测：出来后又消失）。
 *
 * 解析顺序：
 *   1) DSH：用 endpoint.json 里的宿主 pid（关掉 DSH → 桌宠跟着走）
 *   2) 已知客户端：按**进程名**看护（对壳免疫）
 *   3) 其它：沿父进程链上溯，挑第一个非"短命壳"的祖先
 * @returns {{pid?:number, process?:string, why:string}}
 */
export function resolveWatchTarget(opts = {}) {
  const client = opts.client || 'unknown'
  const env = opts.env || {}
  const table = opts.processTable || []
  const endpointPid = Number((opts.endpoint && opts.endpoint.pid) || 0) || 0
  const selfPid = Number(opts.selfPid || 0) || 0

  if (client === 'dsh' && endpointPid > 0) {
    return { pid: endpointPid, why: 'DSH 宿主 pid（来自 endpoint.json）' }
  }
  const byName = CLIENT_PROCESS_NAME[client]
  // 进程名比较要去掉 .exe（Get-Process 的 Name 不带扩展名，但 CIM 的 Name 带）
  const norm = (x) => String(x || '').replace(/\.exe$/i, '').toLowerCase()
  const namePid = byName ? (table.find((d) => norm(d.name) === byName.toLowerCase()) || {}).pid : 0
  if (byName && namePid) {
    return { pid: Number(namePid), process: byName, why: '客户端进程名（对 npx/cmd 壳免疫）' }
  }
  if (byName && !table.length) {
    // 拿不到进程表时，至少按名字看护
    return { process: byName, why: '仅按客户端进程名看护（进程表不可用）' }
  }

  // 沿父进程链上溯，跳过短命壳
  const byPid = new Map(table.map((d) => [Number(d.pid) || 0, d]))
  let cur = selfPid
  const seen = new Set()
  let best = 0
  for (let hop = 0; cur && hop < 10 && !seen.has(cur); hop++) {
    seen.add(cur)
    const d = byPid.get(cur)
    if (!d) break
    if (cur !== selfPid && !TRANSIENT_PROC.test(String(d.name || ''))) best = cur
    cur = Number(d.ppid) || 0
  }
  if (best > 0) {
    const d = byPid.get(best)
    return { pid: best, why: '父进程链上第一个非短命壳的祖先（' + String(d && d.name) + '）' }
  }
  return { why: '无法确定看护对象：桌宠不会自动关闭（会记到 pet.log）' }
}

/** 猜"谁在跑我"：MCP server 是被客户端拉起的，得自己认领身份，才能各开一只。 */
export function detectClient(env = process.env) {
  const has = (p) => Object.keys(env).some((k) => k.toUpperCase().startsWith(p))
  if (has('ZCODE_')) return 'zcode'
  if (has('CLAUDE_')) return 'claude'
  if (has('CURSOR_')) return 'cursor'
  if (env.DSH_HOME || env.DSH_SESSION_ID || has('DSH_')) return 'dsh'
  return 'mcp'
}

/** 桌宠表情（与 lib/client.js 的 MOODS 保持同一套语义）。 */
export const PET_FACES = {
  watching: { face: '( ◕‿◕ )', label: '守着', color: '#2ecc71' },
  alert: { face: '( ◉_◉ )', label: '留意', color: '#f1c40f' },
  panic: { face: '( ✖﹏✖ )', label: '高危', color: '#e74c3c' },
  unknown: { face: '( ・_・)', label: '未采样', color: '#8899aa' },
}

/**
 * 读一份"桌宠要显示的状态"（纯函数，不碰 UI，便于测试）。
 *
 * 按 agent 归属（第 3 步）：每只桌宠只显示**自己那家 agent** 的告警，
 * 判不出归属的单独列成「未归属」，绝不混进自己的数字里。
 * 拿不到归属数据（宿主还是旧版 / 探针降级）时退化为全机视图，并如实标注 `scoped:false`。
 *
 * @param {string} [dataDir]
 * @param {{client?:string}} [opts]
 */
export function readPetState(dataDir, opts = {}) {
  const dir = dataDir || resolveDataDir()
  const client = opts.client || detectClient()
  const status = readStatus(dir)
  const events = readEvents(dir, 20) || []
  const notifiable = events.filter((e) => e && e.severity !== 'info')
  const moodKey = (status && status.mood) || 'unknown'
  const face = PET_FACES[moodKey] || PET_FACES.unknown

  const per = (status && status.perAgent) || null
  const machine = (status && status.machine) || null
  const EMPTY = {
    alerts: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    targets: 0,
    procs: 0,
    egress: 0,
    bundles: 0,
    findings: [],
  }
  const mine = (per && per[client]) || (per ? EMPTY : null)
  const un = (per && per[UNKNOWN_AGENT]) || (per ? EMPTY : null)
  const scoped = !!per

  // 有归属数据时，headline 用"自己这家"的说法；没有就退回全机说法并标注
  let headline = (status && status.headline) || '尚无采样（守护没在跑）'
  if (scoped) {
    const name = client.toUpperCase()
    if (mine.critical > 0 || mine.targets > 0) headline = `${name}：${mine.critical || mine.targets} 个高危待处理`
    else if (mine.alerts > 0) headline = `${name}：${mine.alerts} 条告警待复核`
    else headline = `${name}：无异常`
    if (un && un.alerts > 0) headline += `（未归属 ${un.alerts}）`
  }

  return {
    dataDir: dir,
    client,
    scoped,
    mine,
    unattributed: un,
    /** 全机计数（每只桌宠都一样，界面上要标注成全机，别混进自己那行） */
    machine: {
      processes: (machine && machine.processes) || (status && status.agentProcessCount) || 0,
      egress: (machine && machine.egress) || (status && status.egressConnections) || 0,
      bundles: (machine && machine.bundles) || (status && status.bundleArtifacts) || 0,
    },
    mood: moodKey,
    face: face.face,
    moodLabel: face.label,
    color: face.color,
    headline,
    cycles: (status && status.cycles) || 0,
    atMs: (status && status.atMs) || 0,
    counts: {
      agents: (status && status.agentProcessCount) || 0,
      egress: (status && status.egressConnections) || 0,
      bundles: (status && status.bundleArtifacts) || 0,
      alerts: (status && status.activeFindings) || 0,
      targets: ((status && status.killTargets) || []).length,
    },
    probeErrors: (status && status.probeErrors) || [],
    lastEvents: notifiable.slice(-5).reverse(),
    endpoint: (readEndpoint(dir) || {}).endpoint || null,
  }
}

/** 一行文字版（CLI --pet-status 与测试用；不依赖 PowerShell）。 */
export function petStatusText(dataDir, opts = {}) {
  const s = readPetState(dataDir, opts)
  const c = s.counts
  const lines = [
    `${s.face}  ${s.headline}`,
    `状态 ${s.mood}（${s.moodLabel}）· 第 ${s.cycles} 轮 · 采样 ${s.atMs ? new Date(s.atMs).toLocaleTimeString() : '—'}`,
  ]
  if (s.scoped) {
    lines.push(
      `本 agent【${s.client}】进程 ${s.mine.procs} · 外发 ${s.mine.egress} · 打包 ${s.mine.bundles} · 告警 ${s.mine.alerts}（高危 ${s.mine.critical}）· 目标 ${s.mine.targets}`,
    )
    lines.push(
      `全机：进程 ${s.machine.processes} · 外发 ${s.machine.egress} · 打包 ${s.machine.bundles} · 未归属告警 ${s.unattributed.alerts}`,
    )
  } else {
    lines.push(`⚠ 宿主还没写按 agent 归属的数据，当前是全机视图`)
    lines.push(`全机：agent 进程 ${c.agents} · 外发连接 ${c.egress} · 打包产物 ${c.bundles} · 活跃告警 ${c.alerts} · 候选目标 ${c.targets}`)
  }
  if (s.probeErrors.length) lines.push(`⚠ 探针降级：${s.probeErrors.join('；')}`)
  if (s.lastEvents.length) {
    lines.push('最近事件：')
    for (const e of s.lastEvents) lines.push(`  [${String(e.severity || 'info').toUpperCase()}] ${e.title || e.ruleId}`)
  }
  lines.push(`dataDir: ${s.dataDir}`)
  return lines.join('\n')
}

function readLock(dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, PET_LOCK), 'utf8'))
    return j && Number.isFinite(j.pid) ? j : null
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/** 找 PowerShell（pwsh 优先）。 */
export function findPowerShellForPet() {
  // 不做探测性调用（沙箱里可能被拒），只按常见路径/命令名交给 spawn 去试
  return process.platform === 'win32' ? 'powershell.exe' : null
}

/** 选桌宠窗口脚本：vendor 程序集在 → WebView2 一体窗（pet2，自身带运行时兜底）；否则旧脚本。 */
function pickPetScript() {
  return existsSync(PET2_SCRIPT) && existsSync(join(HERE, '..', 'vendor', 'webview2', 'Microsoft.Web.WebView2.WinForms.dll'))
    ? PET2_SCRIPT
    : PET_SCRIPT
}

/**
 * 拉起桌宠窗口。**全机单只**：不管哪个客户端调用，已有一只在跑就跳过；
 * 在跑的是旧版文本宠而本机能跑 pet2 时，把旧宠替换升级成 pet2（要有看板页）。
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.client]  客户端标识（zcode/dsh/claude/cursor/mcp/manual…），默认自动识别；只用于日志与锁记录
 * @param {string} [opts.reason]  调用来源说明，写进锁文件便于排查
 * @param {(cmd:string,args:string[],options:object)=>any} [opts.spawnImpl] 测试注入
 * @param {boolean} [opts.force]  先关掉现有的再重新拉一只
 * @returns {{ok:boolean, skipped?:boolean, pid?:number, client?:string, message:string}}
 */
export function launchPet(opts = {}) {
  const dataDir = opts.dataDir || resolveDataDir()
  const client = opts.client || detectClient()
  // 采样守护：桌宠活着就得有新鲜数据 —— DSH 不在时它就是唯一采样者（问题②的解）。
  // 测试注入 spawnImpl 时不拉起（无测试副作用）；DESKPET_GUARD_NO_SAMPLER 可显式关闭。
  if (!opts.spawnImpl && opts.ensureSampler !== false && process.env.DESKPET_GUARD_NO_SAMPLER !== '1') {
    try {
      const r = ensureSampler({ dataDir, intervalMs: opts.intervalMs })
      if (r.ok && !r.skipped) {
        try {
          mkdirSync(dataDir, { recursive: true })
          writeFileSync(join(dataDir, LOG_NAME), '[' + new Date().toISOString() + '] ensureSampler: ' + r.message + '\n', { flag: 'a' })
        } catch {
          /* 日志写不了不致命 */
        }
      }
    } catch {
      /* 守护拉不起来不致命（DSH 在时它自己会采样） */
    }
  }
  if (process.platform !== 'win32') {
    return { ok: false, client, message: '桌宠窗口目前只有 Windows 实现（其它平台不做假成功）' }
  }
  if (!existsSync(PET_SCRIPT)) {
    return { ok: false, client, message: '找不到桌宠脚本: ' + PET_SCRIPT }
  }
  const lockFile = join(dataDir, PET_LOCK)
  // 清理旧版本遗留的 per-client 锁（0.4 及之前每客户端一只的方案留下的）
  for (const c of PET_CLIENTS) {
    try {
      rmSync(join(dataDir, legacyLockName(c)), { force: true })
    } catch {
      /* ignore */
    }
  }
  // 先按**进程**找当前桌宠（锁可能丢）：全机一只，不分客户端。
  //   · 在跑的是 pet2（或本机只能跑旧版）→ 接管（补写锁），不重复拉起
  //   · 在跑的是旧版文本宠而本机能跑 pet2 → 升级：关掉旧宠，重拉一只带看板页的
  let running = []
  try {
    running = findRunningPets(opts.processTable || queryProcessTable() || [])
  } catch {
    running = []
  }
  const scriptPath = pickPetScript()
  if (opts.force && running.length) {
    for (const p of running) {
      try {
        process.kill(p.pid)
      } catch {
        /* 已经没了 */
      }
    }
    try {
      rmSync(lockFile, { force: true })
    } catch {
      /* ignore */
    }
  } else if (running.length) {
    const keep = running[0]
    if (scriptPath === PET2_SCRIPT && keep.script === 'pet') {
      // 升级替换：旧宠没有看板页（也常是 hook 拉的、压根没锁），关掉后走下面的全新拉起
      for (const p of running) {
        try {
          process.kill(p.pid)
        } catch {
          /* 已经没了 */
        }
      }
      try {
        rmSync(lockFile, { force: true })
      } catch {
        /* ignore */
      }
    } else {
      for (const extra of running.slice(1)) {
        try {
          process.kill(extra.pid)
        } catch {
          /* 已经没了 */
        }
      }
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(lockFile, JSON.stringify({ pid: keep.pid, at: Date.now(), client: keep.client, reason: 'adopted' }))
      } catch {
        /* 锁写不了不致命 */
      }
      return {
        ok: true,
        skipped: true,
        pid: keep.pid,
        client: keep.client,
        message: `桌宠已在运行（pid=${keep.pid}，全机单只）${running.length > 1 ? '，已关掉多余的 ' + (running.length - 1) + ' 只' : ''}`,
      }
    }
  }
  const lock = readLock(dataDir)
  if (lock && lock.pid && alive(lock.pid) && !opts.force) {
    return {
      ok: true,
      skipped: true,
      pid: lock.pid,
      message: `桌宠已在运行（pid=${lock.pid}，全机单只），跳过本次拉起`,
    }
  }
  const ps = findPowerShellForPet()
  // 窗口脚本选择已在去重阶段做过（要区分 pet/pet2 才能决定"升级还是接管"），这里直接用
  const spawnImpl = opts.spawnImpl || spawn
  // 冷启动并发护栏：先用**独占创建**（wx）的"意图锁"占位，pid 写拉起方自己（它此刻必然
  // 活着），拉起成功后改写成桌宠 pid。没有这把锁，两个客户端同时首拉（实测：ZCode 重启
  // 时 hook 与 MCP 同时开火，5ms 内两次 launchPet）会各起一只，"全机一只"就破了。
  let interimLock = false
  const writeInterim = () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), client, reason: 'spawning' }), { flag: 'wx' })
    interimLock = true
  }
  try {
    writeInterim()
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const held = readLock(dataDir)
      if (held && held.pid && alive(held.pid)) {
        // 锁被活进程占着：占位方是旧版文本宠 → 照样升级替换；是 pet2 或别的活进程
        // （多半是另一个正在拉起的拉起方）→ 让位跳过
        let table = []
        try {
          table = opts.processTable || queryProcessTable() || []
        } catch {
          table = []
        }
        const holder = table.find((d) => Number(d.pid) === Number(held.pid))
        const parsed = holder ? parsePetCmdline(holder.cmd) : null
        if (parsed && parsed.script === 'pet' && scriptPath === PET2_SCRIPT) {
          try {
            process.kill(held.pid)
          } catch {
            /* 已经没了 */
          }
          try {
            rmSync(lockFile, { force: true })
          } catch {
            /* ignore */
          }
          try {
            writeInterim()
          } catch {
            /* 占不上就继续：成功后的改写锁会兜住 */
          }
        } else {
          return {
            ok: true,
            skipped: true,
            pid: held.pid,
            message: `桌宠已在运行（pid=${held.pid}，全机单只），跳过本次拉起`,
          }
        }
      } else {
        // 死锁残留（上次拉起半路死了）：清掉重占
        try {
          rmSync(lockFile, { force: true })
        } catch {
          /* ignore */
        }
        try {
          writeInterim()
        } catch {
          /* ignore */
        }
      }
    }
    /* 其余写锁失败不致命：拉起照旧，只是少了并发护栏 */
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    // 把子进程输出落到 pet.log：桌宠是"拉起来就没输出"的 GUI 进程，
    // 它要是起不来（缺字体/被安全策略拦/无交互桌面），只有日志能说明原因。
    let logFd = 'ignore'
    try {
      logFd = openSync(join(dataDir, LOG_NAME), 'a')
    } catch {
      logFd = 'ignore'
    }
    const slot = 0 // 全机一只，不再按客户端摆位
    // 看护对象 = 客户端主进程：它没了桌宠就自己关（要求"客户端退出即关"）。
    // · MCP 路径：process.ppid 就是拉起本 MCP server 的客户端
    // · ZCode hook 路径：壳里的 hook 传 -WatchProcess ZCode（hook 进程自己是短命的，不能当锚）
    let watchPid = Number((opts.watch && opts.watch.pid) || 0) || 0
    let watchProcess = String((opts.watch && opts.watch.process) || '').trim()
    let watchWhy = opts.watch ? '调用方显式指定' : ''
    if (!watchPid && !watchProcess) {
      // 自动解析看护对象：避免把 npx/cmd 这类短命壳当客户端（会导致桌宠秒退）
      let table = []
      try {
        table = queryProcessTable() || []
      } catch {
        table = []
      }
      const t = resolveWatchTarget({ client, selfPid: process.pid, endpoint: readEndpoint(dataDir), processTable: table })
      watchPid = Number(t.pid) || 0
      watchProcess = String(t.process || '')
      watchWhy = t.why
   }
    try {
      const line =
        '[' +
        new Date().toISOString() +
        '] client=' +
        client +
        ' watch=' +
        JSON.stringify({ pid: watchPid, process: watchProcess }) +
        ' why=' +
        watchWhy +
        '\n'
      writeFileSync(join(dataDir, LOG_NAME), line, { flag: 'a' })
    } catch {
      /* 日志写不了不致命 */
    }
    const watchArgs =
      (watchPid > 0 ? `,'-WatchPid','${watchPid}'` : '') + (watchProcess ? `,'-WatchProcess','${watchProcess}'` : '')
    const inner = `Start-Process -WindowStyle Hidden -FilePath '${ps}' -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','${scriptPath}','-DataDir','${dataDir}','-Client','${client}','-Slot','${slot}'${watchArgs}) -PassThru`
    let pid = 0
    if (opts.spawnImpl) {
      // 测试注入：不真的起进程
      const child = spawnImpl(ps, ['-NoProfile', '-Command', inner], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
        windowsHide: true,
      })
      try {
        child.unref?.()
      } catch {
        /* ignore */
      }
      pid = child.pid || 0
    } else {
      const out = execFileSyncQuiet(ps, ['-NoProfile', '-Command', inner + ' | Select-Object -ExpandProperty Id'], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      })
      pid = Number(String(out || '').trim()) || 0
    }

    try {
      writeFileSync(lockFile, JSON.stringify({ pid, at: Date.now(), client, reason: opts.reason || 'manual' }))
    } catch {
      /* 锁写不了不致命 */
    }
    return {
      ok: true,
      pid,
      client,
      message: `桌宠已拉起（pid=${pid}${opts.reason ? '，来自 ' + opts.reason : ''}；全机单只）`,
    }
  } catch (e) {
    // 拉起失败要把意图锁撤掉，否则占位 pid（拉起方自己）活着会让后续拉起永远跳过
    if (interimLock) {
      try {
        rmSync(lockFile, { force: true })
      } catch {
        /* ignore */
      }
    }
    return { ok: false, client, message: '拉起桌宠失败: ' + String((e && e.message) || e) }
  }
}

/** execFileSync 包装：某些受限沙箱禁止用管道抓子进程输出，失败时返回已拿到的 stdout。 */
function execFileSyncQuiet(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, opts)
  } catch (e) {
    return (e && e.stdout) || ''
  }
}

/**
 * 关掉桌宠并清锁。全机单只之后没有"哪只"之分：无论 client 传什么，关的都是当前这一只
 * （历史遗留的 per-client 锁也顺带清掉；孤儿桌宠没有锁，靠进程发现兜底）。
 */
export function stopPet(dataDir, client, opts = {}) {
  const dir = dataDir || resolveDataDir()
  const closed = []
  const found = listPetLocks(dir, opts)
  for (const item of found) {
    const wasAlive = alive(item.pid)
    try {
      process.kill(item.pid)
    } catch {
      /* 已经没了 */
    }
    if (item.lock) {
      try {
        rmSync(join(dir, item.lock), { force: true })
      } catch {
        /* ignore */
      }
    }
    // 已死掉的实例也要计入：锁被清掉才算处理完，否则残留锁会挡住下次拉起
    closed.push(`${item.client}(pid=${item.pid}${wasAlive ? '' : '，已不在'})`)
  }
  // 没被上面覆盖到的残留锁（含解析不出 pid 的）也一并清掉
  try {
    rmSync(join(dir, PET_LOCK), { force: true })
  } catch {
    /* ignore */
  }
  for (const c of PET_CLIENTS) {
    try {
      rmSync(join(dir, legacyLockName(c)), { force: true })
    } catch {
      /* ignore */
    }
  }
  return {
    ok: true,
    closed,
    message: closed.length ? '已请求关闭桌宠：' + closed.join('、') : '没有记录在案的桌宠实例',
  }
}

/** 列出当前桌宠实例（全局锁 + 历史遗留锁 + 进程发现；用于 --list / --stop）。 */
export function listPetLocks(dataDir, opts = {}) {
  const dir = dataDir || resolveDataDir()
  const out = []
  const seenPid = new Set()
  const global = readLock(dir)
  if (global && global.pid) {
    out.push({ client: 'global', pid: global.pid, alive: alive(global.pid), at: global.at, reason: global.reason || 'lock', source: 'lock', lock: PET_LOCK })
    seenPid.add(global.pid)
  }
  // 历史版本的 per-client 锁：残留就报出来（--list 可见、--stop 可清）
  for (const c of PET_CLIENTS) {
    try {
      const j = JSON.parse(readFileSync(join(dir, legacyLockName(c)), 'utf8'))
      if (j && Number.isFinite(j.pid)) {
        out.push({ client: c + '(旧)', pid: j.pid, alive: alive(j.pid), at: j.at, reason: j.reason || 'legacy-lock', source: 'legacy-lock', lock: legacyLockName(c) })
        seenPid.add(j.pid)
      }
    } catch {
      /* 没有这个锁，正常 */
    }
  }
  // 再按进程发现一遍：锁丢了也要能看见、能管（真实踩过"孤儿桌宠"）
  let running = []
  try {
    running = findRunningPets(opts.processTable || queryProcessTable() || [])
  } catch {
    running = []
  }
  for (const p of running) {
    if (seenPid.has(p.pid)) continue
    out.push({ client: p.client, pid: p.pid, alive: true, at: 0, reason: 'process', source: 'process' })
    seenPid.add(p.pid)
  }
  return out
}
