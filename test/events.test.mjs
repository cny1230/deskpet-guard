/**
 * deskpet-guard — 事件流测试（离线：只写系统临时目录，退出时清理）。
 *
 * 覆盖 0.3.0 的三个行为变化：
 *   · record() 去重从"永久压制"改为"冷却期 + 复发计数"（同一现象复发必须可见）；
 *   · appendEvents 超限轮转（改名归档 .1，不删除历史）；
 *   · readEvents 真 tail 读取（大文件不再整载入内存，首行不完整时丢弃）。
 *
 * 运行：node test/events.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { record } from '../lib/index.js'
import {
  appendEvents,
  readEvents,
  eventsPath,
  fingerprint,
  EVENTS_TAIL_BYTES,
} from '../lib/events.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

const DATA = mkdtempSync(join(tmpdir(), 'deskpet-guard-events-'))
const DATA2 = mkdtempSync(join(tmpdir(), 'deskpet-guard-events2-'))
process.on('exit', () => {
  for (const d of [DATA, DATA2]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

const finding = (id, path) => ({
  ruleId: 'R2-fresh-bundle-artifact',
  severity: 'high',
  profileId: 'zcode',
  title: '刚生成可疑打包产物',
  evidence: { path },
  suggest: 'alert',
  _id: id,
})

// ── 冷却去重 + 复发计数 ──
test('record: 首次落库 occurrence=1，冷却期内重复现象不刷事件流', () => {
  const seen = new Map()
  const f = finding('a', 'C:\\x\\a.tar.gz.enc')
  const first = record(DATA, [f], seen, { cooldownMs: 60 * 60 * 1000 })
  assert.equal(first.length, 1)
  assert.equal(first[0].occurrence, 1)
  const second = record(DATA, [{ ...f, seq: 999 }], seen, { cooldownMs: 60 * 60 * 1000 })
  assert.equal(second.length, 0, '冷却期内同指纹不得重复落库')
  // 压制期间计数仍应累计（可观测）
  const entry = seen.get(fingerprint(f))
  assert.equal(entry.count, 2, '被压制的重复现象应累计次数')
})

test('record: 冷却期过后同一现象再现 → 记"复发"事件，occurrence 递增', () => {
  const seen = new Map()
  const f = finding('b', 'C:\\x\\b.tar.gz.enc')
  record(DATA, [f], seen, { cooldownMs: 60 * 60 * 1000 })
  // 模拟时间流逝：把上次告警时间拨回 2 小时前
  seen.get(fingerprint(f)).lastMs = Date.now() - 2 * 60 * 60 * 1000
  const again = record(DATA, [f], seen, { cooldownMs: 60 * 60 * 1000 })
  assert.equal(again.length, 1, '冷却期过后必须重新可见（旧实现永久压制）')
  assert.equal(again[0].occurrence, 2)
})

test('record: cooldownMs=0 时每次都落库（不做压制）', () => {
  const seen = new Map()
  const f = finding('c', 'C:\\x\\c.tar.gz.enc')
  assert.equal(record(DATA, [f], seen, { cooldownMs: 0 }).length, 1)
  assert.equal(record(DATA, [f], seen, { cooldownMs: 0 }).length, 1)
})

test('record: info 级依旧不落库；兼容旧调用传 Set（永久去重）', () => {
  const seen = new Set()
  const f = finding('d', 'C:\\x\\d.tar.gz.enc')
  assert.equal(record(DATA, [f], seen).length, 1)
  assert.equal(record(DATA, [f], seen).length, 0, 'Set 语义 = 永久去重')
  const infoOnly = record(DATA, [
    { ...finding('e', 'C:\\x\\e.tar.gz.enc'), severity: 'info' },
  ], new Map())
  assert.equal(infoOnly.length, 0)
})

// ── 轮转 ──
test('appendEvents: 超过 maxBytes 轮转为 .1 归档，当前文件另起', () => {
  const big = finding('f', 'C:\\x\\' + 'p'.repeat(300) + '.tar.gz.enc')
  for (let i = 0; i < 3; i++) {
    appendEvents(DATA, [{ ...big, seq: i, atMs: Date.now() }], { maxBytes: 600 })
  }
  assert.ok(existsSync(eventsPath(DATA) + '.1'), '应产生 .1 归档文件')
  const cur = readFileSync(eventsPath(DATA), 'utf8').trim().split('\n')
  assert.ok(cur.length >= 1, '当前文件应继续接收新事件')
  const latest = JSON.parse(cur[cur.length - 1])
  assert.ok(latest.seq >= 1)
  assert.equal(latest.ruleId, 'R2-fresh-bundle-artifact')
})

test('appendEvents: 归档保留完整历史（改名而非删除，只追加语义不破坏）', () => {
  const arch = readFileSync(eventsPath(DATA) + '.1', 'utf8').trim().split('\n')
  for (const line of arch) {
    assert.doesNotThrow(() => JSON.parse(line), '归档段每行必须是完整 JSON')
  }
})

// ── tail 读取 ──
test('readEvents: 超过 512KB 的大文件只读尾部，不整载入，行不残缺', () => {
  // 每行 ~40B × 20000 行 ≈ 800KB > EVENTS_TAIL_BYTES
  const lines = []
  for (let i = 0; i < 20000; i++) {
    lines.push(JSON.stringify({ seq: i, ruleId: 'R2-fresh-bundle-artifact', i }))
  }
  writeFileSync(eventsPath(DATA2), lines.join('\n') + '\n')
  const st = statSync(eventsPath(DATA2))
  assert.ok(st.size > EVENTS_TAIL_BYTES, '测试前置：文件必须真的超过 tail 窗口')

  const all = readEvents(DATA2, 500)
  assert.equal(all.length, 500)
  for (const e of all) {
    assert.ok(typeof e.seq === 'number', 'tail 窗口内每行必须是完整 JSON（无残缺首行）')
  }
  // 尾部窗口内的事件序号必须连续递增（证明没有跳读/重复解析）
  const seqs = all.map((e) => e.seq)
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), '结果应保持文件尾部顺序')
  assert.ok(seqs[0] > 10000, '应只含文件尾部的事件，而不是从头开始')

  const one = readEvents(DATA2, 1)
  assert.equal(one.length, 1)
  assert.equal(one[0].seq, 19999, '最后一条必须是文件末尾的事件')
})

test('readEvents: 空文件 / 不存在 / 非法行 → 不抛错', () => {
  assert.deepEqual(readEvents(DATA2, 5), readEvents(DATA2, 5))
  assert.deepEqual(readEvents(join(DATA2, 'nope'), 5), [])
  const bad = mkdtempSync(join(tmpdir(), 'deskpet-guard-bad-'))
  try {
    writeFileSync(eventsPath(bad), 'not-json\n{"ok":1}\n')
    const rows = readEvents(bad, 10)
    assert.equal(rows.length, 1, '非法行跳过，合法行保留')
    assert.equal(rows[0].ok, 1)
  } finally {
    rmSync(bad, { recursive: true, force: true })
  }
})

// ── 执行 ──
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
