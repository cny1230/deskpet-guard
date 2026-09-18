/**
 * deskpet-guard — 核心库（可脱离 DSH 独立运行）。
 *
 * 三种用法：
 *   1) 独立 CLI：  node lib/index.js --scan [--json] / --events N
 *   2) 库调用：    import { scan, readEvents, confirmPlan } from '.../lib/index.js'
 *   3) DSH 插件：  apply(ctx, config) —— 注入后自动周期采样 + 注册 host 工具
 *                  + 挂载本地 HTTP API（GUI 面板与 MCP 桥的数据面）
 *
 * 安全边界（务必保持）：
 *   · scan() 只读；
 *   · kill 只能由 prepareKill() 生成"待确认计划"，再由 killByPids() 执行，
 *     且 killByPids 必须显式传入 confirmToken（由调用方在拿到 plan 后回传）；
 *   · 本文件不写被监控 agent 的任何目录；
 *   · HTTP 变更端点有独立的同源 + 自定义头 + secret 三重闸门（见 lib/api.js）。
 *
 * ⚠️ 本文件是**手写运行时产物**（零依赖、离线可跑），不要被 tsc 编译产物覆盖：
 *    tsconfig outDir=build、scripts/build.sh 有硬守卫，原因见 src/daemon/index.ts 顶部记录。
 */

import { homedir } from 'node:os'
import { mergeProfiles } from './profiles.js'
import { evaluate, moodOf, DEFAULT_RULE_OPTIONS } from './rules.js'
import { probe, findPowerShell } from './probe.js'
import {
  appendEvents,
  readEvents,
  writeStatus,
  readStatus,
  writeEndpoint,
  readEndpoint,
  fingerprint,
  resolveDataDir,
  ensureConfirmSecret,
  secretEquals,
} from './events.js'
import { createApi, API_BASE, ALL_PREFIXES } from './api.js'
import { attributeScan, buildPidResolver } from './agentid.js'
import { launchPet } from './pet.js'
import { defineGuardTool, registerTool } from './toolkit.js'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件版本（与 package.json 同步；MCP/API 都对外报这个）。 */
export const VERSION = '0.2.7'

let SEQ = 0

/**
 * 采一次并判定（纯读）。
 * @param {object} [opts]
 * @param {Array}  [opts.profiles]  已展开的 profile 列表
 * @param {string} [opts.home]
 * @param {object} [opts.ruleOptions]
 */
export function scan(opts = {}) {
  const home = opts.home || homedir()
  const profiles = opts.profiles || mergeProfiles(opts.customProfiles, home)
  const probeResult = probe(profiles, { home, ps: opts.ps })
  const findings = evaluate(probeResult, profiles, opts.ruleOptions || DEFAULT_RULE_OPTIONS)
  const mood = moodOf(findings)
  const result = { probe: probeResult, findings, mood, profiles }
  // 候选处置目标随扫描结果一起给出，面板/MCP 才有可选项（不签 token，不执行）
  result.killTargets = confirmPlan(result).targets
  return result
}

/** 把 findings 落成事件（带去重指纹，避免同一现象每轮刷屏）。 */
export function record(dataDir, findings, seenFingerprints) {
  const now = Date.now()
  const fresh = []
  for (const f of findings) {
    // info 级不落库，避免事件流被 R6/R5 噪音淹没
    if (f.severity === 'info') continue
    const fp = fingerprint(f)
    if (seenFingerprints && seenFingerprints.has(fp)) continue
    if (seenFingerprints) seenFingerprints.add(fp)
    fresh.push({ ...f, seq: ++SEQ, atMs: now, fingerprint: fp })
  }
  appendEvents(dataDir, fresh)
  return fresh
}

/**
 * 生成"终止建议计划"（不执行）。
 * 只对 critical 且 suggest==='kill' 的发现给出候选目标。
 *
 * 处置粒度：**逐个确认** —— 一次确认只终止一个目标。
 * 理由：多 agent 同时命中时，一次性全杀会误伤用户正在使用的那个 agent。
 * targets 仍返回全部候选，供面板逐个展示；执行时必须指定 targetPid。
 */
export function confirmPlan(scanResult) {
  const targets = new Map()
  for (const f of scanResult.findings) {
    if (f.severity !== 'critical') continue
    if (f.suggest !== 'kill') continue
    const pid = Number(f.evidence.pid)
    if (!pid) continue
    targets.set(pid, {
      pid,
      process: f.evidence.process,
      reason: f.title,
      remote: f.evidence.remote,
    })
  }
  const list = [...targets.values()]
  return {
    requiresConfirmation: true,
    /** 处置策略：一次一个，逐个人工确认。 */
    policy: 'one-target-per-confirmation',
    action: 'kill',
    targets: list,
    targetCount: list.length,
    command: list.length
      ? 'Stop-Process -Id <选中的单个 pid> -Force'
      : '(无目标)',
    warning:
      '终止 agent 进程可能中断你正在进行的会话或损坏未保存的编辑内容。' +
      '一次确认只终止一个目标；请确认进程确实是你想停掉的那个。',
    /** 调用方须把此 token 原样回传，否则 killByPids 拒绝执行。 */
    confirmToken: null,
  }
}

/** 待确认计划：一 token 一 target，用完即销毁。 */
const PENDING_PLANS = new Map()

/**
 * 第一步：为**单个**目标签发 confirmToken（不执行任何动作）。
 * @param {string} dataDir
 * @param {object} scanResult
 * @param {{targetPid?: number}} [opts] 不传 targetPid 时取 targets[0]
 */
export function prepareKill(dataDir, scanResult, opts = {}) {
  const plan = confirmPlan(scanResult)
  if (plan.targets.length === 0) return plan

  let target = null
  if (opts.targetPid) {
    target = plan.targets.find((t) => Number(t.pid) === Number(opts.targetPid)) || null
    if (!target) {
      return { ...plan, error: '指定的 targetPid 不在候选目标中' }
    }
  } else {
    target = plan.targets[0]
    plan.note =
      plan.targets.length > 1
        ? `共 ${plan.targets.length} 个候选，本次仅针对第一个；其余需再次确认。`
        : '仅一个候选目标。'
  }

  const token =
    'kill-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16)
  PENDING_PLANS.set(token, { pid: Number(target.pid), atMs: Date.now() })
  plan.confirmToken = token
  plan.confirmTarget = target
  return plan
}

/** 测试与运维用：当前待确认数量。 */
export function pendingConfirmations() {
  return PENDING_PLANS.size
}

/**
 * 第二步：执行终止**一个**进程。必须带正确 token，10 分钟过期，一次性。
 * @returns {{ok:boolean, killed?:number[], error?:string}}
 */
export function killByPids(dataDir, token, opts = {}) {
  const secret = ensureConfirmSecret(dataDir)
  if (opts.secret) {
    if (!secretEquals(opts.secret, secret)) return { ok: false, error: 'secret 不匹配' }
  }
  const pending = PENDING_PLANS.get(String(token))
  if (!pending) return { ok: false, error: 'confirmToken 不匹配或已被使用' }
  if (Date.now() - pending.atMs > 10 * 60 * 1000) {
    PENDING_PLANS.delete(String(token))
    return { ok: false, error: '确认已过期（超过 10 分钟），请重新扫描' }
  }
  // 一次性：无论成败都先作废 token，避免重放
  PENDING_PLANS.delete(String(token))
  const pids = [pending.pid]
  const executed = opts.exec
    ? opts.exec(pids)
    : (() => {
        if (process.platform !== 'win32') return { ok: false, error: '非 Windows，未执行' }
        try {
          execFileSync(
            findPowerShell() || 'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Stop-Process -Id ' + pids.join(',') + ' -Force'],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
          )
          return { ok: true }
        } catch (e) {
          return { ok: false, error: String(e.message || e).slice(0, 200) }
        }
      })()
  // token 已在前面一次性作废（PENDING_PLANS.delete），此处无需再清理全局态
  return { ok: executed.ok === true, killed: executed.ok ? pids : [], error: executed.error, target: pids[0] }
}

/** 供 CLI 与测试使用的默认路径。 */
export const paths = {
  resolveDataDir,
  readEvents,
  readStatus,
  writeStatus,
  writeEndpoint,
  readEndpoint,
}

// ────────────────────────────────────────────────────────────
// DSH 插件接入（Cordis）。服务缺失时只降级、不抛错。
// ────────────────────────────────────────────────────────────
export const name = 'deskpet-guard'
export const inject = ['timer']

/** 采集 + 落库 + 写状态（一处集中，tick 与 /scan 共用）。 */
function sampleOnce(scanImpl, dataDir, profiles, seen, cycles) {
  const r = scanImpl({ profiles })
  const fresh = record(dataDir, r.findings, seen)
  // 按 agent 归属：让每只桌宠只盯自己那家（判不出来的一律进 unknown，不硬塞）
  const attribution = attributeScan(
    { findings: r.findings, killTargets: r.killTargets },
    {
      resolvePid: buildPidResolver(r.probe.procDetails),
      procDetails: r.probe.procDetails,
      connections: r.probe.connections,
      bundles: r.probe.bundles,
    },
  )
  const status = {
    atMs: r.probe.atMs,
    cycles,
    mood: r.mood.mood,
    headline: r.mood.headline,
    worstSeverity: r.mood.worstSeverity,
    activeFindings: r.findings.filter((f) => f.severity !== 'info').length,
    newEvents: fresh.length,
    probeErrors: r.probe.probeErrors,
    agentProcessCount: r.probe.processes.length,
    egressConnections: r.probe.connections.length,
    bundleArtifacts: r.probe.bundles.length,
    /** 按 agent 拆开的告警/目标；键是 agent id（zcode/dsh/claude…），认不出的进 unknown */
    perAgent: attribution.perAgent,
    /** 全机计数：每只桌宠看到的都一样，界面上必须标注成全机，不能混进自己那行 */
    machine: {
      processes: r.probe.processes.length,
      egress: r.probe.connections.length,
      bundles: r.probe.bundles.length,
    },
    /** 候选处置目标（PID + 原因），面板/MCP 据此发起两步确认 */
    killTargets: r.killTargets,
    apiBase: API_BASE,
  }
  writeStatus(dataDir, status)
  return { r, status, fresh, attribution }
}

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config.dataDir)
  const intervalMs = Math.max(5000, Number(config.intervalMs) || 15000)
  const profiles = mergeProfiles(config.profiles, homedir())
  const seen = new Set()
  const state = { cycles: 0, lastScan: null, lastStatus: null, startedAtMs: Date.now() }

  // 两个显式接缝（都有生产用途，不是只为测试）：
  //  · config.scan      替换采样实现 —— 嵌入式集成/离线复算/单测（默认走真实只读探针）
  //  · config.killMode  'execute'(默认) | 'audit' —— audit 下终止动作一律拒绝，
  //                     给"只要预警、绝不动手"的部署留一条明确的路
  const scanImpl = typeof config.scan === 'function' ? config.scan : scan
  const auditOnly = config.killMode === 'audit'
  const killOpts = auditOnly
    ? { exec: () => ({ ok: false, error: 'audit 模式：已按配置拒绝执行终止（仅预警）' }) }
    : {}

  const log = (level, msg) => {
    try {
      const fn = ctx.logger?.[level]
      if (typeof fn === 'function') fn.call(ctx.logger, '[deskpet-guard] ' + msg)
    } catch {
      /* 日志失败不拖垮守护 */
    }
  }

  const tick = () => {
    // DSH 自己的桌宠：看护对象就是本进程 —— 宿主退出 → 桌宠自己关。
    // 想只用 GUI 内那只（不弹桌面窗口）就设 config.desktopPet: false。
    if (config.desktopPet !== false && !state.petLaunched) {
      state.petLaunched = true
      try {
        const pr = launchPet({ dataDir, client: 'dsh', reason: 'dsh-host', watch: { pid: process.pid } })
        if (!pr.ok) log('warn', '桌宠未拉起: ' + pr.message)
      } catch (e) {
        log('warn', '桌宠拉起异常: ' + String(e && e.message))
      }
    }
    state.cycles += 1
    try {
      const { r, status } = sampleOnce(scanImpl, dataDir, profiles, seen, state.cycles)
      state.lastScan = r
      state.lastStatus = status
      if (r.mood.mood === 'panic') {
        log('warn', '高危: ' + r.mood.headline + '（详见 guard-events.jsonl）')
      }
    } catch (e) {
      log('warn', '采样失败: ' + String(e).slice(0, 160))
    }
  }

  tick()
  // 防御：某些嵌入式宿主可能没挂 timer（虽然 inject 已声明）。缺了就只采一次，
  // 绝不因为一个服务缺失把宿主的 apply 链路炸掉。
  if (typeof ctx.setInterval === 'function') {
    try {
      ctx.setInterval(tick, intervalMs)
    } catch (e) {
      log('warn', '定时器挂载失败（降级为单次采样）: ' + String(e).slice(0, 120))
    }
  } else {
    log('warn', '宿主未提供 setInterval（降级为单次采样）')
  }

  const freshScan = () => {
    const { r } = sampleOnce(scanImpl, dataDir, profiles, seen, state.cycles)
    state.lastScan = r
    return r
  }

  // ── host 工具（ctx.effect 包裹 → 卸载时随 fiber 回收，避免僵尸工具）──
  const tools = [
    defineGuardTool({
      name: 'guard_status',
      description:
        '查看 deskpet-guard 的当前守护状态：agent 进程数、外发连接数、打包产物数、探针健康度、最坏告警等级与候选处置目标。',
      parameters: {},
      schema: { type: 'object' },
      execute: () => {
        const st = readStatus(dataDir)
        return st || { note: '尚无采样结果（守护刚启动）', dataDir, apiBase: API_BASE }
      },
    }),
    defineGuardTool({
      name: 'guard_events',
      description:
        '读取最近的可疑外传事件（只追加 jsonl）。用于跨 agent 审计与自查。',
      parameters: { limit: { type: 'number', description: '条数，默认 20，上限 500' } },
      schema: { type: 'array' },
      execute: (args) => readEvents(dataDir, clampLimit(args?.limit, 20)),
    }),
    defineGuardTool({
      name: 'guard_scan',
      description:
        '立刻重新采样一次（不等下一个周期），返回当前 mood、findings 与候选处置目标。只读，不落盘事件。',
      parameters: {},
      schema: { type: 'object' },
      execute: () => {
        const r = freshScan()
        return {
          mood: r.mood,
          findings: r.findings,
          targets: r.killTargets,
          probeErrors: r.probe.probeErrors,
          counts: {
            processes: r.probe.processes.length,
            connections: r.probe.connections.length,
            bundles: r.probe.bundles.length,
          },
        }
      },
    }),
    defineGuardTool({
      name: 'guard_prepare_kill',
      description:
        '在发现 critical 外传行为后，为**单个**目标生成"终止进程"的待确认计划（不执行），返回需人工确认的 confirmToken。处置策略为逐个确认，一次只针对一个目标。',
      parameters: {
        targetPid: {
          type: 'number',
          description: '要终止的目标进程 pid（来自 guard_status 的 killTargets 候选列表）',
        },
      },
      schema: { type: 'object' },
      execute: (args) =>
        prepareKill(dataDir, freshScan(), {
          targetPid: args?.targetPid ? Number(args.targetPid) : undefined,
        }),
    }),
    defineGuardTool({
      name: 'guard_confirm_kill',
      description:
        '执行终止：必须带上 guard_prepare_kill 返回的 confirmToken。仅供用户在明确知道后果时调用。',
      parameters: { confirmToken: { type: 'string', required: true, description: 'prepare 返回的 token' } },
      schema: { type: 'object' },
      execute: (args) => killByPids(dataDir, String(args?.confirmToken || ''), killOpts),
    }),
  ]

  let registered = 0
  for (const tool of tools) {
    const res = registerTool(ctx, tool)
    if (res.ok) registered += 1
    else log('warn', '工具注册失败 ' + tool.name + '（降级继续）: ' + res.error)
  }
  // 兼容老会话：不声明 inject=['tools'] 的宿主里，上面会全部失败 → 明确说清
  if (registered === 0) {
    log('warn', '没有任何 host 工具注册成功：当前进程的 tools 服务不可用（CLI/HTTP API 仍可用）')
  }

  // ── 本地 HTTP API（面板 + MCP 桥的数据面）──
  const apiOk = registerHttpApi(ctx, { dataDir, state, log, freshScan, killOpts, auditOnly })

  log(
    'info',
    '守护启动 interval=' + intervalMs + 'ms dataDir=' + dataDir +
      ' profiles=' + profiles.map((p) => p.id).join(',') +
      ' tools=' + registered + '/' + tools.length +
      ' http=' + (apiOk ? API_BASE : 'disabled'),
  )
}

// ────────────────────────────────────────────────────────────
// HTTP API 挂载（webServer 服务；缺失时静默降级）
// ────────────────────────────────────────────────────────────
function resolveService(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const svc = ctx.get(key)
      if (svc) return svc
    }
  } catch {
    /* 继续用属性兜底 */
  }
  return ctx[key]
}

function detectEndpoint(ctx) {
  const env = process.env.DESKPET_GUARD_ENDPOINT
  if (env) return String(env).replace(/\/+$/, '')
  try {
    const ws = resolveService(ctx, 'webServer')
    const addr =
      ws?.server?.address?.() ?? ws?.address?.() ?? null
    const port = ws?.port ?? (addr && typeof addr === 'object' ? addr.port : null)
    if (port) return 'http://127.0.0.1:' + port
  } catch {
    /* 探测不到就用默认值 */
  }
  const p = Number(process.env.DSH_PORT || process.env.PORT)
  if (Number.isFinite(p) && p > 0) return 'http://127.0.0.1:' + p
  return 'http://127.0.0.1:3080'
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new Error('body 过大（>' + max + ' bytes）'))
        try {
          req.destroy?.()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (e) => reject(e))
  })
}

function registerHttpApi(ctx, { dataDir, state, log, freshScan, killOpts, auditOnly }) {
  const webServer = resolveService(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    log('warn', 'webServer 服务不可用：面板/MCP 读不到实时状态（host 工具与 CLI 不受影响）')
    return false
  }

  const endpoint = detectEndpoint(ctx)
  writeEndpoint(dataDir, { endpoint, apiBase: API_BASE, aliases: ALL_PREFIXES, pid: process.pid })

  const api = createApi({
    dataDir,
    version: VERSION,
    mode: auditOnly ? 'audit' : 'execute',
    secret: () => ensureConfirmSecret(dataDir),
    secretEquals,
    readStatus: () => readStatus(dataDir),
    readEvents: (limit) => readEvents(dataDir, limit),
    scan: () => freshScan(),
    prepareKill: (targetPid) => prepareKill(dataDir, freshScan(), { targetPid }),
    confirmKill: (token) => killByPids(dataDir, token, killOpts),
    log: (msg) => log('info', msg),
  })

  const handler = async (req, res) => {
    const send = (status, headers, body) => {
      try {
        res.writeHead(status, headers)
        res.end(JSON.stringify(body))
      } catch (e) {
        log('warn', 'API 回包失败: ' + String(e).slice(0, 120))
      }
    }
    let body
    try {
      body = req.method === 'POST' ? await readBody(req, api.MAX_BODY) : undefined
    } catch (e) {
      return send(413, { 'content-type': 'application/json; charset=utf-8' }, {
        ok: false,
        error: String(e?.message || e),
      })
    }
    const out = api.dispatch({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
    })
    send(out.status, out.headers, out.body)
  }

  const mount = () => {
    // 主前缀 + 别名前缀都挂上：面板用短名，早期文案用过带 scope 的写法
    for (const prefix of ALL_PREFIXES) {
      webServer.register({ kind: 'prefix', path: prefix, handler })
    }
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(mount, 'deskpet-guard: http api')
    } else {
      mount()
    }
    return true
  } catch (e) {
    log('warn', 'HTTP API 挂载失败（降级为无面板数据面）: ' + String(e).slice(0, 160))
    return false
  }
}

function clampLimit(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 500)
}

// ────────────────────────────────────────────────────────────
// CLI：node lib/index.js [--scan] [--json] [--events N] [--endpoint]
// ────────────────────────────────────────────────────────────
// 精确判断"自己是不是主模块"：不要用 endsWith('index.js') —— 任何叫 index.js 的
// 入口 import 本模块都会误触发 CLI（lib/mcp.js 那边踩过同类坑，见其注释）。
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const dataDir = resolveDataDir()
  if (argv.includes('--events')) {
    const i = argv.indexOf('--events')
    const n = Number(argv[i + 1]) || 20
    console.log(JSON.stringify(readEvents(dataDir, n), null, 2))
  } else if (argv.includes('--endpoint')) {
    console.log(JSON.stringify(readEndpoint(dataDir) || { note: '尚无端点记录（守护未在 DSH 内运行过）', dataDir }, null, 2))
  } else if (argv.includes('--status')) {
    console.log(JSON.stringify(readStatus(dataDir) || { note: '尚无采样结果', dataDir }, null, 2))
  } else {
    const r = scan({})
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ mood: r.mood, findings: r.findings, targets: r.killTargets }, null, 2))
    } else {
      console.log('=== deskpet-guard 采样 ' + new Date(r.probe.atMs).toLocaleString() + ' ===')
      console.log('状态: ' + r.mood.mood + ' — ' + r.mood.headline)
      console.log(
        '进程 ' + r.probe.processes.length + ' / 外发连接 ' + r.probe.connections.length +
          ' / 打包产物 ' + r.probe.bundles.length,
      )
      if (r.probe.probeErrors.length) console.log('探针异常: ' + r.probe.probeErrors.join('; '))
      for (const f of r.findings) {
        if (f.severity === 'info') continue
        console.log(`  [${f.severity}] ${f.ruleId} ${f.title}`)
        console.log('        ' + JSON.stringify(f.evidence))
      }
      if (r.killTargets.length) {
        console.log('候选处置目标（需两步确认，一次一个）:')
        for (const t of r.killTargets) {
          console.log(`  pid=${t.pid} ${t.process} ← ${t.reason}${t.remote ? ' / ' + t.remote : ''}`)
        }
      }
    }
  }
}
