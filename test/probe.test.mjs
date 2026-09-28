/**
 * deskpet-guard — 探针纯函数测试（离线：不调 PowerShell、不碰真实系统探针）。
 *
 * probe.js 里最容易出 bug 的是两个纯函数，0.3.0 起抽出来可单测：
 *   · parsePsJson —— PowerShell 5.1 JSON 输出归一化
 *     （单元素压成对象、BOM、stderr 混入的前缀垃圾、空输出）；
 *   · splitGlob —— secretFiles 通配条目拆分
 *     （`{home}\.cursor\*.key` 以前 existsSync 永远 false → cursor 的 R4 静默失效）。
 *
 * 运行：node test/probe.test.mjs
 */
import assert from 'node:assert/strict'
import { parsePsJson, splitGlob } from '../lib/probe.js'

let pass = 0
let fail = 0
const cases = []
const test = (n, f) => cases.push([n, f])

// ── parsePsJson：PowerShell 输出归一化 ──
test('空输出 / 纯空白 → []（不是 null，避免误报探针失败）', () => {
  assert.deepEqual(parsePsJson(''), [])
  assert.deepEqual(parsePsJson('   \n  '), [])
  assert.deepEqual(parsePsJson(null), [])
})

test('单元素对象（PS 5.1 把单元素数组压成对象）→ 归一化成数组', () => {
  assert.deepEqual(parsePsJson('{"a":1}'), [{ a: 1 }])
})

test('数组原样通过', () => {
  assert.deepEqual(parsePsJson('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(parsePsJson('[]'), [])
})

test('BOM 与前缀垃圾（stderr 混入）→ 取首个 [/{ 到最后一个 ]/}', () => {
  assert.deepEqual(parsePsJson('\uFEFF{"a":1}'), [{ a: 1 }])
  assert.deepEqual(parsePsJson('噪声输出 [1,2,3] 尾部垃圾'), [1, 2, 3])
})

test('无法解析 → null（调用方据此记 probeErrors，R0 上报降级）', () => {
  assert.equal(parsePsJson('完全没有 JSON'), null)
  assert.equal(parsePsJson('{"a":1'), null)
})

test('JSON null 字面量 → []（PS 对空集可能输出 null）', () => {
  assert.deepEqual(parsePsJson('null'), [])
})

// ── splitGlob：secretFiles 通配条目拆分 ──
test('通配条目 → { dir, pattern }，pattern 能匹配文件名', () => {
  const g = splitGlob('C:\\Users\\x\\.cursor\\*.key')
  assert.ok(g, '应识别为通配条目')
  assert.equal(g.dir, 'C:\\Users\\x\\.cursor')
  const re = new RegExp(g.pattern, 'i')
  assert.ok(re.test('zcode-network-ca.key'), '应匹配 *.key')
  assert.ok(re.test('a.b.key'), '多级点号也匹配')
  assert.equal(re.test('zcode-network-ca.pem'), false, '不得越过扩展名')
})

test('非通配条目 → null（走目录/文件分支）', () => {
  assert.equal(splitGlob('C:\\Users\\x\\.claude\\.credentials.json'), null)
  assert.equal(splitGlob('C:\\Users\\x\\.zcode\\v2\\certs'), null)
  assert.equal(splitGlob(''), null)
})

test('通配只放文件名段：目录段里的 * 也按字面处理成最后一段的目录前缀', () => {
  // `certs\*.pem` → 目录 certs，文件名模式 *.pem
  const g = splitGlob('D:\\data\\certs\\*.pem')
  assert.equal(g.dir, 'D:\\data\\certs')
  assert.ok(new RegExp(g.pattern, 'i').test('server.pem'))
  assert.equal(new RegExp(g.pattern, 'i').test('server.key'), false)
})

// ── 执行 ──
for (const [name, fn] of cases) {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${String(e.message).split('\n')[0]}`)
  }
}
console.log(`\n结果: ${pass} passed, ${fail} failed (共 ${cases.length} 例)`)
process.exit(fail === 0 ? 0 : 1)
