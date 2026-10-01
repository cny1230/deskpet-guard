/**
 * deskpet-guard — 独立采样守护（问题②的解：采样不再寄生于 DSH 宿主）。
 *
 * 职责：
 *   · 周期采样（复用 index.js 的 sampleOnce + 单采样者锁选主）；
 *   · **自己托管本地 HTTP API**（零依赖 node:http + 纯函数 createApi），
 *     DSH 不在时，桌宠看板 / MCP 桥照样有数据面与处置入口；
 *   · 写 endpoint.json（带真实端口），让其它进程发现它；
 *   · 失去主位（DSH 宿主回来了）就退位：停采样、关端口，只留心跳等接管机会。
 *
 * 生命周期：由 ensureSampler() 在桌宠拉起 / MCP 启动时幂等拉起（detached 进程），
 * 一直跑到被 kill（bin/deskpet-guard-sampler.js --stop 或任务管理器）。
 * 多份守护并存是安全的：锁选主保证只有 leader 采样与开端口。
 *
 * 处置语义：prepare/confirm 在**同一个 HTTP 进程**内完成两步（token 单进程有效）；
 * endpoint.json 指向谁，MCP 桥就完整走谁的两步，不会跨进程拼 token。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolveDataDir, readStatus, readEvents, readEndpoint, writeEndpoint, ensureConfirmSecret, secretEquals } from './events.js'
import { mergeProfiles } from './profiles.js'
import { scan as realScan, sampleOnce, prepareKill, killByPids, acquireSamplerLock, refreshSamplerLock, releaseSamplerLock, VERSION } from './index.js'
import { createApi, ALL_PREFIXES } from './api.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(HERE, '..', 'assets')
const LOCK_FILE = 'guard-sampler.lock'          // 共享选主锁（与 DSH 宿主 apply() 共用，别按它杀进程！）
const DAEMON_LOCK = 'sampler-daemon.lock'        // 守护进程自己的身份锁（--stop 只认这个）

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
}

/** 读采样者锁（与 index.js 的写入口对应；这里只读，不参与选主）。 */
export function readSamplerLock(dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, LOCK_FILE), 'utf8'))
    return j && Number.isFinite(j.atMs) ? j : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/** 是否有活着的采样守护（看守护自己的身份锁，与共享选主锁无关——DSH 宿主也会写选主锁）。 */
export function samplerAlive(dataDir, holdMs = 60_000) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, DAEMON_LOCK), 'utf8'))
    if (!j || Date.now() - Number(j.atMs || 0) > holdMs) return false
    const pid = Number(j.pid || 0)
    return pid > 0 ? pidAlive(pid) : true
  } catch {
    return false
  }
}

function writeDaemonLock(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, DAEMON_LOCK),
      JSON.stringify({ pid: process.pid, atMs: Date.now(), at: new Date().toISOString() }),
    )
  } catch {
    /* 身份锁写不了不致命（只影响 --stop 精确命中） */
  }
}

/** 停止采样守护：只按守护自己的身份锁杀，绝不碰共享选主锁里的 DSH 宿主。 */
export function stopSampler(dataDir) {
  const dir = dataDir || resolveDataDir()
  let lock = null
  try {
    lock = JSON.parse(readFileSync(join(dir, DAEMON_LOCK), 'utf8'))
  } catch {
    lock = null
  }
  if (!lock || !Number(lock.pid)) {
    return { ok: false, message: '没有运行中的采样守护（无 ' + DAEMON_LOCK + '）' }
  }
  const pid = Number(lock.pid)
  const wasAlive = pidAlive(pid)
  try {
    process.kill(pid)
  } catch {
    /* 已经没了 */
  }
  return { ok: true, pid, message: '已请求停止采样守护（pid=' + pid + (wasAlive ? '' : '，已不在') + '）' }
}

/**
 * 幂等拉起独立守护：没有活着的守护才 spawn（detached，与本进程生命周期解耦）。
 * 由桌宠拉起 / MCP 启动 / hook 调用；重复调用是安全的。
 * @param {{dataDir?:string, intervalMs?:number, spawnImpl?:Function}} [opts]
 */
export function ensureSampler(opts = {}) {
  // 环境闸门（所有调用路径的总开关）：测试/嵌入式场景设 DESKPET_GUARD_NO_SAMPLER=1。
  // 血案：闸门曾只放在 launchPet 的"是否注入"上，plugin.test 的 apply() 走真实路径
  // 拉起了 4 个指向临时目录的孤儿守护，每 15s 一轮探针 → 用户桌面 PowerShell 疯狂闪。
  if (process.env.DESKPET_GUARD_NO_SAMPLER === '1') {
    return { ok: true, skipped: true, message: 'DESKPET_GUARD_NO_SAMPLER=1，跳过拉起' }
  }
  const dataDir = opts.dataDir || resolveDataDir()
  const intervalMs = Number(opts.intervalMs) || 15000
  if (samplerAlive(dataDir, Math.max(intervalMs * 3, 60_000))) {
    return { ok: true, skipped: true, message: '采样守护已在运行，跳过拉起' }
  }
  const entry = join(HERE, '..', 'bin', 'deskpet-guard-sampler.js')
  if (!existsSync(entry)) {
    return { ok: false, message: '找不到守护入口: ' + entry }
  }
  const spawnImpl = opts.spawnImpl || spawn
  try {
    const child = spawnImpl(
      process.execPath,
      [entry, '--data-dir', dataDir, '--interval', String(intervalMs)],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    try {
      child.unref?.()
    } catch {
      /* ignore */
    }
    return { ok: true, pid: child.pid || 0, message: '采样守护已拉起（pid=' + (child.pid || '?') + '）' }
  } catch (e) {
    return { ok: false, message: '拉起采样守护失败: ' + String((e && e.message) || e) }
  }
}

const ASSET_RE = /^[a-z0-9._-]+$/i

/**
 * 启动采样守护循环（可长驻，也可在测试里注入 scan 后短跑）。
 * @param {{dataDir?:string, intervalMs?:number, profiles?:Array, scan?:Function,
 *          log?:Function, serve?:boolean}} [opts]
 * @returns {{stop:Function, state:object}} state 含 leader/port/cycles，测试可读
 */
export function startSampler(opts = {}) {
  const dataDir = opts.dataDir || resolveDataDir()
  // 下限 200ms 只是防手滑传 0；生产建议 15s，测试可以传短间隔快速跑完
  const intervalMs = Math.max(200, Number(opts.intervalMs) || 15000)
  const profiles = opts.profiles || mergeProfiles(undefined, homedir())
  const scanImpl = opts.scan || realScan
  const serve = opts.serve !== false
  const log = (...a) => { try { (opts.log || (() => {}))('[sampler] ' + a.join(' ')) } catch { /* ignore */ } }
  const seen = new Map()
  const state = { cycles: 0, leader: false, port: 0, server: null, timer: null, stopped: false, lastError: null }

  const freshScan = () => sampleOnce(scanImpl, dataDir, profiles, seen, ++state.cycles).r

  const api = createApi({
    dataDir,
    version: VERSION,
    mode: 'execute',
    secret: () => ensureConfirmSecret(dataDir),
    secretEquals,
    readStatus: () => readStatus(dataDir),
    readEvents: (n) => readEvents(dataDir, n),
    scan: () => freshScan(),
    prepareKill: (targetPid) => prepareKill(dataDir, freshScan(), { targetPid }),
    confirmKill: (token) => killByPids(dataDir, token),
    log,
  })

  function ensureServer(onReady) {
    if (state.server || !serve) return
    const server = createServer((req, res) => {
      try {
        console.log('REQ', req.url)
    const url = new URL(req.url || '/', 'http://127.0.0.1')
        const path = url.pathname
        if (path === '/deskpet-guard/dashboard' || path === '/deskpet-guard/dashboard/') {
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
          const _d = readFileSync(join(ASSETS_DIR, 'dashboard.html'), 'utf8').replaceAll('__VERSION__', VERSION)
          res.end(_d)
          console.log('DASH 已回包')
          return
        }
        if (path.startsWith('/deskpet-guard/assets/')) {
          const name = path.slice('/deskpet-guard/assets/'.length)
          if (!ASSET_RE.test(name)) { res.writeHead(403); res.end('forbidden'); return }
          const file = join(ASSETS_DIR, name)
          if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
          res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream',
            'cache-control': 'no-store' })
          res.end(readFileSync(file))
          return
        }
        if (ALL_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
          let body = ''
          let over = false
          req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { over = true; req.destroy() } })
          req.on('end', () => {
            if (over) return
            let out
            try {
              out = api.dispatch({ method: req.method, path: req.url, headers: req.headers, body: body || undefined })
            } catch (e) {
              out = { status: 500, headers: { 'content-type': 'application/json' }, body: { ok: false, error: String(e) } }
            }
            try {
              res.writeHead(out.status, out.headers)
              res.end(JSON.stringify(out.body))
            } catch { /* 客户端断开 */ }
          })
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      } catch { /* 连接级异常不拖垮守护 */ }
    })
    // 只听本机回环；端口交给系统分配（避免与 DSH webServer 抢 3080）
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port
      writeEndpoint(dataDir, {
        endpoint: 'http://127.0.0.1:' + state.port,
        apiBase: '/deskpet-guard/api',
        pid: process.pid,
        sampler: true,
        atMs: Date.now(),
      })
      log('http on 127.0.0.1:' + state.port)
      if (onReady) onReady(state.port)
    })
    server.on('error', (e) => { state.lastError = String(e && e.message) })
    state.server = server
  }

  function closeServer() {
    if (!state.server) return
    try { state.server.close() } catch { /* ignore */ }
    state.server = null
    state.port = 0
  }

  function tick() {
    if (state.stopped) return
    writeDaemonLock(dataDir) // 守护身份心跳（--stop 只认这个锁，别按共享选主锁杀进程）
    try {
      // 选主语义：inst 一经持有就固定复用（acquireSamplerLock 每次调用会生成新 inst，
      // 周期循环里若每轮重新 acquire，leader 会被自己上一轮的锁"劝退"——实测踩过）。
      // 成为 leader 后持续心跳；跟随者定期重试接管（前任崩溃后心跳过期即上位）。
      if (!state.inst) {
        const lock = acquireSamplerLock(dataDir, intervalMs)
        if (lock.leader) {
          state.inst = lock.inst
          state.leader = true
          refreshSamplerLock(dataDir, state.inst)
        } else {
          state.holder = lock.holder || null
        }
      } else if (state.leader) {
        refreshSamplerLock(dataDir, state.inst)
        state.leader = true
      } else {
        const lock = acquireSamplerLock(dataDir, intervalMs)
        if (lock.leader) {
          state.inst = lock.inst
          state.leader = true
          refreshSamplerLock(dataDir, state.inst)
        }
      }
      if (!state.leader) {
        // 让位：别的实例（DSH 宿主或另一份守护）在采样 —— 不采样、不开端口
        closeServer()
        return
      }
      sampleOnce(scanImpl, dataDir, profiles, seen, ++state.cycles)
      ensureServer()
      writeEndpointLive()
    } catch (e) {
      state.lastError = String(e && e.message)
      log('采样失败: ' + state.lastError)
    }
  }

  // endpoint.json 需要持续保鲜（atMs 会被读端判断新鲜度）
  function writeEndpointLive() {
    if (!state.port) return
    try {
      writeEndpoint(dataDir, {
        endpoint: 'http://127.0.0.1:' + state.port,
        apiBase: '/deskpet-guard/api',
        pid: process.pid,
        sampler: true,
        atMs: Date.now(),
      })
    } catch { /* ignore */ }
  }

  tick()
  state.timer = setInterval(tick, intervalMs)
  // 定时器不阻止进程退出是不对的：守护就该长驻。unref 与否由调用方决定。
  if (opts.unrefTimer) state.timer.unref?.()

  return {
    stop() {
      state.stopped = true
      if (state.timer) clearInterval(state.timer)
      closeServer()
      // 干净交棒：删掉自己的选主锁，让其它守护/宿主立刻接管（不用等心跳过期）
      if (state.inst) {
        try { releaseSamplerLock(dataDir, state.inst) } catch { /* ignore */ }
      }
    },
    state,
  }
}
