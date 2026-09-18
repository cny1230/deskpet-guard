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
| dsh.so artifact 页 | ⏳ 未收录 | `GET https://www.dsh.so/artifact/deskpet-guard/` → 404（索引有周期；也可直接 Submit） |
| npm 包 | ⏳ 未发布 | `package.json` 仍 `"private": true`；registry 上 `deskpet-guard`、`@cny1230/deskpet-guard` 均 404 = 名字空着 |
| MCP 官方 registry | ⏳ 未发布 | 需要已发布的包 + 按其 schema 生成 `server.json` |

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

### 步骤 2：发布到 npm（可选，但很多 MCP 目录要求）

```bash
# ① 先决定名字：@dsh-external 这个 scope 不归你所有，按包名装/发布前建议改成自己的
#    （例：@cny1230/deskpet-guard）—— 这会同时改 package.json、cordis.patch.yml 里的 name、
#     以及 README 里的安装命令，改完必须重跑 npm test（有跨文件一致性守卫）
# ② 去掉 package.json 的 "private": true
# ③ 发布前自检
npm test && npm run check
npm pack --dry-run     # 确认 files 列表带上了 lib/ bin/ docs/ cordis.patch.yml
# ④ 发布
npm login
npm publish --access public
```

发布后即可：`npx deskpet-guard-mcp`（MCP 客户端）与 `dsh plugin --profile web add @<scope>/deskpet-guard`。

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
