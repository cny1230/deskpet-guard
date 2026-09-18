/**
 * 内置 agent 画像表 —— 这是"跨 agent 通用"的扩展点。
 *
 * 新增一个 agent = 往这个数组加一条定义（或由用户在配置里追加 JSON），
 * 规则引擎本身不需要改一行代码。
 *
 * 关于 egressHostPatterns 的口径（避免误报，务必注意）：
 *   只把"对象存储/文件托管"类域名算作外发目标。
 *   反例：`*.log.aliyuncs.com` 是阿里云日志服务，属于遥测而非工作区外传，
 *        实测在本机 DNS 缓存中出现过，但**不能**据此判定"工作区被上传"。
 *   本仓库对 ZCode 的判定依据是代码级证据（见 profiles 中 zcode 的 notes）。
 */
import type { AgentProfile } from './types.js'

export const BUILTIN_PROFILES: AgentProfile[] = [
  {
    id: 'zcode',
    label: 'ZCode 桌面端',
    processPattern: 'ZCode(\\.exe)?$',
    dataRoots: ['{home}\\.zcode\\v2', '{home}\\.zcode'],
    // 实测产物形态：<manifestHash>.<extraHash>.<epochMs>.tar.gz.enc
    bundlePatterns: ['\\.tar\\.gz\\.enc$', '\\.tar\\.gz$', '\\.zip$'],
    indexFiles: ['{home}\\.zcode\\v2\\checkpoints'],
    secretFiles: ['{home}\\.zcode\\v2\\certs'],
    // 对象存储直传目标（OSS/S3/COS 等）；不含日志/追踪域名
    egressHostPatterns: [
      'oss-cn-[a-z0-9-]+\\.aliyuncs\\.com',
      '[a-z0-9-]+\\.oss-[a-z0-9-]+\\.aliyuncs\\.com',
      's3[.-][a-z0-9-]+\\.amazonaws\\.com',
      'cos\\.[a-z0-9-]+\\.myqcloud\\.com',
    ],
    uploadPathPatterns: [
      '/api/v1/snapshot/upload-credential',
      'uploadOssForm',
      'repo-snapshot-upload',
    ],
    notes:
      '静态证据（2026-09-18 实测）：app.asar 内含 uploadOssForm/buildOssFormFields，' +
      '构造 x-oss-signature / x-oss-credential / x-oss-security-token / policy 字段（阿里云 OSS ' +
      'PostObject + STS 直传），凭证取自 /api/v1/snapshot/upload-credential；' +
      'state.json 含 pendingUpload / uploadCredentialHandle；工作区先 tar.gz 再 AES-256-CTR 加密。',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    processPattern: 'Cursor(\\.exe)?$',
    dataRoots: ['{home}\\.cursor'],
    bundlePatterns: ['\\.tar\\.gz\\.enc$', '\\.zip$'],
    indexFiles: [],
    secretFiles: ['{home}\\.cursor\\*.key'],
    egressHostPatterns: [
      's3[.-][a-z0-9-]+\\.amazonaws\\.com',
      'storage\\.googleapis\\.com',
    ],
    uploadPathPatterns: [],
    notes: '仅提供基础进程与外发画像；未在本机验证过具体上传链路。',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop / Claude Code',
    processPattern: 'claude(\\.exe)?$',
    dataRoots: ['{home}\\.claude', '{home}\\AppData\\Roaming\\Claude'],
    bundlePatterns: ['\\.zip$'],
    indexFiles: [],
    secretFiles: ['{home}\\.claude\\.credentials.json'],
    egressHostPatterns: [],
    uploadPathPatterns: [],
    notes: '默认无对象存储直传画像；如需监控其自有上传域，请在配置中追加。',
  },
]

/** 把 profile 里的 {home} 占位替换为真实 home 目录。 */
export function expandProfile(p: AgentProfile, home: string): AgentProfile {
  const sub = (s: string): string => s.replace(/\{home\}/g, home)
  return {
    ...p,
    dataRoots: p.dataRoots.map(sub),
    indexFiles: p.indexFiles.map(sub),
    secretFiles: p.secretFiles.map(sub),
  }
}

/** 合并内置与用户自定义画像：同 id 时用户定义覆盖内置。 */
export function mergeProfiles(
  custom: AgentProfile[] | undefined,
  home: string,
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>()
  for (const p of BUILTIN_PROFILES) byId.set(p.id, p)
  for (const p of custom ?? []) byId.set(p.id, p)
  return [...byId.values()].map((p) => expandProfile(p, home))
}
