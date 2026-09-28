# 安全说明（Security Policy）

## 1. 它能做什么 / 不能做什么

| 能力 | 状态 |
|---|---|
| 只读侦察（进程 / TCP 连接 / DNS 缓存 / 打包产物 / 密钥文件时间戳） | ✅ |
| 规则判定与分级（info → critical） | ✅ |
| 事件流落盘（只追加 `guard-events.jsonl`） | ✅ |
| 把状态暴露给其它 agent（DSH host 工具 / MCP stdio / 本地 HTTP） | ✅ |
| **阻止**另一个进程把数据发出去 | ❌ 做不到（见下） |
| 杀进程 | ⚠️ 仅"两步人工确认 + 一次一个 + 执行前 PID 复用验证"，或配置 `killMode:'audit'` 完全禁用 |

**为什么不能真正阻断**：用户态无法拦截另一个进程的 TLS 出网。可选路径只有三条，且全部越界：

| 方案 | 问题 |
|---|---|
| 杀进程 | 中断正在进行的会话 / 可能损坏未保存编辑 |
| 防火墙 / WFP / hosts | 需要管理员，属于"修改系统" |
| 拦截文件写入（让包根本不生成） | 需要内核驱动 |

所以本项目的强度定位是 **预警 + 一步确认后处置 + 只增的共享事件源**。
把它当"防火墙"用会失望；把它当"案发现场的公告板 + 一支需要人点头的手"用才对。

## 2. 数据边界

- **探针只读**：只用 `Get-*` / `Test-Path` / `readdir` / `stat`。不写被监控 agent 的任何目录。
- **唯一写盘点**：`lib/events.js`，且只写自己的数据目录（默认 `$DSH_HOME/super-injector/deskpet-guard/`，
  可用 `DESKPET_GUARD_DIR` 覆盖）。事件流只追加；单文件超过 5MB 时**改名**归档为 `.1`
  （改名而非删除，历史段仍完整可读），另有状态文件 / 端点文件 / 采样者锁文件，均在本目录内。
- **不碰系统**：不写防火墙 / hosts / 注册表 / 证书存储，不请求管理员权限。
- **不出网**：host 侧不发起任何外部网络请求（只有本地探针 + 本地 HTTP 服务）。

## 3. 本地 HTTP API 的闸门（`lib/api.js`）

面板在浏览器里跑，读不到 host 进程内存，所以必须有一条 HTTP 数据面。它对**本机**开放，因此：

| 端点 | 鉴权 |
|---|---|
| `GET /deskpet-guard/api/status`、`GET /events` | 无（只回采集元数据；永不发 CORS 头） |
| `POST /deskpet-guard/api/scan` | 无（只读重扫） |
| `POST /prepare-kill`、`POST /confirm-kill` | **三重闸门**：自定义头 `x-deskpet-guard: 1` + 同源 `Origin` + `content-type: application/json`；或持 `x-deskpet-guard-secret`（= 数据目录里 0600 的 `confirm-secret.json`） |

- 自定义头 + JSON 会强制浏览器发 CORS 预检；**预检一律 403，且我们从不发 `Access-Control-Allow-Origin`**，
  因此任意网页（含恶意页面）都无法替用户点下"确认终止"。
- `confirm-secret.json` 是同一用户可读的本地文件 —— 本地恶意代码读得到它，
  这一层挡的是**跨站网页**，不是同用户本地攻击者。请按这个前提使用。
- 终止 token 一次性、10 分钟过期、**只对单个 PID**；`confirm-plan` 策略为
  `one-target-per-confirmation`（多目标时一次确认只处理一个，避免误伤）。
- **执行前 PID 复用验证**（0.3.0）：prepare 时固化目标的进程名与创建时间，confirm 时现场
  重查一次进程表，任一对不上即拒绝 —— 防 10 分钟窗口内 PID 被系统回收复用、误杀无辜进程。
  kill 计划同时列出目标子进程（仅展示，不扩大处置范围）。

## 4. 已知弱点（欢迎提 issue / PR）

1. **探针依赖沙箱外的能力**：在受限沙箱里 PowerShell 管道会被拒，系统探针失败 →
   规则 `R0` 会上报"能力降级"（这是**设计如此**：宁可喊"我看不清"，也不假装安全）。
   但请务必读懂 R0 —— 探针全挂时它只能看文件，不能看连接。
2. **DNS 残留在本机实测里是弱证据**：`*.log.aliyuncs.com`（阿里云日志服务）是**反例**，
   已被 `test/rules.test.mjs` 锁死，不得据此判定"工作区被上传"。
3. **画像表偏薄**：目前 zcode / cursor / claude-desktop 三条，只有 zcode 有实证画像。
   不懂的 agent 就是没有画像 —— 这不是 bug，是待办。
4. **文件名匹配是启发式**：`bundlePatterns` 靠文件名/扩展名，攻击者可以改名。
5. **没有基线/白名单学习**：新 agent 一律当陌生进程处理，误报会随安装量上升。
6. **R1 的域名反查依赖本机 DNS 缓存**：DoH / 自建解析会让缓存里没有记录 → 漏报；
   固定出口可在画像里写 IP/CIDR 兜底。缓存是"IP → 曾解析过的域名"的反查，CDN 共享 IP
   理论上可能串出误报 —— R1 的 evidence 永远带 `resolvedHost` 供人工复核。
7. **R4 只能测"写"**：mtime 不反映读取（Windows 默认禁用 last-access 更新）。
   "密钥被读"的检测需要 ETW / Sysmon 级遥测，当前未实现。
8. **单采样者锁是尽力而为**：数据目录锁文件 + 心跳选举，不承诺分布式互斥；
   最坏情形是多个实例各采一轮（多花一次探针开销），不会丢数据。

## 5. 上报安全漏洞

请不要开 public issue。用 GitHub 的 "Report a vulnerability"（Security advisory）私下报告，
或在仓库 issue 里只写"我有一个安全问题，请给个私下渠道"。

请包含：影响面（能否导致误杀 / 越权调用 HTTP 端点 / 事件伪造）、复现步骤、以及你的环境
（Windows 版本、DSH 版本、是否在沙箱内）。
