---
name: deskpet-guard
description: Use when the user asks whether any AI agent on this Windows machine is uploading or leaking data (packed workspace bundles, object-storage egress, secret files being touched), asks for an exfiltration / data-loss check, or wants to audit recent suspicious-egress alerts. Also use before recommending killing an agent process — the guard's termination flow is two-step and human-confirmed.
---

# deskpet-guard（agent 外传行为守护）

只读探针 + 规则分级 + 只追加事件流。**它不是防火墙**：用户态无法阻断另一个进程的 TLS 出网，
所以它的定位是"预警 + 一步人工确认后处置 + 可被其它 agent 查询的公共事件源"。

数据目录（默认）：`%USERPROFILE%\.dsh\super-injector\deskpet-guard\`
- `guard-status.json` —— 最近一次采样快照
- `guard-events.jsonl` —— 只追加的事件流
- `confirm-secret.json` —— 处置确认密钥（0600）
- `endpoint.json` —— 本机 HTTP API 端点（若 DSH 宿主在跑）

## 工具（MCP）

| 工具 | 何时用 |
|---|---|
| `guard_status` | 想知道"现在什么情况"：agent 进程数、外发连接数、打包产物数、探针健康度、最坏级别、候选处置目标 |
| `guard_events` | 想看**历史**（`limit` 默认 20）：最近有哪些告警 |
| `guard_scan` | 想要**此刻**的重新采样（不等宿主的 15s 周期），返回 mood / findings / targets |
| `guard_prepare_kill` | 发现 `critical` 后，为**单个** PID 生成待确认计划 → 返回 `confirmToken`（**不执行**） |
| `guard_confirm_kill` | 带 `confirmToken` 执行终止（token 一次性、10 分钟过期） |

## 铁律（违反就是误报或误伤）

1. **`info` 级不是证据**：`R5-dns-object-storage-residue`（DNS 缓存残留对象存储域名）与
   `R6-agent-alive-quiet`（进程存活）只是线索/状态。反例：`*.log.aliyuncs.com` 是**日志服务**，
   不得据此说"工作区被上传"。
2. **`R0-probe-degraded` 必须如实转述**：探针失败意味着**判定能力不完整**，
   要告诉用户"我看不清进程/连接侧"，**绝不能**说成"没有风险"。
3. **终止必须由人确认**：你可以调 `guard_prepare_kill` 拿计划与 token，但**不要自己调**
   `guard_confirm_kill` —— 把 token 连同"这是一次不可逆的杀进程操作"交给用户；
   一次确认只终止一个目标。
4. **区分规则级别**：`critical`（R1 直连对象存储，建议终止）→ 处置流程；
   `high`（R2 打包产物 / R3 成簇刷包）→ 先调查再建议；`medium`（R0 探针降级 / R4 密钥被写）→ 提醒。

## 建议的排查流程

1. `guard_status` —— 看 mood / 探针错误 / 候选目标；
2. 有 `critical` 或用户想细看 → `guard_events`（历史）或 `guard_scan`（重扫）；
3. 需要处置 → `guard_prepare_kill`（指定 `targetPid`）→ **把 warning + token 原文交给用户**；
4. 用户明确同意后，由用户（或在他点头后）执行 `guard_confirm_kill`。

## 环境与已知限制

- **探针只在 Windows 有实现**；其它平台会如实上报 `unsupported`。
- 受限沙箱里 PowerShell 管道可能被拒 → 三个系统探针（进程 / TCP / DNS）会失败，
  此时 `R0` 上报降级；**文件类探针仍有效**（打包产物、密钥文件时间戳）。
- host（DSH 宿主）不在运行时，只读工具会降级：读落盘快照或在本进程内采样；
  终止类工具会**明确拒绝**（不会凭空签一个宿主不认的 token）。
- 想让它在没有 DSH 的情况下也持续采样，需要一个常驻采样器（`node bin/…` 定时跑）；
  当前仓库提供的是"按需扫描 + 读取已有事件流"。
