/**
 * deskpet-guard — 只读探针层。
 *
 * 铁律：本文件只能执行"查询"类系统操作。
 *   · PowerShell 命令全部是 Get-* / Test-Path 等只读 cmdlet；
 *   · 不写任何文件（事件流写盘在 events.js，且只写自己的数据目录）；
 *   · 不改任何系统配置（不碰防火墙 / hosts / 注册表 / 证书存储）。
 *
 * 探针失败不抛异常：记录到 probeErrors，由规则引擎 R0 显式上报"能力降级"，
 * 避免出现"探针挂了所以看起来安全"的假阴性。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PS_CANDIDATES = ['pwsh.exe', 'powershell.exe']

/** 选中可用的 PowerShell 可执行文件；都没有则返回 null。 */
export function findPowerShell() {
  for (const c of PS_CANDIDATES) {
    try {
      execFileSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      })
      return c
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

function psJson(ps, script, timeoutMs = 20000) {
  try {
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    const s = out.indexOf('[')
    const e = out.lastIndexOf(']')
    if (s < 0 || e < 0) return []
    return JSON.parse(out.slice(s, e + 1))
  } catch {
    return null
  }
}

/** TCP 连接（只取外部地址，排除本地回环）。 */
function probeConnections(ps) {
  const script = [
    'Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |',
    "Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1|0\\.0\\.0\\.0)' } |",
    'ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;',
    "[pscustomobject]@{ pid=$_.OwningProcess; name=$(if($p){$p.ProcessName}else{'?'}); remote=$_.RemoteAddress; port=$_.RemotePort } } |",
    'ConvertTo-Json -Compress -AsArray',
  ].join(' ')
  const rows = psJson(ps, script)
  if (!rows) return null
  return rows.map((r) => ({
    pid: Number(r.pid) || 0,
    processName: String(r.name || '?'),
    remoteAddress: String(r.remote || ''),
    remotePort: Number(r.port) || 0,
  }))
}

/** DNS 客户端缓存。 */
function probeDns(ps) {
  const script =
    'Get-DnsClientCache -ErrorAction SilentlyContinue | ' +
    'Select-Object -First 2000 Entry,Data | ConvertTo-Json -Compress -AsArray'
  const rows = psJson(ps, script)
  if (!rows) return null
  return rows.map((r) => ({ entry: String(r.Entry || ''), data: String(r.Data || '') }))
}

/** 运行中的进程。 */
function probeProcesses(ps) {
  const script =
    'Get-Process -ErrorAction SilentlyContinue | ' +
    'Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress -AsArray'
  const rows = psJson(ps, script)
  if (!rows) return null
  return rows.map((r) => ({
    pid: Number(r.Id) || 0,
    name: String(r.ProcessName || ''),
    path: String(r.Path || ''),
  }))
}

/** 递归扫一个目录下匹配任一文件名正则的文件（限深、限量，避免拖慢）。 */
function walkMatches(root, patterns, opts) {
  const { maxDepth = 4, maxFiles = 500 } = opts || {}
  const res = []
  if (!existsSync(root)) return res
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length && res.length < maxFiles) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!ent.isFile()) continue
      if (patterns.some((p) => new RegExp(p, 'i').test(ent.name))) {
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        res.push({ path: full, bytes: st.size, mtimeMs: st.mtimeMs })
        if (res.length >= maxFiles) break
      }
    }
  }
  return res
}

/** 采集一次完整快照。任何子探针失败都记入 probeErrors，不中断。 */
export function probe(profiles, opts) {
  const atMs = Date.now()
  const errors = []
  const home = (opts && opts.home) || homedir()

  const result = {
    atMs,
    platform: process.platform === 'win32' ? 'win32' : 'unsupported',
    probeErrors: errors,
    processes: [],
    connections: [],
    dns: [],
    bundles: [],
    secrets: [],
  }

  if (result.platform !== 'win32') {
    errors.push(`platform ${process.platform} unsupported: 本版探针仅实现 Windows`)
    return result
  }

  const ps = (opts && opts.ps) || findPowerShell()
  if (!ps) {
    errors.push('未找到 pwsh/powershell，无法采集系统探针')
    return result
  }

  const conns = probeConnections(ps)
  if (conns) result.connections = conns
  else errors.push('Get-NetTCPConnection 探针失败')

  const dns = probeDns(ps)
  if (dns) result.dns = dns
  else errors.push('Get-DnsClientCache 探针失败')

  const procs = probeProcesses(ps)
  if (procs) result.processes = procs
  else errors.push('Get-Process 探针失败')

  for (const p of profiles) {
    for (const root of p.dataRoots) {
      result.bundles.push(...walkMatches(root, p.bundlePatterns, { maxDepth: 5 }))
    }
    for (const root of p.secretFiles) {
      // secretFiles 条目可以是目录或文件
      if (existsSync(root)) {
        try {
          const st = statSync(root)
          if (st.isDirectory()) {
            const files = walkMatches(root, ['\\.(key|pem|pfx|p12|json|yaml|yml)$'], {
              maxDepth: 3,
              maxFiles: 100,
            })
            result.secrets.push(...files)
          } else {
            result.secrets.push({ path: root, bytes: st.size, mtimeMs: st.mtimeMs })
          }
        } catch {
          /* 忽略单项失败 */
        }
      }
    }
  }

  // 去重（bundle 可能被多个 profile 的数据根重复扫到）
  const seen = new Set()
  result.bundles = result.bundles.filter((b) => {
    const k = b.path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return result
}

/** 读取一个 JSON 文件（失败返回 null），用于状态文件解读。 */
export function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
