/**
 * deskpet-guard — 规则引擎（可运行 JS 版，与 src/guard/rules.ts 同步）。
 *
 * 纯函数：evaluate(probe, profiles, opts) → Finding[]
 * 只看入参、不碰系统 → 可离线单测，也可被其它 agent 通过 MCP 复用。
 */

export const DEFAULT_RULE_OPTIONS = {
  freshBundleMs: 10 * 60 * 1000,
  freshSecretMs: 10 * 60 * 1000,
  burstWindowMs: 5 * 60 * 1000,
  burstCount: 3,
}

function safeRe(pattern) {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/**
 * Windows 上 `\` 与 `/` 混用是常见坑，统一成正斜杠后再匹配。
 * ⚠️ 只碰反斜杠，绝不动点号 —— 早期版本把 `.` 也换掉，导致
 * `oss-cn-beijing.aliyuncs.com` 变成 `oss-cn-beijing/aliyuncs/com`，
 * 直接漏报最关键的 R1（对象存储直连）。此坑由一致性测试捕获。
 */
function normalizeSlashes(s) {
  return String(s).replace(/\\/g, '/')
}

function matchesAny(value, patterns) {
  // 只对被测值做斜杠归一；pattern 里可能含正则转义（`\.`），不能碰。
  const v = normalizeSlashes(value)
  for (const p of patterns) {
    const re = safeRe(p)
    if (re && re.test(v)) return p
  }
  return null
}

function underDataRoot(path, profile) {
  const p = normalizeSlashes(path).toLowerCase()
  return profile.dataRoots.some((root) =>
    p.startsWith(normalizeSlashes(root).toLowerCase()),
  )
}

function ownsProcess(nameOrPath, profile) {
  const re = safeRe(profile.processPattern)
  if (!re) return false
  const base = String(nameOrPath).replace(/\\/g, '/').split('/').pop() || nameOrPath
  return re.test(base) || re.test(String(nameOrPath))
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

export function evaluate(probe, profiles, opts = DEFAULT_RULE_OPTIONS) {
  const out = []
  const now = probe.atMs

  // R0：探针降级必须显式上报，否则会变成"假安全"
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
    const procs = probe.processes.filter(
      (p) => ownsProcess(p.name, profile) || ownsProcess(p.path, profile),
    )
    const pidSet = new Set(procs.map((p) => p.pid))

    // R1：agent 进程连向对象存储 —— 最强信号
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

    // R2：新鲜打包产物
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

    // R3：短时间内成簇刷包
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

    // R4：密钥/凭据文件最近被触达
    for (const s of probe.secrets) {
      if (now - s.mtimeMs > opts.freshSecretMs) continue
      const hit = matchesAny(s.path, profile.secretFiles.map(normalizeSlashes))
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

    // R5：DNS 缓存残留对象存储解析 —— 刻意降级为 info，不作为外传证据
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

    // R6：agent 存活与当前外发连接数（面板"安静/活跃"状态）
    if (procs.length > 0) {
      const agentConns = probe.connections.filter((c) => pidSet.has(c.pid))
      out.push({
        ruleId: 'R6-agent-alive-quiet',
        severity: 'info',
        profileId: profile.id,
        title: `${profile.label} 运行中，当前外发连接 ${agentConns.length} 条`,
        evidence: { processCount: procs.length, egressConnections: agentConns.length },
        suggest: 'alert',
      })
    }
  }

  return out
}

/** 由 findings 推出桌宠表情/状态等级。 */
export function moodOf(findings) {
  const order = ['info', 'medium', 'high', 'critical']
  let worst = null
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
