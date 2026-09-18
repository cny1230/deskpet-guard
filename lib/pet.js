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

const HERE = dirname(fileURLToPath(import.meta.url))
const PET_SCRIPT = join(HERE, '..', 'bin', 'deskpet-guard-pet.ps1')
const LOG_NAME = 'pet.log'

/**
 * 桌宠按**客户端**各一只（要求：DSH 开着、ZCode 也开着 → 各自都有）。
 * 数组顺序同时决定窗口摆放（0 最靠右，依次往左排），免得两只叠在一起看不出来。
 */
export const PET_CLIENTS = ['zcode', 'claude', 'cursor', 'dsh', 'mcp', 'manual']
const lockNameOf = (client) => `pet-${client}.lock`
export const slotOf = (client) => {
  const i = PET_CLIENTS.indexOf(client)
  return i >= 0 ? i : PET_CLIENTS.length
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
  const EMPTY = { alerts: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, targets: 0, findings: [] }
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
      `本客户端【${s.client}】告警 ${s.mine.alerts}（高危 ${s.mine.critical}）· 候选目标 ${s.mine.targets} · 未归属 ${s.unattributed.alerts}`,
    )
    lines.push(`全机：agent 进程 ${c.agents} · 外发连接 ${c.egress} · 打包产物 ${c.bundles}`)
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

function readLock(dataDir, client) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, lockNameOf(client)), 'utf8'))
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

/**
 * 拉起桌宠窗口。**按客户端各一只**：同一个客户端重复调用会跳过，不同客户端各开一只。
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.client]  客户端标识（zcode/dsh/claude/cursor/mcp/manual…），默认自动识别
 * @param {string} [opts.reason]  调用来源说明，写进锁文件便于排查
 * @param {(cmd:string,args:string[],options:object)=>any} [opts.spawnImpl] 测试注入
 * @param {boolean} [opts.force]
 * @returns {{ok:boolean, skipped?:boolean, pid?:number, client?:string, message:string}}
 */
export function launchPet(opts = {}) {
  const dataDir = opts.dataDir || resolveDataDir()
  const client = opts.client || detectClient()
  if (process.platform !== 'win32') {
    return { ok: false, client, message: '桌宠窗口目前只有 Windows 实现（其它平台不做假成功）' }
  }
  if (!existsSync(PET_SCRIPT)) {
    return { ok: false, client, message: '找不到桌宠脚本: ' + PET_SCRIPT }
  }
  const lockFile = join(dataDir, lockNameOf(client))
  const lock = readLock(dataDir, client)
  if (lock && lock.pid && alive(lock.pid) && !opts.force) {
    return {
      ok: true,
      skipped: true,
      pid: lock.pid,
      client,
      message: `${client} 的桌宠已在运行（pid=${lock.pid}），跳过本次拉起`,
    }
  }
  const ps = findPowerShellForPet()
  const spawnImpl = opts.spawnImpl || spawn
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
    const slot = slotOf(client)
    // 看护对象 = 客户端主进程：它没了桌宠就自己关（要求"客户端退出即关"）。
    // · MCP 路径：process.ppid 就是拉起本 MCP server 的客户端
    // · ZCode hook 路径：壳里的 hook 传 -WatchProcess ZCode（hook 进程自己是短命的，不能当锚）
    const watchPid = Number((opts.watch && opts.watch.pid) || 0) || 0
    const watchProcess = String((opts.watch && opts.watch.process) || '').trim()
    const watchArgs =
      (watchPid > 0 ? `,'-WatchPid','${watchPid}'` : '') + (watchProcess ? `,'-WatchProcess','${watchProcess}'` : '')
    const inner = `Start-Process -WindowStyle Hidden -FilePath '${ps}' -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','${PET_SCRIPT}','-DataDir','${dataDir}','-Client','${client}','-Slot','${slot}'${watchArgs}) -PassThru`
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
      message: `${client} 的桌宠已拉起（pid=${pid}${opts.reason ? '，来自 ' + opts.reason : ''}）`,
    }
  } catch (e) {
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
 * 关掉桌宠并清锁。
 * @param {string} [dataDir]
 * @param {string} [client] 指定客户端；传 'all' 关掉所有客户端的桌宠；缺省 = 自动识别到的那个
 */
export function stopPet(dataDir, client) {
  const dir = dataDir || resolveDataDir()
  const targets = client === 'all' ? listPetLocks(dir).map((x) => x.client) : [client || detectClient()]
  const closed = []
  for (const c of targets) {
    const lock = readLock(dir, c)
    if (lock && lock.pid) {
      const wasAlive = alive(lock.pid)
      try {
        process.kill(lock.pid)
      } catch {
        /* 已经没了 */
      }
      // 已死掉的实例也要计入：锁被清掉才算处理完，否则残留锁会挡住下次拉起
      closed.push(`${c}(pid=${lock.pid}${wasAlive ? '' : '，已不在'})`)
    }
    try {
      rmSync(join(dir, lockNameOf(c)), { force: true })
    } catch {
      /* ignore */
    }
  }
  return {
    ok: true,
    closed,
    message: closed.length ? `已请求关闭桌宠：${closed.join('、')}` : '没有记录在案的桌宠实例',
  }
}

/** 列出当前有锁的桌宠实例（用于 --list / --stop all）。 */
export function listPetLocks(dataDir) {
  const dir = dataDir || resolveDataDir()
  const out = []
  for (const c of PET_CLIENTS) {
    const lock = readLock(dir, c)
    if (lock && lock.pid) out.push({ client: c, pid: lock.pid, alive: alive(lock.pid), at: lock.at, reason: lock.reason })
  }
  return out
}
