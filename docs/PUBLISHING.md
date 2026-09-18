# 发布与收录（怎么让它在插件市场里被搜到、被一键装）

本文件记录**当前实际的发布状态**与**剩余步骤**，避免"以为已经上架了"。
有依据的事实都标了来源；没核实的会写"待核实"。

## 1. 现状

| 渠道 | 状态 | 依据 |
|---|---|---|
| GitHub 仓库（public） | ✅ 已发布 | <https://github.com/cny1230/deskpet-guard> |
| `dsh plugin --profile web add github:cny1230/deskpet-guard` | ✅ 可用 | 本包带 `cordis.patch.yml` + `dsh.bundle.patch`（`test/client-bundle.test.mjs` 有守卫） |
| GitHub topics（9 个，含 `dsh-plugin`） | ✅ 已打 | `GET /repos/cny1230/deskpet-guard` 回读可见 |
| GitHub 搜索索引 | ✅ 已索引 | `search/repositories?q=repo:cny1230/deskpet-guard` 命中 1 条，带全部 topics |
| dsh.so 收录 | ✅ **已提交**（2026-09-18） | 用 dsh.so 自己的提交页跑完 checker 后点 `Submit to dsh.so`，`POST /api/submit` → **HTTP 200**、页面 `✓ Submitted`；该站明说"files the registry entry and scan report as an issue in the dsh.so backend via the site API — no GitHub account required"。`/artifact/deskpet-guard/` 仍 404 = 站点静态重建尚未跑 |
| npm 包 | ✅ **已发布** | [`deskpet-guard@0.1.0`](https://www.npmjs.com/package/deskpet-guard)（BSD-3-Clause / maintainer `cny1230`）；实测 `npx -y deskpet-guard` 从 npm 拉下来跑通 MCP（initialize + 5 工具）。发布过程与踩到的 2FA 坑见下 |
| MCP 官方 registry | ⏳ 未发布 | 需要已发布的包 + 按其 schema 生成 `server.json` |

### dsh.so checker 对我们的实测结论（2026-09-18，提交时同批上报）

- **FORMAT VALIDATION：Pass**（5/5）—— 公共活跃仓库 / 有 README / SPDX 许可 BSD-3-Clause /
  `package.json` 声明了 dsh manifest（识别为 `dshManifest: "bundle"`）/ 名字能 slug 成合法 id
- **SECURITY SCAN：Warn** —— 0 Critical、15 Warnings、35 Info，扫描 33 个文件
  - 主要是启发式告警：7 处"HTTP request to a raw IP"（其实是我们自己的 `127.0.0.1:<port>` 本机端点）、
    3 处 `execFileSync`（只读 PowerShell 探针 + 两步确认后的终止动作）、若干 `process.env` 读取与测试文件里的 child_process（dev-only 已降级）
  - 该站规则：只有 critical 阻塞提交；warning 需人工复核 —— 不阻塞，但会显示在条目上

## 2. 收录规则（dsh.so 一类 DSH 注册中心）

来自 <https://www.dsh.so/submit/> 与 <https://awesome-dsh-plugin.com> 页面正文：

- 仓库打 **GitHub topic `dsh-plugin`** → 注册中心**自动索引**（参考官方仓库 `deepseek-ai/deepseek-harness` 也带这个 topic）；
- README 有安装说明 ✔
- 开源许可带可识别的 **SPDX 标识**（本仓库 `BSD-3-Clause`）✔
- **合法的 cordis / agent manifest**（即 `package.json` 的 `dsh.bundle.patch` + patch 文件）✔
- 能被验证的 install 命令（`dsh plugin --profile web add …`）✔
- 只提交"仓库链接"而不是指定安装命令的条目，可豁免 install 验证梯度（但会走安全扫描）

**排序现实**：`topic:dsh-plugin` 下有 1.5 万个仓库，列表按匹配度/star 排序 ——
0★ 的新仓库不会出现在首页，但"按名字搜索"能找到。想被看见，靠 Submit + 时间 + star。

## 3. 剩余步骤

### 步骤 1：提交收录（dsh.so / awesome-dsh-plugin）

dsh.so 的 Submit 表单只要两项：**仓库 URL**（占位符就是 `https://github.com/owner/repo`）
+ 条目类型（dsh plugin / 桌面应用…）。填：

```
https://github.com/cny1230/deskpet-guard
```

awesome-dsh-plugin / dsh-plugin-hub 一类清单站：按其 README 的 PR 格式加一行（通常 = 名称 + 一句话 + 仓库链接 + 安装命令）。

### 步骤 2：发布到 npm —— ✅ 已完成（2026-09-18）

**已发布**：[`deskpet-guard@0.1.0`](https://www.npmjs.com/package/deskpet-guard)（BSD-3-Clause，maintainer `cny1230`）。

发布前做的准备（改包名时一并完成）：

- 包名从 `@dsh-external/deskpet-guard`（该 scope 不归作者，发不了）改为**不带 scope 的 `deskpet-guard`**；
- 删 `"private": true`；加 `publishConfig`（`registry: https://registry.npmjs.org/` + `access: public`）
  —— 关键：本机 `~/.npmrc` 指向 npmmirror 镜像，靠 `publishConfig.registry` 才能确保推到官方源；
- 加 `prepublishOnly`（发布前自动跑全套测试 + 语法自检）；
- 改名连带改过 4 处引用：`package.json`、`cordis.patch.yml`、`lib/client.js` 的 ModuleLoader `id`、
  `lib/index.js` 与 `lib/types` 的 `name` 导出（`test/client-bundle.test.mjs` 按 `pkg.name` 断言，防漂移）。

**实际发布时踩到的坑（值得记住）**：

1. 作者账号开了 2FA 写保护。npm 11 的 `npm login` 走 web 流程，落地的是
   **granular access token**，它**不带 bypass 2FA**，所以 `npm publish --otp=<码>` 依然 403：
   `Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。
2. 正解：到 <https://www.npmjs.com/settings/<user>/tokens> → Generate New Token →
   **Granular token 里勾上 `Bypass two-factor authentication (2FA)`**（或 Classic → Automation），
   权限给 **Read and write (publish and stage)**，包范围 **All packages**（包还不存在时没法按包名指定），
   过期时间设短；
   ```bash
   npm config set //registry.npmjs.org/:_authToken=npm_xxxx
   npm config delete _auth          # 清掉 npm login 留下的旧凭据键
   npm publish                      # publishConfig 已指定源与 public access
   ```
3. 官方文档口径：*"All packages now require two-factor authentication (2FA) or a granular access token
   with bypass 2FA enabled for creating and publishing packages."*
   （[npm Docs](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)）
   注意 **2026-08 起 bypass-2FA token 不能用于账号身份/治理类操作**（发布不受影响），
   而 **2027-01 起 bypass token 直连发布会被禁** —— 所以后续版本建议改用
   [Trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers)（GitHub Actions 无凭据发布）。

**发布后验证（实测）**：

```bash
npm view deskpet-guard            # 0.1.0 / BSD-3-Clause / bin: deskpet-guard + deskpet-guard-mcp
printf '<initialize + tools/list>\n' | npx -y deskpet-guard
# → 2 条响应：initialize（deskpet-guard v0.1.0 / protocol 2025-06-18）+ tools/list（5 个工具）
```

发布后即可：`npx deskpet-guard`（MCP 客户端）与 `dsh plugin --profile web add deskpet-guard`。

### 下一个版本怎么发（当前采用：手动 + bypass token）

作者 2026-09 的决定是**先用 token 手动发**，暂不接 OIDC。流程：

1. **改版本号（两处必须一致，有测试拦）**：`package.json` 的 `version`
   与 `lib/index.js` 的 `export const VERSION`（`test/plugin.test.mjs` 里那条 `VERSION 与 package.json 一致`）；
2. 跑自检：`npm test`（9 套件 / 127 例）+ `npm run check`（`prepublishOnly` 发布前还会再跑一遍）；
3. 提交推送并等 CI 绿：`git push` → GitHub Actions；
4. 发布：`npm publish`（`~/.npmrc` 里已有 bypass token；若已 revoke，按上面"步骤 2"重新配一个）；
5. 发布后验证：`npm view deskpet-guard version`、`npx -y deskpet-guard@<新版本>`；
6. 顺手打 tag：`git tag v<版本> && git push --tags`（本次首发没打，可从 `v0.1.0` 补起）。

> 什么时候该换成 OIDC：npm 已宣布 **2027-01 起 bypass-2FA token 不能直连发布**。
> 到那时（或你不想再留这种强权限 token 时）再加 `.github/workflows/release.yml`：
> `permissions: id-token: write` + `npm publish`，并在 npm 包设置里把 trusted publisher
> 指到 `cny1230/deskpet-guard`。包已存在，所以现在就能配置。

### 步骤 3：MCP 官方注册中心（可选）

入口与政策见 <https://modelcontextprotocol.io/registry/faq>。
流程要求"已发布的包 + 一个 `server.json`"，且 server.json 的 schema 是 `$ref` 结构、
字段随版本演进 —— **发布时用官方工具生成，别手抄**（本仓库不预置可能过期的 server.json）。

## 4. 发布前自检清单

- [ ] `npm test` 全绿（9 套件 / 127 例）+ `npm run check`
- [ ] CI 绿（GitHub Actions：ubuntu + windows × node 22/24）
- [ ] `package.json` 版本号 == `lib/index.js` 的 `VERSION`（有测试锁）
- [ ] `npm pack --dry-run` 的文件列表包含 `cordis.patch.yml`（漏了 → 装上也跑不起来）
- [ ] 仓库里没有密钥/凭据（事件流与 `confirm-secret.json` 只应存在于数据目录 `~/.dsh/…`，不进仓库）
- [ ] README 的安装命令与实际包名一致（改 scope 时最容易漏）

## 5. 两条安装路径（别同时用）

| 路径 | 命令 | 适用 |
|---|---|---|
| 标准（等同市场一键装） | `dsh plugin --profile web add github:cny1230/deskpet-guard` | 普通用户 |
| 注入器（开发热重载） | `dev_inject_plugin {"dir":"D:/deskpet-guard"}` | 改代码时 |

同时用会让插件被加载两次（工具重名、面板重复）。切换前先
`dev_uninject_plugin {"match":"deskpet-guard"}`。
