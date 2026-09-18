/**
 * deskpet-guard — 数据契约层。
 *
 * 本文件只定义类型，不产生任何副作用，便于测试与跨 agent 复用。
 * 设计原则（重要）：
 *  1) 探针只读：所有 Probe 实现必须是无副作用的系统查询；
 *  2) 判断纯函数：规则引擎只看 ProbeResult，不看系统，便于用 fixture 单测；
 *  3) 处置分级：alert（只记录/告警）与 kill（终止进程）严格分离，
 *     kill 必须经过 guard_confirm 的两步确认（session 级 secret）。
 */

/** 一个 agent 的信任画像：描述"谁在跑、东西写在哪、外发长什么样"。 */
export interface AgentProfile {
  /** profile 稳定 id，用于事件归因与 MCP 查询。 */
  id: string
  /** 人类可读名称。 */
  label: string
  /** 进程名匹配（不区分大小写，正则片段，如 'ZCode\\.exe'）。 */
  processPattern: string
  /** 该 agent 的数据根目录（绝对路径，可含 {home} 占位）。 */
  dataRoots: string[]
  /** 疑似"打包产物"的文件名正则（加密包/压缩包）。 */
  bundlePatterns: string[]
  /** 项目/工作区映射文件（用于把包关联到本地目录）。 */
  indexFiles: string[]
  /** 读取它们即视为敏感操作的密钥类文件（仅 hash，不读内容）。 */
  secretFiles: string[]
  /**
   * 外发目标画像：这些域名/后缀一旦出现，按"第三方对象存储直传"处理。
   * 注意：日志/追踪域名（如 *.log.aliyuncs.com）不属于此列，避免误报。
   */
  egressHostPatterns: string[]
  /** 上传/凭证接口路径特征（命中即说明"存在上传通道"）。 */
  uploadPathPatterns: string[]
  /** 该 agent 是否观察到"加密后再外传"的能力（静态证据结论）。 */
  notes?: string
}

/** 一条 TCP 连接（仅外部地址）。 */
export interface ConnRecord {
  pid: number
  processName: string
  remoteAddress: string
  remotePort: number
}

/** 一条 DNS 缓存记录。 */
export interface DnsRecord {
  entry: string
  data: string
}

/** 一个疑似打包产物。 */
export interface BundleFile {
  path: string
  bytes: number
  mtimeMs: number
}

/** 一个敏感文件的"触达"记录（只有摘要，绝不含内容）。 */
export interface SecretTouch {
  path: string
  bytes: number
  mtimeMs: number
}

/** 一次采样的完整结果（规则引擎的唯一输入）。 */
export interface ProbeResult {
  atMs: number
  /** 运行平台，探针不可用时为 'unsupported'。 */
  platform: 'win32' | 'unsupported'
  /** 探针执行失败信息（例如沙箱拒绝），非空不阻断判断。 */
  probeErrors: string[]
  processes: Array<{ pid: number; name: string; path: string }>
  connections: ConnRecord[]
  dns: DnsRecord[]
  bundles: BundleFile[]
  secrets: SecretTouch[]
}

export type Severity = 'info' | 'medium' | 'high' | 'critical'

/** 一条判定结果。 */
export interface Finding {
  ruleId: string
  severity: Severity
  profileId: string
  title: string
  /** 结构化证据（可序列化，用于 MCP 与面板展示）。 */
  evidence: Record<string, string | number>
  /** 建议动作：仅告警，或建议终止进程（需用户确认）。 */
  suggest: 'alert' | 'kill'
}

/** 事件流记录（只追加 jsonl）。 */
export interface GuardEvent extends Finding {
  seq: number
  atMs: number
}
