/**
 * deskpet-guard — 规则引擎（纯函数，无副作用，可离线单测）。
 *
 * 契约：evaluate(probe, profiles, opts) → Findings[]
 *   · 只看入参，不碰系统 → 可用 fixture 测试，也可被其它 agent 通过 MCP 复用；
 *   · 每条 Finding 都带结构化 evidence，便于面板展示与事后审计；
 *   · severity 与 suggest 分离：critical/high 默认建议 alert，kill 仍需两步确认。
 */

import type {
  AgentProfile,
  BundleFile,
  Finding,
  ProbeResult,
  Severity,
} from './types.js'

export interface RuleOptions {
  /** 打包产物"新鲜"窗口：出现在这个时间窗内才算可疑（默认 10 分钟）。 */
  freshBundleMs: number
  /** 敏感文件"刚被读取"窗口（默认 10 分钟）。 */
  freshSecretMs: number
  /** 判定"成簇刷包"的窗口与数量阈值（默认 5 分钟 / 3 个）。 */
  burstWindowMs: number
  burstCount: number
}

export const DEFAULT_RULE_OPTIONS: RuleOptions = {
  freshBundleMs: 10 * 60 * 1000,
  freshSecretMs: 10 * 60 * 1000,
  burstWindowMs: 5 * 60 * 1000,
  burstCount: 3,
}

/** 把 profile 里的正则片段安全编译；非法正则直接跳过（不抛，守护自己不能崩）。 */
function safeRe(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/**
 * 统一正向斜杠后再匹配：Windows 上路径同时存在 `\` 与 `/` 两种写法
 * （实测：state.json 里写 `C:\\Users\\...`，而部分探针返回 `/`），
 * 不做归一化会导致密钥目录这类规则静默失效。
 */
function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, '/')
}

function matchesAny(value: string, patterns: string[]): string | null {
  const v = normalizeSlashes(value)
  for (const p of patterns) {
    const re = safeRe(p)
    if (re && re.test(v)) return p
  }
  return null
}

/** 判断某路径是否落在该 profile 的任一数据根下（大小写不敏感，统一斜杠）。 */
function underDataRoot(path: string, profile: AgentProfile): boolean {
  const p = normalizeSlashes(path).toLowerCase()
  return profile.dataRoots.some(
    (root) => p.startsWith(normalizeSlashes(root).toLowerCase()),
  )
}

/** 该进程是否属于此 profile。 */
function ownsProcess(procNameOrPath: string, profile: AgentProfile): boolean {
  const re = safeRe(profile.processPattern)
  if (!re) return false
  // 进程名与完整路径都试一次（ZCode.exe / D:\ZCode\ZCode.exe）
  const base = procNameOrPath.replace(/\\/g, '/').split('/').pop() ?? procNameOrPath
  return re.test(base) || re.test(procNameOrPath)
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

/**
 * 主判定。rules 之间相互独立，全部命中都会上报（不做短路），
 * 便于用户看到完整态势而不是第一个症状。
 */
export function evaluate(
  probe: ProbeResult,
  profiles: AgentProfile[],
  opts: RuleOptions = DEFAULT_RULE_OPTIONS,
): Finding[] {
  const out: Finding[] = []
  const now = probe.atMs

  // ── 探针不可用：必须显式上报，否则会造成"看起来安全"的假阴性 ──
  if (probe.platform !== 'win32' || probe.probeErrors.length > 0) {
    out.push({
      ruleId: 'R0-probe-degraded',
      severity: probe.platform === 'win32' ? 'medium' : 'high',
      profileId: '*',
      title:
        probe.platform === 'win32'
          ? '部分探针执行失败，判定能力降级'
          : '当前平台无法采集系统探针，守护处于盲区',
      evidence: {
        platform: probe.platform,
        errors: probe.probeErrors.slice(0, 3).join(' | ') || '(none)',
      },
      suggest: 'alert',
    })
  }

  for (const profile of profiles) {
    const procs = probe.processes.filter((p) =>
      ownsProcess(p.name, profile) || ownsProcess(p.path, profile),
    )
    const pidSet = new Set(procs.map((p) => p.pid))

    // ── R1：agent 进程连向对象存储（最强信号）──
    for (const c of probe.connections) {
      if (!pidSet.has(c.pid)) continue
      const hit = matchesAny(c.remoteAddress, profile.egressHostPatterns)
      if (!hit) continue
      out.push({
        ruleId: 'R1-agent-to-object-storage',
        severity: 'critical',
        profileId: profile.id,
        title: `${profile.label} 正在连接对象存储服务`,
        evidence: {
          pid: c.pid,
          process: c.processName,
          remote: `${c.remoteAddress}:${c.remotePort}`,
          matchedPattern: hit,
        },
        suggest: 'kill',
      })
    }

    // ── R2：打包产物新鲜出现 ──
    const fresh = probe.bundles.filter((b) => now - b.mtimeMs <= opts.freshBundleMs)
    for (const b of fresh) {
      const hit = matchesAny(b.path, profile.bundlePatterns)
      if (!hit) continue
      if (!underDataRoot(b.path, profile)) continue
      out.push({
        ruleId: 'R2-fresh-bundle-artifact',
        severity: 'high',
        profileId: profile.id,
        title: `${profile.label} 刚生成可疑打包产物`,
        evidence: {
          path: b.path,
          bytes: b.bytes,
          sizeHuman: fmtBytes(b.bytes),
          ageMs: now - b.mtimeMs,
          matchedPattern: hit,
        },
        suggest: 'alert',
      })
    }

    // ── R3：包在短时间内成簇出现（打包 → 外传的节奏特征）──
    const windows = probe.bundles
      .filter((b) => now - b.mtimeMs <= opts.burstWindowMs)
      .filter((b) => underDataRoot(b.path, profile))
    if (windows.length >= opts.burstCount) {
      out.push({
        ruleId: 'R3-bundle-burst',
        severity: 'high',
        profileId: profile.id,
        title: `${profile.label} 短时间内连续生成 ${windows.length} 个打包产物`,
        evidence: {
          count: windows.length,
          windowMs: opts.burstWindowMs,
          totalBytes: windows.reduce((s, b) => s + b.bytes, 0),
        },
        suggest: 'alert',
      })
    }

    // ── R4：敏感密钥文件刚被触达 ──
    for (const s of probe.secrets) {
      if (now - s.mtimeMs > opts.freshSecretMs) continue
      const hit = matchesAny(s.path, profile.secretFiles.map((d) => escapeRe(expandDir(d))))
      if (!hit) continue
      out.push({
        ruleId: 'R4-secret-file-touched',
        severity: 'medium',
        profileId: profile.id,
        title: `${profile.label} 的密钥/凭据文件最近被改动或写入`,
        evidence: { path: s.path, bytes: s.bytes, ageMs: now - s.mtimeMs },
        suggest: 'alert',
      })
    }

    // ── R5：DNS 缓存残留对象存储解析 —— 刻意降级为 low，且不作为上传证据 ──
    for (const d of probe.dns) {
      const hit = matchesAny(d.entry, profile.egressHostPatterns)
      if (!hit) continue
      out.push({
        ruleId: 'R5-dns-object-storage-residue',
        severity: 'info',
        profileId: profile.id,
        title: 'DNS 缓存中存在对象存储域名解析记录（线索，非外传证据）',
        evidence: { entry: d.entry, data: d.data, matchedPattern: hit },
        suggest: 'alert',
      })
    }

    // ── R6：agent 进程存在但本次采样无外发连接（用于面板"当前安静"状态）──
    if (procs.length > 0) {
      const agentConns = probe.connections.filter((c) => pidSet.has(c.pid))
      out.push({
        ruleId: 'R6-agent-alive-quiet',
        severity: 'info',
        profileId: profile.id,
        title: `${profile.label} 运行中，当前外发连接 ${agentConns.length} 条`,
        evidence: {
          processCount: procs.length,
          egressConnections: agentConns.length,
        },
        suggest: 'alert',
      })
    }
  }

  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * secretFiles 里允许写目录（表示"该目录下的密钥文件"）。
 * 统一成正向斜杠，避免 `\` 与 `/` 混用导致规则静默失效。
 */
function expandDir(entry: string): string {
  return normalizeSlashes(entry)
}

/** 由 findings 推出桌宠表情/状态等级（面板与 MCP 都用这个口径）。 */
export function moodOf(findings: Finding[]): {
  mood: 'safe' | 'watching' | 'alert' | 'panic'
  headline: string
  worstSeverity: Severity | null
} {
  const order: Severity[] = ['info', 'medium', 'high', 'critical']
  let worst: Severity | null = null
  for (const f of findings) {
    if (!worst || order.indexOf(f.severity) > order.indexOf(worst)) worst = f.severity
  }
  if (worst === 'critical') {
    return { mood: 'panic', headline: '检测到对象存储直连 — 建议立即确认', worstSeverity: worst }
  }
  if (worst === 'high') {
    return { mood: 'alert', headline: '检测到可疑打包/外传迹象', worstSeverity: worst }
  }
  if (worst === 'medium') {
    return { mood: 'alert', headline: '有中等级别异常需要留意', worstSeverity: worst }
  }
  return { mood: 'watching', headline: '守护中，暂无可疑外传', worstSeverity: worst }
}
