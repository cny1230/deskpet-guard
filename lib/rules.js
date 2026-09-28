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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

/**
 * 路径前缀归属：**必须落在分隔符边界上**。
 * ⚠️ 不能裸用 startsWith —— 否则 `C:\Users\x\.zcode` 会把
 * `C:\Users\x\.zcode-v2\evil.enc` 也认成 ZCode 的数据根下的文件。
 */
function pathUnderPrefix(path, prefixes) {
  const p = normalizeSlashes(path).toLowerCase()
  return prefixes.some((root) => {
    const r = normalizeSlashes(root).toLowerCase().replace(/\/+$/, '')
    if (!r) return false
    return p === r || p.startsWith(r + '/')
  })
}

function underDataRoot(path, profile) {
  return pathUnderPrefix(path, profile.dataRoots)
}

/** R7 的归属判定：indexFile 的路径必须落在本画像声明的 indexFiles 前缀下。 */
function underIndexRoot(path, profile) {
  return pathUnderPrefix(path, profile.indexFiles || [])
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

// ────────────────────────────────────────────────────────────
// R1 的网络匹配：IP 直连域名正则永远匹配不上（Get-NetTCPConnection 的
// RemoteAddress 是 IP，而 egressHostPatterns 是域名正则）——这是历史上
// R1 在真实环境里从不命中的根因。修法两条腿：
//   ① 用探针同时采到的 DNS 缓存（Entry→Data）把连接的远端 IP 反查成域名；
//   ② 让 egressHostPatterns 额外支持 IPv4 字面量与 CIDR（如 10.0.0.0/8）。
// ────────────────────────────────────────────────────────────

/** DNS 缓存 → Map<ip, Set<hostname>>（大小写归一、去尾点）。 */
export function buildDnsHostIndex(dns) {
  const byIp = new Map()
  for (const d of dns || []) {
    const ip = String((d && d.data) || '').trim()
    const host = String((d && d.entry) || '').trim().toLowerCase().replace(/\.$/, '')
    if (!ip || !host) continue
    if (!byIp.has(ip)) byIp.set(ip, new Set())
    byIp.get(ip).add(host)
  }
  return byIp
}

function isIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim())
  if (!m) return false
  return m.slice(1).every((o) => Number(o) <= 255)
}

function ipv4ToInt(s) {
  const o = String(s).split('.').map(Number)
  return (((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0)
}

/**
 * egressHostPatterns 里的 IP 形态匹配：精确 IPv4 或 CIDR（仅 IPv4；
 * IPv6 靠普通正则即可表达字面量，不做 CIDR 展开）。
 * @returns {string|null} 命中的 pattern
 */
export function matchIpPattern(ip, patterns) {
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
function matchEgress(connection, profile, dnsByIp) {
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
export function evaluate(probe, profiles, opts = DEFAULT_RULE_OPTIONS) {
  const out = []
  const now = probe.atMs
  const dnsByIp = buildDnsHostIndex(probe.dns)
  const uploads = probe.uploads || []

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

    // R1：agent 进程连向对象存储 —— 最强信号。
    // 远端是 IP 时优先经 DNS 缓存反查成域名再匹配（evidence.resolvedHost 记录
    // 实际命中的域名，供人工复核 —— CDN 共享 IP 理论上可能串出误报，所以证据必须带出来）。
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
      // 与 .ts 镜像同一口径：目录条目归一斜杠后**转义**成正则（不带转义时
      // 路径里的 `.` 会变成通配符，`xcerts` 这类目录也能误命中）。
      const hit = matchesAny(s.path, profile.secretFiles.map((d) => escapeRe(normalizeSlashes(d))))
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

    // R7：indexFiles 指向的状态/索引文件里出现上传通道标记（uploadPathPatterns）。
    // 这是"已表达上传意图"的静态证据：光有打包产物（R2）可能只是本地快照，
    // 而 state.json 里的 pendingUpload / uploadCredentialHandle / uploadOssForm
    // 这类明文标记说明上传链路已被激活。探针侧只读、限大小、限数量。
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
