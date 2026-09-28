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

function escapeRe(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

/**
 * 路径前缀归属：必须落在分隔符边界上 —— 裸 startsWith 会把
 * `C:\Users\x\.zcode-v2\evil.enc` 认成 `C:\Users\x\.zcode` 数据根下的文件。
 */
function pathUnderPrefix(path: string, prefixes: string[]): boolean {
  const p = normalizeSlashes(path).toLowerCase()
  return prefixes.some((root) => {
    const r = normalizeSlashes(root).toLowerCase().replace(/\/+$/, '')
    if (!r) return false
    return p === r || p.startsWith(r + '/')
  })
}

/** 判断某路径是否落在该 profile 的任一数据根下（大小写不敏感，统一斜杠）。 */
function underDataRoot(path: string, profile: AgentProfile): boolean {
  return pathUnderPrefix(path, profile.dataRoots)
}

/** R7 的归属判定：indexFile 的路径必须落在本画像声明的 indexFiles 前缀下。 */
function underIndexRoot(path: string, profile: AgentProfile): boolean {
  return pathUnderPrefix(path, profile.indexFiles || [])
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

// ────────────────────────────────────────────────────────────
// R1 的网络匹配：Get-NetTCPConnection 的 RemoteAddress 是 IP，
// 而画像里的 egressHostPatterns 是域名正则 —— 直接比对永远匹配不上。
// 两条腿：① DNS 缓存（Entry→Data）把远端 IP 反查成域名再匹配；
//         ② egressHostPatterns 额外支持 IPv4 字面量与 CIDR。
// ────────────────────────────────────────────────────────────

/** DNS 缓存 → Map<ip, Set<hostname>>（大小写归一、去尾点）。 */
export function buildDnsHostIndex(
  dns: Array<{ entry?: string; data?: string }> | undefined,
): Map<string, Set<string>> {
  const byIp = new Map<string, Set<string>>()
  for (const d of dns || []) {
    const ip = String((d && d.data) || '').trim()
    const host = String((d && d.entry) || '').trim().toLowerCase().replace(/\.$/, '')
    if (!ip || !host) continue
    if (!byIp.has(ip)) byIp.set(ip, new Set())
    byIp.get(ip)!.add(host)
  }
  return byIp
}

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim())
  if (!m) return false
  return m.slice(1).every((o) => Number(o) <= 255)
}

function ipv4ToInt(s: string): number {
  const o = String(s).split('.').map(Number)
  return (((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0)
}

/**
 * egressHostPatterns 里的 IP 形态匹配：精确 IPv4 或 CIDR（仅 IPv4；
 * IPv6 靠普通正则即可表达字面量，不做 CIDR 展开）。
 */
export function matchIpPattern(ip: string, patterns: string[]): string | null {
  if (!isIPv4(ip)) return null
  const ipInt = ipv4ToInt(ip)
  for (const raw of patterns || []) {
    const p = String(raw || '').trim()
    const slash = p.indexOf('/')
    if (slash < 0) {
      if (isIPv4(p) && ipv4ToInt(p) === ipInt) return p
      continue
    }
    const net = p.slice(0, slash)
    const bits = Number(p.slice(slash + 1))
    if (!isIPv4(net) || !Number.isInteger(bits) || bits < 0 || bits > 32) continue
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((ipInt & mask) === (ipv4ToInt(net) & mask)) return p
  }
  return null
}

/**
 * R1 单条连接的完整判定：远端 IP 直配（正则/CIDR）→ DNS 反查出的域名逐个配。
 * 返回 { hit, via }；via 是实际命中匹配的字符串（IP 或解析出的域名）。
 */
function matchEgress(
  connection: { remoteAddress: string },
  profile: AgentProfile,
  dnsByIp: Map<string, Set<string>>,
): { hit: string; via: string } | null {
  const ip = String(connection.remoteAddress || '')
  if (!ip) return null
  let hit = matchesAny(ip, profile.egressHostPatterns)
  if (hit) return { hit, via: ip }
  hit = matchIpPattern(ip, profile.egressHostPatterns)
  if (hit) return { hit, via: ip }
  const hosts = dnsByIp.get(ip)
  if (hosts) {
    for (const host of hosts) {
      hit = matchesAny(host, profile.egressHostPatterns)
      if (hit) return { hit, via: host }
    }
  }
  return null
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
  const dnsByIp = buildDnsHostIndex(probe.dns)
  const uploads = probe.uploads || []

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
    // 远端是 IP 时经 DNS 缓存反查成域名再匹配；evidence.resolvedHost 记录实际
    // 命中的域名，供人工复核（CDN 共享 IP 理论上可能串出误报，证据必须带出来）。
    for (const c of probe.connections) {
      if (!pidSet.has(c.pid)) continue
      const m = matchEgress(c, profile, dnsByIp)
      if (!m) continue
      out.push({
        ruleId: 'R1-agent-to-object-storage',
        severity: 'critical',
        profileId: profile.id,
        title: `${profile.label} 正在连接对象存储服务`,
        evidence: {
          pid: c.pid,
          process: c.processName,
          remote: `${c.remoteAddress}:${c.remotePort}`,
          matchedPattern: m.hit,
          resolvedHost: m.via,
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
    const recent = probe.bundles
      .filter((b) => now - b.mtimeMs <= opts.burstWindowMs)
      .filter((b) => underDataRoot(b.path, profile))
    if (recent.length >= opts.burstCount) {
      out.push({
        ruleId: 'R3-bundle-burst',
        severity: 'high',
        profileId: profile.id,
        title: `${profile.label} 短时间内连续生成 ${recent.length} 个打包产物`,
        evidence: {
          count: recent.length,
          windowMs: opts.burstWindowMs,
          totalBytes: recent.reduce((s, b) => s + b.bytes, 0),
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

    // ── R5：DNS 缓存残留对象存储解析 —— 刻意降级为 info，且不作为上传证据 ──
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

    // ── R7：indexFiles 指向的状态文件里出现上传通道标记（uploadPathPatterns）──
    // "已表达上传意图"的静态证据：光有打包产物（R2）可能只是本地快照，
    // state.json 里的 pendingUpload / uploadOssForm 这类标记说明上传链路已被激活。
    for (const u of uploads) {
      if (!underIndexRoot(u.path, profile)) continue
      const hit = matchesAny(u.text || '', profile.uploadPathPatterns || [])
      if (!hit) continue
      out.push({
        ruleId: 'R7-upload-intent-marker',
        severity: 'high',
        profileId: profile.id,
        title: `${profile.label} 的状态文件出现上传通道标记（已表达上传意图）`,
        evidence: {
          path: u.path,
          bytes: u.bytes,
          sizeHuman: fmtBytes(u.bytes),
          matchedPattern: hit,
        },
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

/**
 * secretFiles 里允许写目录（表示"该目录下的密钥文件"）。
 * 统一成正向斜杠，避免 `\` 与 `/` 混用导致规则静默失效。
 */
function expandDir(entry: string): string {
  return normalizeSlashes(entry)
}

/** 由 findings 推出桌宠表情/状态等级（面板与 MCP 都用这个口径）。 */
export function moodOf(findings: Finding[]): {
  mood: 'watching' | 'alert' | 'panic'
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
