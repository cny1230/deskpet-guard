# deskpet-guard —— 市场壳（ZCode / Claude Code 兼容）

这个目录**不是** DSH 插件本体（本体在仓库根的 `lib/`、`bin/`，已发布到 npm 的 `deskpet-guard`）。
它是给 **ZCode / Claude Code 这类"agent 插件市场"**用的薄壳，让同一个能力在那边的市场里
**能被搜到、能一键装**。

## 结构（照 ZCode 官方插件样板）

```
marketplace.json                  # 仓库根：市场清单（本仓库 = 单插件市场）
deskpet-guard/
  .zcode-plugin/plugin.json       # ZCode 原生清单（含 mcpServers）
  .claude-plugin/plugin.json      # Claude Code 兼容清单
  .mcp.json                       # Claude Code 兼容的 MCP 声明
  skills/deskpet-guard/SKILL.md   # 教 agent 何时/如何用这 5 个工具
  README.md                       # 本文件
```

ZCode 找市场清单的顺序（来自其自身代码）：
`<repo>/marketplace.json` → `<repo>/.claude-plugin/marketplace.json`；
插件条目不写 `source` 时，按约定到 `<repo>/<插件名>/` 找插件目录。
插件清单位置它认三种：`.zcode-plugin/`、`.claude-plugin/`、`.codex-plugin/`。

## 能力怎么交付：MCP

壳里没有可执行代码，只有一个 MCP server 声明：

```json
{ "mcpServers": { "deskpet-guard": { "command": "npx", "args": ["-y", "deskpet-guard"] } } }
```

也就是复用已发布的 npm 包（stdio MCP，5 个工具：`guard_status` / `guard_events` / `guard_scan` /
`guard_prepare_kill` / `guard_confirm_kill`）。

**在 ZCode / Claude Code 里能拿到的**：上面 5 个工具 + 这个 skill。

**拿不到的**（那些是 DSH 专属）：DSH host 工具、右下角桌宠、会话侧栏面板（依赖 DSH 的
cordis 插件体系与 client slot）。想让 ZCode 也有桌面通知/面板，是另一件事。

## 安装（ZCode）

「添加插件市场」里填：

```
https://github.com/cny1230/deskpet-guard
```

（ZCode 也支持本地目录：把仓库 clone 下来，在同一个对话框里选目录。）

Windows 上如果 `npx` 起不来，把 `.mcp.json` / `plugin.json` 里的
`command` 改成 `cmd`、`args` 改成 `["/c","npx","-y","deskpet-guard"]` 即可。

## 维护提醒

`plugin.json` / `marketplace.json` 里的 `version` 必须与根 `package.json` 的 `version` 一致，
`test/agent-plugin-wrapper.test.mjs` 会拦不一致（含"插件目录名 = 插件名"这条约定）。
发布新版本时：改三处版本号 → `npm test` → `npm publish` → 推送。
