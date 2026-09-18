/**
 * deskpet-guard — 规则引擎离线测试（零依赖，不启动任何服务、不写任何系统位置）。
 *
 * 运行：node test/rules.test.mjs
 * Node 24 原生支持 TS 类型擦除，可直接 import .ts 源码，无需编译。
 */
import assert from 'node:assert/strict'
import { evaluate, moodOf, DEFAULT_RULE_OPTIONS } from '../src/guard/rules.ts'
import { mergeProfiles } from '../src/guard/profiles.ts'

const HOME = 'C:\\Users\\chen'
const profiles = mergeProfiles(undefined, HOME)
const T = 1_800_000_000_000

const proc = (name, path, pid) => ({ name, path, pid })
const conn = (pid, remoteAddress, processName = 'ZCode.exe', remotePort = 443) => ({
  pid,
  processName,
  remoteAddress,
  remotePort,
})
const baseProbe = (over = {}) => ({
  atMs: T,
  platform: 'win32',
  probeErrors: [],
  processes: [],
  connections: [],
  dns: [],
  bundles: [],
  secrets: [],
  ...over,
})

let pass = 0
let fail = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

// ── 1. 所有规则共享的输入，必须能命中 ZCode 画像的进程 ──
test('R6: ZCode 进程被识别，且报告外发连接数', () => {
  const fs = evaluate(
    baseProbe({ processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 20940)] }),
    profiles,
  )
  const r6 = fs.find((f) => f.ruleId === 'R6-agent-alive-quiet')
  assert.ok(r6, '应有 R6 存活记录')
  assert.equal(r6.profileId, 'zcode')
  assert.equal(r6.evidence.processCount, 1)
  assert.equal(r6.evidence.egressConnections, 0)
})

// ── 2. R1 正向：agent 连到阿里云 OSS → critical + 建议终止 ──
test('R1: ZCode 连向 oss-cn-*.aliyuncs.com → critical + kill', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 20940)],
      connections: [conn(20940, 'oss-cn-beijing.aliyuncs.com')],
    }),
    profiles,
  )
  const r1 = fs.find((f) => f.ruleId === 'R1-agent-to-object-storage')
  assert.ok(r1, '应命中 R1')
  assert.equal(r1.severity, 'critical')
  assert.equal(r1.suggest, 'kill')
  assert.equal(r1.profileId, 'zcode')
})

// ── 3. R1 反向：连接属于别的进程时，不得误判到 ZCode 头上 ──
test('R1 负例: 其它进程连 OSS 不应归因给 ZCode', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 20940)],
      connections: [conn(99999, 'oss-cn-beijing.aliyuncs.com', 'msedge.exe')],
    }),
    profiles,
  )
  assert.equal(fs.find((f) => f.ruleId === 'R1-agent-to-object-storage'), undefined)
})

// ── 4. 关键的防误报：阿里云"日志服务"域名不是对象存储，不得报 critical ──
test('R1 防误报: *.log.aliyuncs.com（SLS 日志）不得判为对象存储直传', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 20940)],
      connections: [
        conn(20940, 'proj-xtrace-abc.cn-beijing.log.aliyuncs.com', 'ZCode.exe'),
      ],
      dns: [{ entry: 'proj-xtrace-abc.cn-beijing.log.aliyuncs.com', data: '59.110.96.221' }],
    }),
    profiles,
  )
  assert.equal(fs.find((f) => f.ruleId === 'R1-agent-to-object-storage'), undefined)
  assert.equal(fs.find((f) => f.ruleId === 'R5-dns-object-storage-residue'), undefined)
  assert.equal(moodOf(fs).mood, 'watching', '不应因日志域名进入告警态')
})

// ── 5. 其它对象存储也覆盖（S3 / COS）──
test('R1 覆盖: S3 与腾讯云 COS 同样命中', () => {
  for (const host of [
    'bucket.s3.us-east-1.amazonaws.com',
    'mybucket-1250000000.cos.ap-shanghai.myqcloud.com',
  ]) {
    const fs = evaluate(
      baseProbe({
        processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
        connections: [conn(1, host)],
      }),
      profiles,
    )
    assert.ok(
      fs.find((f) => f.ruleId === 'R1-agent-to-object-storage'),
      `应命中: ${host}`,
    )
  }
})

// ── 6. R2 正向：新鲜 .tar.gz.enc → high ──
test('R2: 新出现的 .tar.gz.enc → high', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      bundles: [
        {
          path: `${HOME}\\.zcode\\v2\\checkpoints\\a042741f8701\\pending\\09de.69da.1789.tar.gz.enc`,
          bytes: 26_345_069,
          mtimeMs: T - 60_000,
        },
      ],
    }),
    profiles,
  )
  const r2 = fs.find((f) => f.ruleId === 'R2-fresh-bundle-artifact')
  assert.ok(r2, '应命中 R2')
  assert.equal(r2.severity, 'high')
  assert.equal(r2.evidence.sizeHuman, '25.1 MB')
})

// ── 7. R2 负例：包不在该 agent 的数据根下 → 不归因 ──
test('R2 负例: 数据根之外的 .enc 不归因给 ZCode', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      bundles: [{ path: 'C:\\backup\\mine.tar.gz.enc', bytes: 100, mtimeMs: T - 1000 }],
    }),
    profiles,
  )
  assert.equal(fs.find((f) => f.ruleId === 'R2-fresh-bundle-artifact'), undefined)
})

// ── 8. R2 负例：旧包不算"新鲜" ──
test('R2 负例: 超出新鲜窗口的旧包不报', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      bundles: [
        {
          path: `${HOME}\\.zcode\\v2\\checkpoints\\x\\pending\\old.tar.gz.enc`,
          bytes: 1,
          mtimeMs: T - DEFAULT_RULE_OPTIONS.freshBundleMs - 1,
        },
      ],
    }),
    profiles,
  )
  assert.equal(fs.find((f) => f.ruleId === 'R2-fresh-bundle-artifact'), undefined)
})

// ── 9. R3：成簇刷包 ──
test('R3: 5 分钟内 3 个包 → high', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      bundles: [0, 1, 2].map((i) => ({
        path: `${HOME}\\.zcode\\v2\\checkpoints\\p${i}\\pending\\x.tar.gz.enc`,
        bytes: 1024,
        mtimeMs: T - i * 1000,
      })),
    }),
    profiles,
  )
  assert.ok(fs.find((f) => f.ruleId === 'R3-bundle-burst'))
})

// ── 10. R4：证书私钥最近被写入 ──
test('R4: certs 目录下密钥最近被改动 → medium', () => {
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      secrets: [
        { path: `${HOME}\\.zcode\\v2\\certs\\zcode-network-ca.key`, bytes: 1702, mtimeMs: T - 5000 },
      ],
    }),
    profiles,
  )
  assert.ok(fs.find((f) => f.ruleId === 'R4-secret-file-touched'))
})

// ── 11. 探针降级必须显式上报（否则是"假安全"）──
test('R0: 非 Windows 平台 → 上报盲区且 mood 进入 alert', () => {
  const fs = evaluate(
    baseProbe({ platform: 'unsupported', probeErrors: ['pwsh not found'] }),
    profiles,
  )
  const r0 = fs.find((f) => f.ruleId === 'R0-probe-degraded')
  assert.ok(r0, '应上报探针降级')
  assert.equal(moodOf(fs).mood, 'alert')
})

// ── 12. mood 口径 ──
test('mood: 无发现=watching，critical=panic', () => {
  assert.equal(moodOf([]).mood, 'watching')
  const fs = evaluate(
    baseProbe({
      processes: [proc('ZCode.exe', 'D:\\ZCode\\ZCode.exe', 1)],
      connections: [conn(1, 'oss-cn-hangzhou.aliyuncs.com')],
    }),
    profiles,
  )
  const m = moodOf(fs)
  assert.equal(m.mood, 'panic')
  assert.equal(m.worstSeverity, 'critical')
})

// ── 13. 用户自定义 agent 画像可扩展（跨 agent 通用性的核心验证）──
test('扩展性: 用户自定义 profile 无需改规则代码即可生效', () => {
  const custom = mergeProfiles(
    [
      {
        id: 'my-agent',
        label: 'MyAgent',
        processPattern: 'myagent(\\.exe)?$',
        dataRoots: [`${HOME}\\AppData\\MyAgent`],
        bundlePatterns: ['\\.bundle$'],
        indexFiles: [],
        secretFiles: [],
        egressHostPatterns: ['upload\\.myagent\\.example\\.com'],
        uploadPathPatterns: [],
      },
    ],
    HOME,
  )
  const fs = evaluate(
    baseProbe({
      processes: [proc('myagent.exe', 'C:\\x\\myagent.exe', 777)],
      connections: [conn(777, 'upload.myagent.example.com', 'myagent.exe')],
      bundles: [
        { path: `${HOME}\\AppData\\MyAgent\\a.bundle`, bytes: 2048, mtimeMs: T - 1000 },
      ],
    }),
    custom,
  )
  assert.ok(fs.find((f) => f.ruleId === 'R1-agent-to-object-storage' && f.profileId === 'my-agent'))
  assert.ok(fs.find((f) => f.ruleId === 'R2-fresh-bundle-artifact' && f.profileId === 'my-agent'))
})

// ── 执行 ──
for (const [name, fn] of cases) {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${String(e.message).split('\n')[0]}`)
  }
}
console.log(`\n结果: ${pass} passed, ${fail} failed (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
