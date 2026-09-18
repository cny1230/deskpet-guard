# 用 MCP 接别的 agent

deskpet-guard 除了在 DSH 里当插件跑，还暴露一个 **MCP server（stdio）** ——
这样 Claude Desktop / Cline / 别的 agent 都能"搜到并用"它的事件流与状态。

## 1. 启动方式

```bash
node D:/deskpet-guard/bin/deskpet-guard-mcp.js
# 等价：npx 式调用（未发布到 npm，请用绝对路径）
```

自检（不用 MCP 客户端）：

```bash
node lib/mcp.js --list                       # 数据目录 / host 端点 / 是否找到 secret / 工具清单
node lib/mcp.js --call guard_status          # 直接调一次
node lib/mcp.js --call guard_events '{"limit":5}'
```

## 2. 客户端配置

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "deskpet-guard": {
      "command": "node",
      "args": ["D:/deskpet-guard/bin/deskpet-guard-mcp.js"]
    }
  }
}
```

### Cline / 其它 MCP 客户端（通用片段）

```json
{
  "mcpServers": {
    "deskpet-guard": {
      "command": "node",
      "args": ["D:/deskpet-guard/bin/deskpet-guard-mcp.js"],
      "env": {
        "DESKPET_GUARD_DIR": "C:/Users/<you>/.dsh/super-injector/deskpet-guard"
      }
    }
  }
}
```

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DESKPET_GUARD_DIR` | 数据目录（读 `guard-status.json` / `guard-events.jsonl` / `confirm-secret.json`） | `$DSH_HOME/super-injector/deskpet-guard` |
| `DESKPET_GUARD_ENDPOINT` | host API 基址 | 读 `endpoint.json`，退到 `http://127.0.0.1:3080` |
| `DESKPET_GUARD_SECRET` | 确认密钥（覆盖 0600 文件里的值） | 数据目录下 `confirm-secret.json` |

## 3. 工具

| 工具 | 类型 | 说明 |
|---|---|---|
| `guard_status` | 只读 | 状态快照：agent 进程数、外发连接数、打包产物数、探针健康度、最坏等级、候选处置目标 |
| `guard_events` | 只读 | 最近事件（`limit`，默认 20，上限 500） |
| `guard_scan` | 只读 | 立刻重扫一次（不与后台 15s 周期争抢；不写事件流） |
| `guard_prepare_kill` | 变更 | 为**单个** PID 生成待确认计划 → 返回 `confirmToken`（不执行） |
| `guard_confirm_kill` | 变更 | 带 `confirmToken` 执行终止（token 一次性、10 分钟过期） |

工具名与 DSH host 侧 `ctx.tools.register` 的名字**一一对应**，
`test/mcp.test.mjs` 会检查这条一致性（名字漂了就等于两套 API）。

## 4. 降级语义（重要）

MCP 进程通常与 DSH 是**两个进程**，它拿不到 host 内存里的 token，所以：

- 优先走 host 的本地 HTTP API（单一事实源，token 也在 host 里签发/核销）；
- host 不可达时：`guard_status` / `guard_events` / `guard_scan` **降级本地**
  （读落盘快照、或在本进程内采样），返回里会带 `[降级]` 提示；
- host 不可达时：`guard_prepare_kill` / `guard_confirm_kill` **明确拒绝** ——
  绝不本地签一个 host 不认的 token（那样不是"降级"，是"假装能杀"）。

## 5. 给 agent 的安全建议（可直接抄进系统提示）

> 你接入了 deskpet-guard。规则：
> ① 看到 `critical`（R1：agent 进程连向对象存储）先 `guard_status` 拿候选目标，
> 再 `guard_prepare_kill` 把 `confirmToken` 交给**人**；
> ② **不要**自己调 `guard_confirm_kill` —— 终止进程会中断用户正在进行的会话；
> ③ `info` 级（R5 DNS 残留 / R6 进程存活）不是外传证据，不要据此下结论；
> ④ 看到 `R0-probe-degraded` 要如实告诉用户"判定能力不完整"，不要说"没有风险"。
