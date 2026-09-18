/**
 * deskpet-guard — 双实现一致性测试。
 *
 * 背景：本机没有 dsh 源码 checkout，tsc 不可用，所以 .ts（权威类型源码）
 * 无法编译成 .js。为保证"可运行镜像"不悄悄偏离"权威源码"，这里用同一批
 * fixture 分别跑两份实现，逐条对比判定结果。
 *
 *   src/guard/rules.ts   + src/guard/profiles.ts   （权威，待编译）
 *   lib/rules.js         + lib/profiles.js         （可运行镜像）
 *
 * 改任何一侧而忘记同步另一侧 → 本测试变红。
 * 运行：node test/consistency.test.mjs
 */
import assert from 'node:assert/strict'

import { evaluate as evalTs, moodOf as moodTs } from '../src/guard/rules.ts'
import { mergeProfiles as mergeTs } from '../src/guard/profiles.ts'
import { evaluate as evalJs, moodOf as moodJs } from '../lib/rules.js'
import { mergeProfiles as mergeJs } from '../lib/profiles.js'

const HOME = 'C:\\Users\\chen'
const T = 1_800_000_000_000

const fixtures = [
  {
    name: '进程存活 + 无外发',
    probe: {
      processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [],
      dns: [],
      bundles: [],
      secrets: [],
    },
  },
  {
    name: 'OSS 直连（关键正例）',
    probe: {
      processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [
        {
          pid: 1,
          processName: 'ZCode.exe',
          remoteAddress: 'oss-cn-beijing.aliyuncs.com',
          remotePort: 443,
        },
      ],
      dns: [],
      bundles: [],
      secrets: [],
    },
  },
  {
    name: 'SLS 日志域名（关键防误报）',
    probe: {
      processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [
        {
          pid: 1,
          processName: 'ZCode.exe',
          remoteAddress: 'proj-x.cn-beijing.log.aliyuncs.com',
          remotePort: 443,
        },
      ],
      dns: [{ entry: 'proj-x.cn-beijing.log.aliyuncs.com', data: '59.110.96.221' }],
      bundles: [],
      secrets: [],
    },
  },
  {
    name: '新鲜加密包 + 密钥触达（斜杠混用路径）',
    probe: {
      processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [],
      dns: [],
      bundles: [
        {
          path: 'C:/Users/chen/.zcode/v2/checkpoints/a042741f8701/pending/x.tar.gz.enc',
          bytes: 26_345_069,
          mtimeMs: T - 30_000,
        },
      ],
      secrets: [
        {
          path: 'C:/Users/chen/.zcode/v2/certs/zcode-network-ca.key',
          bytes: 1702,
          mtimeMs: T - 5_000,
        },
      ],
    },
  },
  {
    name: '成簇刷包',
    probe: {
      processes: [{ pid: 1, name: 'ZCode.exe', path: 'D:\\ZCode\\ZCode.exe' }],
      connections: [],
      dns: [],
      bundles: [0, 1, 2, 3].map((i) => ({
        path: `${HOME}\\.zcode\\v2\\checkpoints\\p${i}\\pending\\y.tar.gz.enc`,
        bytes: 1024,
        mtimeMs: T - i * 1000,
      })),
      secrets: [],
    },
  },
  {
    name: '探针降级',
    probe: { probeErrors: ['Get-NetTCPConnection 探针失败'], platform: 'win32' },
  },
]

const wrap = (p) => ({
  atMs: T,
  platform: 'win32',
  probeErrors: [],
  processes: [],
  connections: [],
  dns: [],
  bundles: [],
  secrets: [],
  ...p,
})

const norm = (fs) =>
  fs
    .map((f) => `${f.ruleId}|${f.severity}|${f.profileId}|${f.suggest}|${f.title}`)
    .sort()

let pass = 0
let fail = 0
const cases = []

for (const fx of fixtures) {
  cases.push([
    `判定一致: ${fx.name}`,
    () => {
      const ts = norm(evalTs(wrap(fx.probe), mergeTs(undefined, HOME)))
      const js = norm(evalJs(wrap(fx.probe), mergeJs(undefined, HOME)))
      assert.deepEqual(js, ts, '.js 与 .ts 判定结果必须逐条一致')
    },
  ])
  cases.push([
    `状态一致: ${fx.name}`,
    () => {
      const a = moodTs(evalTs(wrap(fx.probe), mergeTs(undefined, HOME)))
      const b = moodJs(evalJs(wrap(fx.probe), mergeJs(undefined, HOME)))
      assert.deepEqual(
        { mood: b.mood, headline: b.headline, worstSeverity: b.worstSeverity },
        { mood: a.mood, headline: a.headline, worstSeverity: a.worstSeverity },
      )
    },
  ])
}

for (const [n, f] of cases) {
  try {
    f()
    pass++
    console.log(`  PASS  ${n}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${n}`)
    console.log(`        ${String(e.message).split('\n').slice(0, 3).join(' ')}`)
  }
}
console.log(`\n结果: ${pass} passed, ${fail} failed (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
