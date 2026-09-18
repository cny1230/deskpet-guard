/**
 * deskpet-guard — 「agent 插件市场壳」一致性测试。
 *
 * 背景：本仓库除了是 DSH 插件（cordis）与 npm 包，还兼作 ZCode / Claude Code 的
 * **单插件市场**（`marketplace.json` + `<插件名>/.zcode-plugin/plugin.json`）。
 * 那套清单是**另一个生态的格式**，我们没有编译器与 schema 校验，只能靠测试盯住
 * "结构没写歪、版本没漂、MCP 指向的包名没写错"——否则用户点一下"添加插件市场"就报
 * "Marketplace manifest not found" 或装上不工作。
 *
 * 结构依据（从其自身代码/官方插件样板读出，非猜测）：
 *   · ZCode 找清单： <repo>/marketplace.json → <repo>/.claude-plugin/marketplace.json
 *   · 插件清单位置： .zcode-plugin/plugin.json / .claude-plugin/plugin.json / .codex-plugin/plugin.json
 *   · 插件条目无 source 时 → <repo>/<插件名>/
 *   · plugin.json 顶层字段：name/version/description/author/license/skills/commands/mcpServers/userConfig
 *   · skill 文件： skills/<名字>/SKILL.md，frontmatter 需 name + description
 *
 * 运行：node test/agent-plugin-wrapper.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const ROOT = new URL('..', import.meta.url)
const p = (rel) => fileURLToPath(new URL(rel, ROOT))
const readJson = (rel) => {
  assert.ok(existsSync(p(rel)), '缺文件: ' + rel)
  return JSON.parse(readFileSync(p(rel), 'utf8'))
}
const pkg = readJson('package.json')

test('仓库根有 marketplace.json（ZCode 找清单的第一顺位）', () => {
  const m = readJson('marketplace.json')
  assert.equal(typeof m.name, 'string')
  assert.ok(m.name.trim().length > 0, 'marketplace 缺 name')
  assert.ok(Array.isArray(m.plugins) && m.plugins.length > 0, 'marketplace 缺 plugins[]')
})

test('marketplace 里恰好列出本插件，且 name 与包名一致', () => {
  const m = readJson('marketplace.json')
  const names = m.plugins.map((x) => x.name)
  assert.ok(names.includes(pkg.name), 'plugins[] 里没有 ' + pkg.name + '（有: ' + names.join(',') + '）')
  const entry = m.plugins.find((x) => x.name === pkg.name)
  assert.equal(entry.version, pkg.version, 'marketplace 条目 version 与 package.json 不一致')
  // 不写 source → ZCode 回退到 <repo>/<插件名>/；写了别的形式得确认路径存在
  if (entry.source && entry.source.path) {
    assert.ok(existsSync(p(entry.source.path)), 'source.path 指向不存在的目录: ' + entry.source.path)
  }
})

test('插件目录名 = 插件名（ZCode 的本地回退约定 <repo>/<name>/）', () => {
  assert.ok(existsSync(p(pkg.name)), '缺插件目录: ' + pkg.name + '/（ZCode 会在 <repo>/<插件名>/ 找）')
})

test('两种插件清单都存在且字段齐全（ZCode 原生 + Claude Code 兼容）', () => {
  for (const rel of [`${pkg.name}/.zcode-plugin/plugin.json`, `${pkg.name}/.claude-plugin/plugin.json`]) {
    const j = readJson(rel)
    for (const k of ['name', 'version', 'description', 'author', 'license']) {
      assert.ok(j[k] !== undefined, rel + ' 缺字段 ' + k)
    }
    assert.equal(j.name, pkg.name, rel + ' 的 name 与包名不一致')
    assert.equal(j.version, pkg.version, rel + ' 的 version 与 package.json 不一致（发版要三处同步）')
    assert.ok(String(j.description).length > 30, rel + ' 的 description 太短')
  }
})

test('MCP 声明指向已发布的 npm 包（能力不是空壳）', () => {
  const zj = readJson(`${pkg.name}/.zcode-plugin/plugin.json`)
  assert.ok(zj.mcpServers && typeof zj.mcpServers === 'object', 'plugin.json 缺 mcpServers')
  const entry = zj.mcpServers[pkg.name]
  assert.ok(entry, 'mcpServers 里没有以包名命名的 server')
  assert.equal(entry.command, 'npx')
  assert.equal(entry.args[0], '-y')
  // 允许并推荐 @latest：不带版本时 npx 会缓存旧版本，用户看到旧界面（真实踩过）
  assert.ok(entry.args[1] === pkg.name || entry.args[1] === pkg.name + '@latest', 'MCP 的 args 必须拉起本包: npx -y ' + pkg.name)

  const mcp = readJson(`${pkg.name}/.mcp.json`)
  assert.ok(mcp.mcpServers && mcp.mcpServers[pkg.name], '.mcp.json 里没有本包的 server')
  assert.ok(['' + pkg.name, pkg.name + '@latest'].includes(mcp.mcpServers[pkg.name].args[1]))
})

test('skill 有合法 frontmatter（name + description），路径符合 skills/<名字>/SKILL.md', () => {
  const rel = `${pkg.name}/skills/${pkg.name}/SKILL.md`
  assert.ok(existsSync(p(rel)), '缺 ' + rel)
  const src = readFileSync(p(rel), 'utf8')
  assert.match(src, /^---\n/, 'SKILL.md 必须以 frontmatter 开头')
  const fm = src.slice(3, src.indexOf('\n---', 3))
  assert.match(fm, new RegExp('^name:\\s*' + pkg.name + '\\s*$', 'm'), 'frontmatter 的 name 必须是 ' + pkg.name)
  const desc = (fm.match(/^description:\s*(.+)$/m) || [])[1] || ''
  assert.ok(desc.trim().length > 40, 'frontmatter 的 description 太短（要写清何时使用）')
  assert.ok(/guard_/.test(src), 'SKILL.md 里没提到任何 guard_* 工具')
})

test('壳里不出现"会误以为能跑 DSH 面板"的说法，且如实写明能力边界', () => {
  const readme = readFileSync(p(`${pkg.name}/README.md`), 'utf8')
  assert.match(readme, /MCP/, 'README 没说清能力经 MCP 交付')
  assert.match(readme, /（那些是 DSH 专属）|DSH 专属/, 'README 必须写明哪些能力在 ZCode 拿不到')
})

for (const [n, f] of cases) {
  try {
    f()
    pass++
    console.log(`  PASS  ${n}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${n}`)
    console.log(`        ${String(e.message).split('\n')[0]}`)
  }
}
console.log(`\n结果: ${pass} passed, ${fail} failed (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
