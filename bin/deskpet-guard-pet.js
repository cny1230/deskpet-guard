#!/usr/bin/env node
/**
 * deskpet-guard 桌宠启动器（独立命令）。
 *
 *   deskpet-guard-pet            拉起桌宠窗口（幂等：已开则跳过）
 *   deskpet-guard-pet --status   不开窗，打印状态文本
 *   deskpet-guard-pet --stop     关掉桌宠
 *
 * 各 agent 客户端的自动拉起方式：
 *   · 任何会启动本包 MCP server 的客户端（ZCode / Claude Desktop / Cursor…）：
 *     lib/mcp.js 在 serveStdio 启动时会顺带拉起（幂等）
 *   · ZCode 插件市场安装版：deskpet-guard/hooks/hooks.json 的 SessionStart（见该文件）
 *   · 手动/开机自启：把本命令加进启动项即可
 */
import { launchPet, stopPet, petStatusText, readPetState, listPetLocks, PET_CLIENTS, detectClient } from '../lib/pet.js'

const argv = process.argv.slice(2)
const dataDir = process.env.DESKPET_GUARD_DIR || undefined
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const client = argOf('--client') || detectClient()

if (argv.includes('--status')) {
  console.log(petStatusText(dataDir, { client }))
  process.exit(0)
}
if (argv.includes('--list')) {
  const locks = listPetLocks(dataDir)
  if (!locks.length) console.log('当前没有桌宠实例')
  for (const l of locks) console.log(`  ${l.client.padEnd(8)} pid=${l.pid} 存活=${l.alive ? '是' : '否'} 来源=${l.reason || '-'}`)
  process.exit(0)
}
if (argv.includes('--stop')) {
  const r = stopPet(dataDir, argv.includes('all') ? 'all' : client)
  console.log(r.message)
  process.exit(r.ok ? 0 : 1)
}
if (argv.includes('--json')) {
  console.log(JSON.stringify(readPetState(dataDir, { client }), null, 2))
  process.exit(0)
}

const wp = Number(argOf('--watch-pid') || 0) || 0
const wn = argOf('--watch-process') || ''
const r = launchPet({ dataDir, client, reason: 'cli', watch: wp > 0 || wn ? { pid: wp, process: wn } : undefined })
console.log(r.message)
process.exit(r.ok ? 0 : 1)
