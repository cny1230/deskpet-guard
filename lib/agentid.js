/**
 * deskpet-guard — agent 归属层。
 *
 * 目的：把"全机一份结论"拆成"哪个 agent 干的"，这样每只桌宠才能只盯自己的那家。
 * 依据（都是引擎现有数据里能拿到的）：
 *   · 进程名：ZCode.exe / claude / cursor / codex / windsurf / cline …
 *   · 工作区/数据目录路径：~/.zcode、~/.dsh、~/.claude、~/.cursor …
 *   · 规则画像 profileId（例如按 agent 命名的画像）
 *
 * 铁律：**判不出来就归 unknown（未归属），绝不硬塞给某个 agent**。
 * 宁可显示"未归属"，也不能让两只桌宠都以为是自己干的。
 */

/** 已知 agent 的识别模式（进程名优先，路径兜底）。新增 agent 往这里加一条即可。 */
export const AGENT_PATTERNS = [
  { id: 'zcode', proc: /zcode/i, path: /[\\/]\.zcode[\\/]|[\\/]zcode[\\/]/i },
  { id: 'dsh', proc: /dsh/i, path: /super-injector|[\\/]\.dsh[\\/]|[\\/]dsh-[a-z-]+[\\/]/i },
  { id: 'claude', proc: /claude/i, path: /[\\/]\.claude[\\/]/i },
  { id: 'cursor', proc: /cursor/i, path: /[\\/]\.cursor[\\/]/i },
  { id: 'codex', proc: /codex/i, path: /[\\/]\.codex[\\/]/i },
  { id: 'cline', proc: /cline/i, path: /[\\/]\.cline[\\/]/i },
  { id: 'windsurf', proc: /windsurf/i, path: /[\\/]\.windsurf[\\/]/i },
]

export const UNKNOWN_AGENT = 'unknown'

/** cmdline → agent id：**node 类 agent 的唯一可靠识别方式**。
 *  例：pnpm dlx @deepseek-ai/dsh web → dsh；ZCode.exe → zcode。 */
export function agentOfCommandLine(cmd) {
  const s = String(cmd || '')
  if (!s) return UNKNOWN_AGENT
  const rules = [
    { id: 'dsh', re: /@deepseek-ai\/dsh|dsh-web-app|dsh[\\/]packages[\\/]/i },
    { id: 'zcode', re: /[\\/]zcode[\\/]|zcode\.exe/i },
    { id: 'claude', re: /@anthropic-ai\/claude-code|claude\.exe|[\\/]\.claude[\\/]/i },
    { id: 'cursor', re: /cursor\.exe|[\\/]cursor[\\/]/i },
    { id: 'codex', re: /codex\.exe|@openai\/codex/i },
    { id: 'cline', re: /\bcline\b/i },
    { id: 'windsurf', re: /windsurf/i },
  ]
  for (const r of rules) if (r.re.test(s)) return r.id
  return UNKNOWN_AGENT
}

/**
 * 由进程详情表构造"pid → agent"解析器：先看自己，再沿**父进程链**上溯（最多 6 层）。
 * 这是让 node 形态的 agent 也能归到自己名下的关键：MCP 子进程叫 node.exe，
 * 但它的父进程是 ZCode.exe；DSH 本体的 cmdline 里带 @deepseek-ai/dsh。
 */
export function buildPidResolver(procDetails) {
  const byPid = new Map((procDetails || []).map((d) => [Number(d.pid) || 0, d]))
  return function resolvePid(pid) {
    let cur = Number(pid) || 0
    const seen = new Set()
    for (let hop = 0; cur && hop < 6 && !seen.has(cur); hop++) {
      seen.add(cur)
      const d = byPid.get(cur)
      if (!d) break
      const byCmd = agentOfCommandLine(d.cmd)
      if (byCmd !== UNKNOWN_AGENT) return byCmd
      const byName = agentOfProcess(d.name)
      if (byName !== UNKNOWN_AGENT) return byName
      cur = Number(d.ppid) || 0
    }
    return UNKNOWN_AGENT
  }
}

/** 进程名 → agent id（认不出返回 unknown）。 */
export function agentOfProcess(name) {
  const s = String(name || '').trim()
  if (!s) return UNKNOWN_AGENT
  for (const p of AGENT_PATTERNS) if (p.proc.test(s)) return p.id
  return UNKNOWN_AGENT
}

/** 路径 → agent id（认不出返回 unknown）。 */
export function agentOfPath(p) {
  const s = String(p || '')
  if (!s) return UNKNOWN_AGENT
  for (const pat of AGENT_PATTERNS) if (pat.path.test(s)) return pat.id
  return UNKNOWN_AGENT
}

/** 规则画像 id → agent id（画像允许直接用 agent 名，如 "claude-code"）。 */
export function agentOfProfile(profileId) {
  const s = String(profileId || '')
  if (!s || s === '*') return UNKNOWN_AGENT
  for (const p of AGENT_PATTERNS) if (p.proc.test(s)) return p.id
  return UNKNOWN_AGENT
}

/** 从一条 finding 的证据里尽量挖出归属：进程名 > 路径 > 画像 > unknown。 */
export function agentOfFinding(finding, resolvePid) {
  const ev = (finding && finding.evidence) || {}
  // 最精确的一路：按 pid（可沿父进程链认出 node 形态的 agent）
  const pid = Number(ev.pid || (finding && finding.pid) || 0)
  if (pid > 0 && typeof resolvePid === 'function') {
    const byPid = resolvePid(pid)
    if (byPid !== UNKNOWN_AGENT) return byPid
  }
  const proc = ev.process || ev.processName || ev.name || (finding && finding.process)
  if (proc) {
    const byProc = agentOfProcess(proc)
    if (byProc !== UNKNOWN_AGENT) return byProc
  }
  const paths = []
  for (const k of ['path', 'file', 'filePath', 'target', 'workspace', 'dir']) {
    if (typeof ev[k] === 'string') paths.push(ev[k])
  }
  if (Array.isArray(ev.paths)) paths.push(...ev.paths.filter((x) => typeof x === 'string'))
  for (const p of paths) {
    const byPath = agentOfPath(p)
    if (byPath !== UNKNOWN_AGENT) return byPath
  }
  return agentOfProfile((finding && finding.profileId) || ev.profileId)
}

/**
 * 把一次扫描结果按 agent 拆开。
 * @param {{findings?:any[], killTargets?:any[]}} result
 * @returns {{perAgent: Record<string, {alerts:number, critical:number, high:number, medium:number, targets:number, findings:any[]}>, unattributed: object, agents: string[]}}
 */
export function attributeScan(result, opts = {}) {
  const findings = (result && result.findings) || []
  const targets = (result && result.killTargets) || []
  const perAgent = {}
  const bucket = (id) => {
    if (!perAgent[id]) {
      perAgent[id] = {
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
    }
    return perAgent[id]
  }

  for (const f of findings) {
    const agent = agentOfFinding(f, opts.resolvePid)
    const b = bucket(agent)
    b.alerts += 1
    const sev = String((f && f.severity) || 'info').toLowerCase()
    if (b[sev] !== undefined) b[sev] += 1
    b.findings.push({
      ruleId: f && f.ruleId,
      severity: sev,
      title: f && f.title,
      agent,
    })
  }

  for (const t of targets) {
    // 目标本来就带 pid / process（R1 的对象存储外连），归属到"是谁在连"
    const name = t && (t.process || t.processName || t.name)
    const tpid = Number((t && t.pid) || 0)
    let agent = name ? agentOfProcess(name) : UNKNOWN_AGENT
    // 名字认不出（例如 node）时，交给 pid 解析器沿父链找
    if (agent === UNKNOWN_AGENT && tpid > 0 && typeof opts.resolvePid === 'function') {
      agent = opts.resolvePid(tpid)
    }
    bucket(agent).targets += 1
  }


  // 按 agent 计数：进程（pid 解析器）、外连（按 owning pid）、打包产物（按路径）。
  // 拆不掉的一律进 unknown —— 这样安静时两只桌宠也不会显示成同一份数字。
  const resolvePid = opts.resolvePid
  const agentOfPid = (pid) => {
    const n = Number(pid) || 0
    if (!n) return UNKNOWN_AGENT
    if (typeof resolvePid === "function") {
      const a = resolvePid(n)
      if (a !== UNKNOWN_AGENT) return a
    }
    return UNKNOWN_AGENT
  }
  for (const d of opts.procDetails || []) {
    const a = agentOfPid(d.pid)
    if (a !== UNKNOWN_AGENT) bucket(a).procs += 1
  }
  for (const c of opts.connections || []) bucket(agentOfPid(c.pid)).egress += 1
  for (const b of opts.bundles || []) {
    const p = typeof b === "string" ? b : (b && (b.path || b.file)) || ""
    bucket(agentOfPath(p)).bundles += 1
  }
  const agents = Object.keys(perAgent).sort()
  // 别用 bucket() 造 unknown —— 没有未归属项时不该凭空多出一个键（测试盯着这一点）
  const unattributed = perAgent[UNKNOWN_AGENT] || {
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
  return { perAgent, unattributed, agents }
}

/** 某只桌宠该看的那一份（client=agent id）。 */
export function viewForClient(attribution, client) {
  const per = (attribution && attribution.perAgent) || {}
  const mine = per[client] || { alerts: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, targets: 0, findings: [] }
  const un = per[UNKNOWN_AGENT] || { alerts: 0, targets: 0, findings: [] }
  return { mine, unattributed: un, known: !!per[client] || Object.keys(per).length > 0 }
}
