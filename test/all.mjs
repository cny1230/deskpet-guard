/**
 * deskpet-guard — 全部离线套件的总入口。
 *
 *   node test/all.mjs        # 等价于 npm test
 *
 * 为什么要有它：npm test 里串 9 条命令不好数、也不好引用（交付/CI/证据清单都想要
 * "一个真实的测试入口文件"）。这里按顺序跑，逐个打印套件结果，最后汇总。
 *
 * 环境自适应：某些受限沙箱禁止程序用管道捕获子进程输出（文档化的沙箱边界）。
 * 抓不到输出时自动退化为 stdio: inherit（照样跑、照样给退出码，只是不汇总例数）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUITES = [
  'rules',
  'kill',
  'consistency',
  'api',
  'plugin',
  'mcp',
  'mcp-stdio',
  'client-bundle',
  'panel-ui',
  'agent-plugin-wrapper',
  'pet',
  'agentid',
]

let cases = 0
let failedSuites = 0
let pipeMode = true

for (const name of SUITES) {
  const file = fileURLToPath(new URL(`./${name}.test.mjs`, import.meta.url))
  console.log(`\n── ${name}.test.mjs ${'─'.repeat(Math.max(0, 40 - name.length))}`)

  let res = pipeMode ? spawnSync(process.execPath, [file], { encoding: 'utf8' }) : null
  if (pipeMode && (res.error || res.status === null)) {
    // 沙箱禁止管道捕获 → 退化为直通模式（后续套件都用直通）
    console.log('  [note] 无法捕获子进程输出（沙箱边界），切换为直通模式')
    pipeMode = false
    res = null
  }
  if (!pipeMode) {
    res = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  } else {
    process.stdout.write(res.stdout || '')
    if (res.stderr) process.stderr.write(res.stderr)
  }

  const m = String((res && res.stdout) || '').match(/结果: (\d+) passed, (\d+) failed/)
  if (m) {
    cases += Number(m[1]) + Number(m[2])
  }
  if (!res || res.status !== 0) failedSuites += 1
}

console.log(
  `\n══ ${SUITES.length - failedSuites}/${SUITES.length} 套件通过` +
    (cases ? `，共 ${cases} 例` : '') +
    ` ══`,
)
process.exit(failedSuites === 0 ? 0 : 1)
