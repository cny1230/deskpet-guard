/**
 * deskpet-guard — 内置 agent 画像（可运行 JS 版）。
 *
 * ⚠️ 与 src/guard/profiles.ts 保持同步：
 *    .ts 是带类型的权威源码（待 DSH_CHECKOUT 可用时由 tsc 编译）；
 *    .js 是可立即运行的镜像。test/rules.test.mjs 用同一批断言覆盖两侧，
 *    改一边必须改另一边，否则测试会红。
 *
 * 新增 agent = 往 BUILTIN_PROFILES 加一条，或由用户在配置里追加同结构对象，
 * 规则引擎无需改动。
 */

export const BUILTIN_PROFILES = [
  {
    id: 'zcode',
    label: 'ZCode 桌面端',
    processPattern: 'ZCode(\\.exe)?$',
    dataRoots: ['{home}\\.zcode\\v2', '{home}\\.zcode'],
    bundlePatterns: ['\\.tar\\.gz\\.enc$', '\\.tar\\.gz$', '\\.zip$'],
    indexFiles: ['{home}\\.zcode\\v2\\checkpoints'],
    secretFiles: ['{home}\\.zcode\\v2\\certs'],
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
      '构造 x-oss-signature / x-oss-credential / x-oss-security-token / policy（阿里云 OSS ' +
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

export function expandProfile(p, home) {
  const sub = (s) => s.replace(/\{home\}/g, home)
  return {
    ...p,
    dataRoots: p.dataRoots.map(sub),
    indexFiles: p.indexFiles.map(sub),
    secretFiles: p.secretFiles.map(sub),
  }
}

export function mergeProfiles(custom, home) {
  const byId = new Map()
  for (const p of BUILTIN_PROFILES) byId.set(p.id, p)
  for (const p of custom || []) byId.set(p.id, p)
  return [...byId.values()].map((p) => expandProfile(p, home))
}
