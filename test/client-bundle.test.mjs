/**
 * deskpet-guard — client 产物（lib/client.js）一致性测试。
 *
 * 背景：面板是**手写产物**（本机装不了 tsdown），没有编译器替我们保证
 * "产物 ↔ host API ↔ 入口指针"三者一致。所以这里用测试把它们焊死 ——
 * 这几条正是第一版留下的真实缺口（exports["./client"] 指向一个不存在的文件）。
 *
 * 覆盖：
 *   · 产物存在、是 DSH ModuleLoader 约定、有 exports.apply/inject
 *   · 注册的 slot 在白名单内（typo 会被宿主拒绝，且报错难懂）
 *   · 面板用的 API 基址与端点路径，在 lib/api.js 里真有实现（桥不悬空）
 *   · package.json 的 exports/dsh 指针指向真实存在的文件
 *   · 面板不用 innerHTML（进程名/路径是外部输入，注入不得）
 *   · node --check 语法有效
 *
 * 运行：node test/client-bundle.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const ROOT = new URL('..', import.meta.url)
const clientPath = fileURLToPath(new URL('lib/client.js', ROOT))
const clientSrc = readFileSync(clientPath, 'utf8')
const apiSrc = readFileSync(new URL('lib/api.js', ROOT), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))

/** DSH 宿主认可的 slot 白名单（来源：dsh-super-injector 的 KNOWN_SLOTS 校验）。 */
const KNOWN_SLOTS = [
  'conversation.view',
  'settings.plugin.item',
  'settings.plugins.tab',
  'settings.section',
  'settings.general.item',
  'conversation.session.header.actions',
  'conversation.session.header.utilities',
  'conversation.input.dock',
  'conversation.composer.dock',
  'sidebar.footer.action',
  'shell.overlay',
]

test('lib/client.js 存在且非空（第一个版本就是缺这个文件）', () => {
  assert.ok(existsSync(clientPath), 'lib/client.js 不存在')
  assert.ok(clientSrc.length > 2000, '产物过小，疑似占位符')
})

test('产物是 DSH ModuleLoader 约定，且 id 与包名一致', () => {
  assert.match(clientSrc, /window\.__ModuleLoader__\.load\(/)
  assert.ok(clientSrc.includes('id: "@dsh-external/deskpet-guard"'), 'ModuleLoader id 不是包名')
  assert.match(clientSrc, /factory: \(require\) =>/)
})

test('导出 apply / inject，且 inject 声明了 slots', () => {
  assert.match(clientSrc, /exports\.apply = apply/)
  assert.match(clientSrc, /exports\.inject = inject/)
  assert.match(clientSrc, /const inject = \["slots"\]/)
})

test('注册的 slot 全在宿主白名单内', () => {
  const slots = [...clientSrc.matchAll(/name: "([a-z.]+)"/g)].map((m) => m[1])
  assert.ok(slots.length >= 2, '至少应注册桌宠与详情面板两个 slot')
  for (const s of slots) {
    assert.ok(KNOWN_SLOTS.includes(s), 'slot 不在白名单（宿主会拒绝）: ' + s)
  }
  assert.ok(slots.includes('shell.overlay'), '缺少常驻桌宠 slot')
  assert.ok(slots.includes('conversation.view'), '缺少详情面板 slot')
})

test('满足注入器骨架自检的正则（slot 名必须是字面量，否则注入直接被阻断）', () => {
  // 这条不是形式主义：2026-09 用动态拼 slot 名时，dsh-super-injector 的
  // clientSkeletonProblems() 就是用它 block 掉注入的（"register 缺合法 name"）。
  const alt = KNOWN_SLOTS.map((s) => s.replace(/\./g, '\\.')).join('|')
  const re = new RegExp(`register\\(\\{[\\s\\S]*?name:\\s*['"](${alt})['"]`)
  assert.ok(re.test(clientSrc), '注入器会以"register 缺合法 name"阻断注入')
  assert.match(clientSrc, /inject\s*=\s*\[[^\]]*['"]slots['"]/, '缺 inject 含 slots 声明')
})

test('面板用的 API 基址与 lib/api.js 的 API_BASE 一致', () => {
  const m = apiSrc.match(/export const API_BASE = '([^']+)'/)
  assert.ok(m, 'api.js 里找不到 API_BASE')
  assert.ok(clientSrc.includes('const API = "' + m[1] + '"'), '面板 API 基址与 host 不一致: 期望 ' + m[1])
})

test('面板调用的每个端点，在 lib/api.js 里真有分支', () => {
  const used = new Set([...clientSrc.matchAll(/fetchJson\("(\/[a-z-]+)/g)].map((m) => m[1]))
  assert.ok(used.size >= 5, '面板端点覆盖不足: ' + [...used].join(','))
  for (const p of used) {
    assert.ok(apiSrc.includes("'" + p + "'"), 'api.js 缺 ' + p + ' 分支 → 面板会 404')
  }
})

test('变更类请求带自定义头 x-deskpet-guard（否则 host 侧 403）', () => {
  assert.match(clientSrc, /"x-deskpet-guard": "1"/)
  assert.match(clientSrc, /method: "POST"/)
})

test('面板不用 innerHTML（进程名/路径/域名都是外部输入）', () => {
  // 注释里会出现 "innerHTML" 这个词，所以先把注释剥掉再查代码
  const code = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/innerHTML/.test(code), '出现了 innerHTML：可能被进程名/路径注入')
  assert.ok(!/outerHTML/.test(code))
  assert.match(code, /textContent/)
})

test('两步确认在 UI 上是两步（先生成确认单，再执行）', () => {
  assert.match(clientSrc, /\/prepare-kill/)
  assert.match(clientSrc, /\/confirm-kill/)
  assert.ok(clientSrc.includes('我已确认后果'), '缺少显式的人工确认按钮文案')
})

test('桌宠读内层 status（只读顶层镜像会让它永远显示"尚无采样"）', () => {
  // 回归：截图自查抓到桌宠一直显示"尚无采样" —— /status 响应顶层的 mood/headline
  // 只是镜像字段，真正的数据在内层 status 对象里。
  const start = clientSrc.indexOf('function renderPet')
  const end = clientSrc.indexOf('function renderPanel')
  assert.ok(start > 0 && end > start, '找不到 renderPet/renderPanel')
  const pet = clientSrc.slice(start, end)
  assert.match(pet, /const st = statusBody\(f\.status\)/)
  assert.match(pet, /st\.headline/)
  assert.match(pet, /st\.atMs/)
})

test('package.json 的客户端指针不悬空（exports + dsh.client）', () => {
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.ok(existsSync(fileURLToPath(new URL(pkg.exports['./client'].default, ROOT))))
  const e = pkg.exports['./client'].types
  assert.ok(existsSync(fileURLToPath(new URL(e, ROOT))), 'client 类型声明缺失: ' + e)
  assert.ok(pkg.dsh && pkg.dsh.client && Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('package.json 的 host 入口与类型指针不悬空', () => {
  assert.ok(existsSync(fileURLToPath(new URL(pkg.main, ROOT))), 'main 指向不存在的文件: ' + pkg.main)
  assert.ok(existsSync(fileURLToPath(new URL(pkg.types, ROOT))), 'types 指向不存在的文件: ' + pkg.types)
  assert.ok(existsSync(fileURLToPath(new URL(pkg.bin['deskpet-guard-mcp'], ROOT))), 'bin 指向不存在的文件')
})

test('node --check：产物语法有效（无构建也要能加载）', () => {
  execFileSync(process.execPath, ['--check', clientPath], { stdio: ['ignore', 'pipe', 'pipe'] })
})

test('node --check：所有交付的 JS 都语法有效（本仓库没有编译步骤兜底）', () => {
  const dirs = ['lib', 'bin']
  const files = []
  for (const d of dirs) {
    for (const name of readdirSync(fileURLToPath(new URL(d, ROOT)))) {
      if (name.endsWith('.js')) files.push(d + '/' + name)
    }
  }
  assert.ok(files.length >= 10, '扫到的交付文件太少: ' + files.join(','))
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', fileURLToPath(new URL(f, ROOT))], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      throw new Error('语法错误: ' + f + ' → ' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '))
    }
  }
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
