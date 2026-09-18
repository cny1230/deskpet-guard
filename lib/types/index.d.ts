/**
 * deskpet-guard — 宿主侧（host）公开 API 的类型声明。
 *
 * 手写原因：运行时产物 lib/index.js 是零依赖手写 JS（离线可跑），不经 tsc，
 * 所以要手工给消费方（其它插件 / 脚本 / 编辑器）一套类型。改 lib/index.js 的
 * 导出时请同步本文件 —— test/api.test.mjs 与 test/plugin.test.mjs 会盯着行为，
 * 类型层面靠这份声明。
 */

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type MoodKey = 'watching' | 'alert' | 'panic'

export interface Finding {
  ruleId: string
  severity: Severity
  /** 命中的 agent 画像 id（R0/R5 等全局规则可能为空） */
  profileId?: string
  title: string
  evidence: Record<string, unknown>
  /** 'kill' 表示该发现支持"终止进程"处置（仍需两步确认） */
  suggest?: 'kill' | 'warn' | 'info'
}

export interface Mood {
  mood: MoodKey
  headline: string
  worstSeverity: Severity | null
}

export interface BundleArtifact {
  path: string
  bytes: number
  mtimeMs: number
}

export interface ProbeResult {
  atMs: number
  /** 'win32' 才可能有系统探针数据；其余平台会记入 probeErrors */
  platform: 'win32' | 'unsupported'
  probeErrors: string[]
  processes: Array<{ pid: number; name: string; path: string }>
  connections: Array<{ pid: number; processName: string; remoteAddress: string; remotePort: number }>
  dns: Array<{ entry: string; data: string }>
  bundles: BundleArtifact[]
  secrets: BundleArtifact[]
}

export interface KillTarget {
  pid: number
  process?: string
  reason: string
  remote?: string
}

export interface ScanResult {
  probe: ProbeResult
  findings: Finding[]
  mood: Mood
  profiles: AgentProfile[]
  /** 候选处置目标（未签发 token、未执行任何动作） */
  killTargets: KillTarget[]
}

export interface ConfirmPlan {
  requiresConfirmation: true
  /** 处置粒度：一次确认只终止一个目标 */
  policy: 'one-target-per-confirmation'
  action: 'kill'
  targets: KillTarget[]
  targetCount: number
  command: string
  warning: string
  confirmToken: string | null
  confirmTarget?: KillTarget
  note?: string
  error?: string
}

export interface KillResult {
  ok: boolean
  killed?: number[]
  target?: number
  error?: string
}

export interface AgentProfile {
  id: string
  label: string
  processPattern: string
  dataRoots: string[]
  bundlePatterns: string[]
  indexFiles: string[]
  secretFiles: string[]
  egressHostPatterns: string[]
  uploadPathPatterns: string[]
}

export interface GuardStatus {
  atMs: number
  cycles: number
  mood: MoodKey
  headline: string
  worstSeverity: Severity | null
  activeFindings: number
  newEvents: number
  probeErrors: string[]
  agentProcessCount: number
  egressConnections: number
  bundleArtifacts: number
  killTargets: KillTarget[]
  apiBase: string
}

export interface GuardConfig {
  dataDir?: string
  /** 采样周期，最小 5000ms，默认 15000ms */
  intervalMs?: number
  profiles?: AgentProfile[]
  /** 'audit' = 只要预警、拒绝任何终止执行（默认 'execute'） */
  killMode?: 'execute' | 'audit'
  /** 替换采样实现（嵌入式集成 / 离线复算 / 测试）；默认走真实只读探针 */
  scan?: (opts?: { profiles?: AgentProfile[] }) => ScanResult
}

export declare const VERSION: string
export declare const name: 'deskpet-guard'
export declare const inject: string[]

/** 采样一次（纯读：不写事件流、不动任何进程）。 */
export declare function scan(opts?: {
  home?: string
  profiles?: AgentProfile[]
  customProfiles?: AgentProfile[]
  ruleOptions?: Record<string, unknown>
  ps?: string
}): ScanResult

/** 把 findings 落成事件（带去重指纹）。返回本轮新增的事件。 */
export declare function record(
  dataDir: string,
  findings: Finding[],
  seenFingerprints?: Set<string>,
): Array<Finding & { seq: number; atMs: number; fingerprint: string }>

/** 生成"终止建议计划"（不执行、不签 token）。 */
export declare function confirmPlan(scanResult: ScanResult): ConfirmPlan

/** 第一步：为单个目标签发一次性 confirmToken（仍不执行）。 */
export declare function prepareKill(
  dataDir: string,
  scanResult: ScanResult,
  opts?: { targetPid?: number },
): ConfirmPlan

/** 当前待确认计划数量（测试与运维用）。 */
export declare function pendingConfirmations(): number

/** 第二步：校验 token 并执行终止（token 一次性、10 分钟过期）。 */
export declare function killByPids(
  dataDir: string,
  token: string,
  opts?: { secret?: string; exec?: (pids: number[]) => { ok: boolean; error?: string } },
): KillResult

export declare const paths: {
  resolveDataDir: (explicit?: string) => string
  readEvents: (dataDir: string, n?: number) => unknown[]
  readStatus: (dataDir: string) => GuardStatus | null
  writeStatus: (dataDir: string, status: GuardStatus) => boolean
  writeEndpoint: (dataDir: string, info: Record<string, unknown>) => boolean
  readEndpoint: (dataDir: string) => { endpoint: string; apiBase: string } | null
}

/** DSH 插件入口（cordis）：周期采样 + 注册 host 工具 + 挂载本地 HTTP API。 */
export declare function apply(ctx: unknown, config?: GuardConfig): void
