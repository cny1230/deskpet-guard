/**
 * deskpet-guard — 面板/桌宠行为测试（DOM shim 里跑真实 bundle）。
 *
 * 为什么值得写：lib/client.js 是手写产物，没有任何编译器/类型检查兜底。
 * 2026-09 就是靠"截图肉眼看"抓到两个真 bug：桌宠永远显示"尚无采样"、
 * 3 秒轮询把进行中的两步确认冲掉。这里把它们变成可重复执行的回归用例。
 *
 * 运行：node test/panel-ui.test.mjs
 */
import assert from 'node:assert/strict'
import { installDom, flush } from './dom-shim.mjs'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

// ── 预览夹具（结构与 lib/api.js 的真实响应一致）──
const TARGET = { pid: 4242, process: 'ZCode.exe', reason: 'ZCode 正在连接对象存储服务', remote: 'oss-cn-beijing.aliyuncs.com:443' }
const STATUS = {
  ok: true,
  version: '0.1.0',
  mode: 'audit',
  apiBase: '/deskpet-guard/api',
  dataDir: 'D:/tmp/guard-data',
  status: {
    atMs: 1_800_000_000_000,
    cycles: 9,
    mood: 'panic',
    headline: '检测到对象存储直传',
    worstSeverity: 'critical',
    activeFindings: 2,
    newEvents: 2,
    probeErrors: [],
    agentProcessCount: 3,
    egressConnections: 1,
    bundleArtifacts: 3,
    killTargets: [TARGET],
  },
  // 顶层镜像字段：真实 API 也会给，但**不能**依赖它（回归用例就是为这条）
  mood: 'panic',
  headline: '检测到对象存储直传',
  targets: [TARGET],
}
const EVENTS = {
  ok: true,
  limit: 30,
  events: [
    { seq: 1, atMs: 1_799_999_000_000, ruleId: 'R2-fresh-bundle-artifact', severity: 'high', title: '10 分钟内有新的打包产物出现' },
    { seq: 2, atMs: 1_800_000_000_000, ruleId: 'R1-agent-to-object-storage', severity: 'critical', title: 'ZCode 正在连接对象存储服务' },
  ],
}

const dom = installDom({
  fetch: async (url) => {
    const path = String(url).split('?')[0]
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (path.endsWith('/status')) return reply(STATUS)
    if (path.endsWith('/events')) return reply(EVENTS)
    if (path.endsWith('/scan')) return reply({ ok: true, mood: STATUS.status })
    if (path.endsWith('/prepare-kill')) {
      return reply({
        ok: true,
        requiresConfirmation: true,
        policy: 'one-target-per-confirmation',
        targets: [TARGET],
        targetCount: 1,
        warning: '终止 agent 进程可能中断你正在进行的会话或损坏未保存的编辑内容。',
        confirmToken: 'kill-test-token',
        confirmTarget: TARGET,
      })
    }
    if (path.endsWith('/confirm-kill')) return reply({ ok: false, error: 'audit 模式：已按配置拒绝执行终止（仅预警）' })
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route: ' + path }) }
  },
})

// ── 装载 bundle，并用 stub 宿主 slots 服务挂起来 ──
let plugin = null
globalThis.window.__ModuleLoader__ = {
  load: (def) => {
    plugin = def.factory(() => {
      throw new Error('panel-ui test: require() 未实现')
    })
  },
}
await import('../lib/client.js')

assert.ok(plugin && typeof plugin.apply === 'function', 'bundle 没有导出 apply')
assert.deepEqual(plugin.inject, ['slots'])

const registrations = []
const effects = []
const ctx = {
  logger: { info() {}, warn() {} },
  effect: (fn, label) => {
    effects.push(label)
    fn()
    return () => {}
  },
  slots: {
    inject: (slot, register) => register(),
    register: (reg) => registrations.push(reg),
  },
}
plugin.apply(ctx)

const bySlot = Object.fromEntries(registrations.map((r) => [r.name, r]))
const comps = {}
for (const [slot, reg] of Object.entries(bySlot)) comps[slot] = reg.component()
const panelNode = comps['conversation.view'].render()
const petNode = comps['shell.overlay'].render()
dom.document.body.append(panelNode, petNode)

await flush()

test('apply 注册了两个 slot（详情面板 + 桌宠），且走 ctx.effect', () => {
  assert.deepEqual(Object.keys(bySlot).sort(), ['conversation.view', 'shell.overlay'])
  assert.ok(effects.includes('deskpet-guard: conversation.view'))
  assert.ok(effects.includes('deskpet-guard: shell.overlay'))
})

test('面板渲染出 mood/headline/统计芯片与候选目标', () => {
  const text = panelNode.textContent
  assert.match(text, /检测到对象存储直传/)
  assert.match(text, /\( ✖﹏✖ \)/)
  assert.match(text, /pid=4242/)
  assert.match(text, /候选处置目标/)
  assert.match(text, /ZCode 正在连接对象存储服务/)
  assert.match(text, /立即重扫/)
})

test('事件流按最新在前渲染（旧→新取自 API，展示时反转）', () => {
  const items = panelNode.find('dpg-item')
  assert.ok(items.length >= 2)
  assert.match(items[0].textContent, /ZCode 正在连接对象存储服务/)
  assert.match(items[1].textContent, /打包产物/)
})

test('桌宠读内层 status（回归：曾因只读顶层镜像而永远显示"尚无采样"）', () => {
  const text = petNode.textContent
  assert.match(text, /检测到对象存储直传/)
  assert.match(text, /采样/)
  assert.ok(!/尚无采样/.test(text), '桌宠仍在显示"尚无采样"')
})

test('点"确认终止"→ 生成确认单 → 出现最终确认按钮（第一步不执行任何动作）', async () => {
  const btn = panelNode.findByText('确认终止')[0]
  assert.ok(btn, '找不到"确认终止"按钮')
  btn.click()
  await flush()
  const go = panelNode.findByText('我已确认后果')
  assert.equal(go.length, 1, '未出现最终确认按钮')
  assert.match(panelNode.textContent, /kill-test-token/)
  assert.match(panelNode.textContent, /10 分钟内有效/)
  // 只点了第一步：不应调用 confirm-kill
  assert.equal(dom.fetchCalls.filter((c) => c.url.endsWith('/confirm-kill')).length, 0, '第一步就执行了终止')
})

test('回归：轮询重画不会冲掉进行中的两步确认', async () => {
  dom.tickIntervals() // 模拟 3 秒后的下一轮轮询
  await flush()
  const go = panelNode.findByText('我已确认后果')
  assert.equal(go.length, 1, '轮询把进行中的确认 UI 冲掉了（用户 3 秒内没点完就丢）')
})

test('点最终确认 → 调用 confirm-kill 并把结果提示出来', async () => {
  const go = panelNode.findByText('我已确认后果')[0]
  go.click()
  await flush()
  const calls = dom.fetchCalls.filter((c) => c.url.endsWith('/confirm-kill'))
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].init.body), /kill-test-token/)
  assert.match(panelNode.textContent, /终止未执行：audit 模式/)
  // 执行完就收起确认区，不留着旧 token
  assert.equal(panelNode.findByText('我已确认后果').length, 0)
})

test('取消：确认区收起且不调用 confirm-kill', async () => {
  panelNode.findByText('确认终止')[0].click()
  await flush()
  assert.equal(panelNode.findByText('我已确认后果').length, 1)
  const cancel = panelNode.findByText('取消')[0]
  cancel.click()
  await flush()
  assert.equal(panelNode.findByText('我已确认后果').length, 0)
  assert.equal(dom.fetchCalls.filter((c) => c.url.endsWith('/confirm-kill')).length, 1, '取消不该触发终止')
})

test('"立即重扫"走 /scan 并展示结果提示', async () => {
  const before = dom.fetchCalls.filter((c) => c.url.endsWith('/scan')).length
  panelNode.findByText('立即重扫')[0].click()
  await flush()
  assert.equal(dom.fetchCalls.filter((c) => c.url.endsWith('/scan')).length, before + 1)
  assert.match(panelNode.textContent, /本次重扫/)
})

test('API 不可达时给出可读错误，而不是空白面板', async () => {
  dom.setFetch(async () => {
    throw new Error('ECONNREFUSED')
  })
  dom.tickIntervals()
  await flush()
  assert.match(panelNode.textContent, /守护 API 不可达|ECONNREFUSED/)
  assert.match(petNode.textContent, /守护 API 不可达/)
})

test('dispose 两个 slot 后停止轮询（不留后台定时器）', async () => {
  const before = dom.cleared.length
  comps['conversation.view'].dispose()
  comps['shell.overlay'].dispose()
  assert.ok(dom.cleared.length > before, 'dispose 未清理 interval')
})

for (const [n, f] of cases) {
  try {
    await f()
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
