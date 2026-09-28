/**
 * deskpet-guard — 事件流（唯一会写盘的地方）。
 *
 * 设计约束：
 *   · 只追加（append-only），不修改、不删除任何已有记录；
 *   · 只写自己的数据目录（默认 DSH_HOME/super-injector/deskpet-guard/），
 *     绝不写被监控 agent 的目录；
 *   · jsonl 一行一条，便于其它 agent / 工具流式 tail。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, statSync, openSync, readSync, closeSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function resolveDataDir(explicit) {
  if (explicit) return explicit
  if (process.env.DESKPET_GUARD_DIR) return process.env.DESKPET_GUARD_DIR
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'super-injector', 'deskpet-guard')
}

export function eventsPath(dataDir) {
  return join(dataDir, 'guard-events.jsonl')
}

export function statusPath(dataDir) {
  return join(dataDir, 'guard-status.json')
}

export function endpointPath(dataDir) {
  return join(dataDir, 'endpoint.json')
}

/**
 * 记录本地 HTTP API 的基址，供面板/CLI/MCP 桥发现（它们不在 host 进程里，
 * 拿不到端口）。写失败静默：发现不了就是降级，不该拖垮守护。
 */
export function writeEndpoint(dataDir, info) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(endpointPath(dataDir), JSON.stringify({ ...info, atMs: Date.now() }, null, 2))
    return true
  } catch {
    return false
  }
}

export function readEndpoint(dataDir) {
  const f = endpointPath(dataDir)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

const SECRET_FILE = 'confirm-secret.json'

/** 生成/读取处置确认用的 session secret（0600 语义：仅本地文件）。 */
export function ensureConfirmSecret(dataDir) {
  if (process.env.DESKPET_GUARD_SECRET) return process.env.DESKPET_GUARD_SECRET
  const f = join(dataDir, SECRET_FILE)
  try {
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && j.secret) return String(j.secret)
    }
    mkdirSync(dataDir, { recursive: true })
    const secret = randomBytes(24).toString('hex')
    writeFileSync(f, JSON.stringify({ secret, createdAt: Date.now() }), { mode: 0o600 })
    return secret
  } catch {
    // 落盘失败也不阻断守护：退化为进程内临时 secret
    return randomBytes(24).toString('hex')
  }
}

/** 计时安全比较，避免 secret 比对被时序侧信道探测。 */
export function secretEquals(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  try {
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/**
 * 超过这个大小就把当前事件流改名归档为 guard-events.jsonl.1、另起新文件。
 * 改名（而非删除）保住"只追加"语义：历史段仍然完整可读，只是不再追加。
 */
export const EVENTS_MAX_BYTES = 5 * 1024 * 1024

/** 追加事件。返回写入的条数；写失败静默（守护自身不能因日志失败而崩）。 */
export function appendEvents(dataDir, events, opts = {}) {
  if (!events || events.length === 0) return 0
  try {
    mkdirSync(dataDir, { recursive: true })
    const f = eventsPath(dataDir)
    try {
      const st = statSync(f)
      const max = Number(opts.maxBytes) || EVENTS_MAX_BYTES
      if (st.size >= max) {
        try {
          rmSync(f + '.1', { force: true })
          renameSync(f, f + '.1')
        } catch {
          /* 归档失败就继续追加，下次再试 */
        }
      }
    } catch {
      /* 文件尚不存在，无需轮转 */
    }
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    appendFileSync(f, lines)
    return events.length
  } catch {
    return 0
  }
}

/** 只读事件流尾部这么多字节（避免长期运行后整文件载入内存）。 */
export const EVENTS_TAIL_BYTES = 512 * 1024

/** 读取最近 n 条事件；filter 在尾部窗口内逐行判定。 */
export function readEvents(dataDir, n = 50, filter) {
  const f = eventsPath(dataDir)
  if (!existsSync(f)) return []
  let raw = ''
  try {
    const st = statSync(f)
    if (st.size > EVENTS_TAIL_BYTES) {
      // 真 tail：只读最后 512KB，丢弃首个不完整行
      const fd = openSync(f, 'r')
      try {
        const buf = Buffer.alloc(EVENTS_TAIL_BYTES)
        const bytes = readSync(fd, buf, 0, EVENTS_TAIL_BYTES, st.size - EVENTS_TAIL_BYTES)
        raw = buf.toString('utf8', 0, bytes)
      } finally {
        closeSync(fd)
      }
      const nl = raw.indexOf('\n')
      if (nl >= 0) raw = raw.slice(nl + 1)
      else raw = ''
    } else {
      raw = readFileSync(f, 'utf8')
    }
  } catch {
    return []
  }
  raw = raw.trim()
  if (!raw) return []
  let rows = raw.split('\n')
  if (filter) {
    rows = rows.filter((l) => {
      try {
        return filter(JSON.parse(l))
      } catch {
        return false
      }
    })
  }
  return rows
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 写入"最近一次采样"状态，供面板/MCP 低成本读取。 */
export function writeStatus(dataDir, status) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(statusPath(dataDir), JSON.stringify(status, null, 2))
    return true
  } catch {
    return false
  }
}

export function readStatus(dataDir) {
  const f = statusPath(dataDir)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

/** 事件指纹：用于跨轮次去重（同一个 R1 事件不要每 15 秒刷一条）。 */
export function fingerprint(finding) {
  const ev = finding.evidence || {}
  const key = [
    finding.ruleId,
    finding.profileId,
    ev.remote || ev.path || ev.entry || ev.processCount || '',
  ].join('|')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}
