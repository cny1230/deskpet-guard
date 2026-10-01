#!/usr/bin/env node
/**
 * deskpet-guard — 独立采样守护入口。
 *
 *   deskpet-guard-sampler                          # 前台跑（一般由 ensureSampler detached 拉起）
 *   deskpet-guard-sampler --data-dir <目录>        # 指定数据目录
 *   deskpet-guard-sampler --interval <毫秒>        # 采样周期（默认 15000）
 *   deskpet-guard-sampler --stop                   # 停止运行中的守护（只认守护自己的身份锁）
 *   deskpet-guard-sampler --status                 # 打印守护是否在跑 / 端点
 *
 * 解决的问题：此前采样循环只活在 DSH 宿主里，DSH 一关其它 agent 的桌宠全是过期快照。
 * 现在桌宠拉起 / MCP 启动 / hook 都会经 ensureSampler() 幂等拉起本守护；
 * 与 DSH 宿主通过共享选主锁协调，同一时刻只有一家在采样。
 */
import { tmpdir } from 'node:os'
import { resolveDataDir, readEndpoint } from '../lib/events.js'
import { startSampler, stopSampler, samplerAlive, readSamplerLock } from '../lib/sampler.js'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dataDir = argOf('--data-dir') || resolveDataDir()
const intervalMs = Number(argOf('--interval')) || 15000

// 熔断：守护绝不在系统临时目录里跑 —— 那只可能是测试漏出来的孤儿
// （数据目录随测试删除后它还在烧探针，0.4.0 实测血案）。
if (dataDir.toLowerCase().startsWith(tmpdir().toLowerCase())) {
  console.error('[sampler] 拒绝在系统临时目录运行（dataDir=' + dataDir + '）。' +
    '这通常是测试漏出的孤儿；正式部署请指定持久化数据目录。')
  process.exit(2)
}

if (argv.includes('--stop')) {
  const r = stopSampler(dataDir)
  console.log(r.message)
  process.exit(r.ok ? 0 : 1)
}

if (argv.includes('--status')) {
  const alive = samplerAlive(dataDir)
  const ep = readEndpoint(dataDir)
  console.log(alive ? '采样守护：运行中' : '采样守护：未运行')
  if (ep && ep.endpoint) console.log('HTTP API：' + ep.endpoint + '（pid=' + ep.pid + '）')
  const lock = readSamplerLock(dataDir)
  if (lock) console.log('选主锁：pid=' + lock.pid + ' · 心跳 ' + new Date(lock.atMs).toLocaleTimeString())
  process.exit(0)
}

// 前台跑：日志进 stdout（detached 拉起时是 'ignore'，天然丢弃）
const handle = startSampler({
  dataDir,
  intervalMs,
  log: (msg) => console.log(new Date().toISOString() + ' ' + msg),
})
console.log('[sampler] started · dataDir=' + dataDir + ' · interval=' + intervalMs + 'ms · pid=' + process.pid)

process.on('SIGINT', () => { handle.stop(); process.exit(0) })
process.on('SIGTERM', () => { handle.stop(); process.exit(0) })
// 心跳循环持有定时器引用，进程会一直活着；异常兜底不让单次错误退出守护
process.on('uncaughtException', (e) => {
  console.error('[sampler] uncaught: ' + String((e && e.message) || e))
})
