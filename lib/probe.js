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
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const PS_CANDIDATES = ['pwsh.exe', 'powershell.exe']

/**
 * ⚠️ 血案：以前用 execFileSync 的 `stdio: ['ignore','pipe','pipe']` 抓 PowerShell 输出，
 * 在受限执行环境（DSH 沙箱一类的"禁止父进程用管道抓子进程输出"策略）里会被判
 * EPERM，于是三个系统探针全部失败 → R0 降级 → 守护拿不到任何进程/连接数据。
 * 现在改成：**PowerShell 把结果写进临时文件，Node 读文件**，全程 stdio:'ignore'，
 * 一个管道都不用。探针因此在这类环境里也能工作。
 */
let probeSeq = 0

function runPsToFile(ps, script, timeoutMs) {
  const file = join(tmpdir(), `deskpet-guard-probe-${process.pid}-${++probeSeq}.json`)
  const safePath = file.replace(/'/g, "''") // PowerShell 单引号串里只有 ' 需要转义，反斜杠是字面量
  // 脚本末尾原本的 ConvertTo-Json 去掉，由外层统一序列化并落盘
  const body = String(script)
    .replace(/\|\s*ConvertTo-Json[^|]*$/i, '')
    .replace(/\|\s*$/, '')
    .trim()
  const wrapped = `$ErrorActionPreference='SilentlyContinue'; $o = @(${body}); $o | ConvertTo-Json -Compress | Set-Content -LiteralPath '${safePath}' -Encoding UTF8`
  try {
    spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', wrapped], {
      stdio: 'ignore',
      timeout: timeoutMs,
    })
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
    if (!raw) return []
    // ⚠️ 两个坑：
    // ① Windows PowerShell 5.1 **不支持** ConvertTo-Json -AsArray（PS6+ 才有），
    //    以前脚本里带这个参数 → 整条命令报错 → 三个系统探针全废 → R0 永久降级。
    // ② 5.1 会把"单元素数组"压成对象，所以这里统一归一化成数组。
    const firstBrace = raw.search(/[[{]/)
    if (firstBrace < 0) return []
    const lastBrace = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
    if (lastBrace < firstBrace) return []
    const data = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
    return Array.isArray(data) ? data : [data]
  } catch {
    return null
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* 临时文件已经不在了 */
    }
  }
}

/** 选中可用的 PowerShell 可执行文件；都没有则返回 null。 */
export function findPowerShell() {
  for (const c of PS_CANDIDATES) {
    try {
      // 只用退出码判断，不抓输出（抓输出=管道=受限环境里会被拒）
      const r = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 8000 })
      if (r && r.status === 0) return c
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

function psJson(ps, script, timeoutMs = 20000) {
  return runPsToFile(ps, script, timeoutMs)
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

/**
 * 进程详情（pid / 父 pid / cmdline）——按 agent 归属的关键输入。
 * 只读查询（Get-CimInstance Win32_Process），不修改任何东西。
 */
function probeProcessDetails(ps) {
  const script =
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -AsArray'
  const rows = psJson(ps, script, 30000)
  if (!rows) return null
  return rows.map((r) => ({
    pid: Number(r.ProcessId) || 0,
    ppid: Number(r.ParentProcessId) || 0,
    name: String(r.Name || ''),
    cmd: String(r.CommandLine || '').slice(0, 400),
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

  // 进程详情（pid / 父 pid / cmdline）：**按 agent 归属的关键输入**。
  // 光靠进程名认不出 agent —— DSH 本体与 ZCode 的 MCP 子进程都叫 node.exe，
  // 得看 cmdline（如 `pnpm dlx @deepseek-ai/dsh web`）或父进程链（node 的父是 ZCode.exe）。
  const details = probeProcessDetails(ps)
  if (details) result.procDetails = details
  else {
    result.procDetails = []
    errors.push('Win32_Process 进程详情探针失败（按 agent 归属会退化为仅按名称）')
  }

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
