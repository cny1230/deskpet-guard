/**
 * deskpet-guard — 极简 DOM shim（只为在 Node 里跑面板 bundle）。
 *
 * 为什么需要：lib/client.js 是**手写产物**，没有编译器、没有类型检查、也没法 tsdown。
 * 于是"面板逻辑是否正确"只能靠跑起来看。这个 shim 实现 client.js 实际用到的那一小撮
 * DOM 能力（createElement / textContent / append / addEventListener / style / id /
 * document.head / getElementById + 定时器 + fetch），足以把真面板挂起来点它。
 *
 * 刻意保持"笨"：不做布局、不做事件冒泡，只维护一棵可遍历的节点树。
 */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase()
    this.className = ''
    this.id = ''
    this.disabled = false
    this.style = {}
    this.children = []
    this.listeners = {}
    this._text = ''
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('')
    return this._text
  }

  append(...nodes) {
    for (const n of nodes) this.children.push(n)
  }

  /** client.js 对 document.head 用的是 appendChild（DOM 原语），一并支持。 */
  appendChild(node) {
    this.children.push(node)
    return node
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(fn)
  }

  /** 测试用：派发一次 click。 */
  click() {
    for (const fn of this.listeners.click || []) fn({ type: 'click' })
  }

  /** 深度优先收集自身与所有后代。 */
  walk(out = []) {
    out.push(this)
    for (const c of this.children) c.walk(out)
    return out
  }

  /** 按 className 片段找节点（只做 contains，够用了）。 */
  find(cls) {
    return this.walk().filter((n) => String(n.className || '').includes(cls))
  }

  findByText(text) {
    return this.walk().filter((n) => n.tagName === 'BUTTON' && n.textContent.includes(text))
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeNode('head')
    this.body = new FakeNode('body')
    this.created = []
  }

  createElement(tag) {
    const n = new FakeNode(tag)
    this.created.push(n)
    return n
  }

  createTextNode(text) {
    const n = new FakeNode('#text')
    n.textContent = String(text)
    return n
  }

  getElementById(id) {
    return this.created.find((n) => n.id === id) || null
  }
}

/**
 * 安装全局 window/document + 假定时器 + 可控 fetch。
 * @returns 句柄：{ document, intervals, cleared, fetchCalls, setFetch, tickIntervals }
 */
export function installDom(options = {}) {
  const document = new FakeDocument()
  const intervals = []
  const cleared = []
  const fetchCalls = []
  let seq = 0

  let fetchImpl = options.fetch || (() => Promise.reject(new Error('fetch 未设置')))

  const window = {
    setInterval(fn, ms) {
      const id = ++seq
      intervals.push({ id, fn, ms })
      return id
    },
    clearInterval(id) {
      cleared.push(id)
    },
  }

  globalThis.window = window
  globalThis.document = document
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return fetchImpl(String(url), init)
  }

  return {
    document,
    window,
    intervals,
    cleared,
    fetchCalls,
    setFetch(fn) {
      fetchImpl = fn
    },
    /** 触发最近一次注册的 interval 回调（模拟"下一轮轮询"）。 */
    tickIntervals() {
      for (const it of intervals) it.fn()
    },
    head() {
      return document.head
    },
  }
}

/** 把已排队的 promise 链跑干（fetch → json → then ×N → emit）。 */
export async function flush(turns = 40) {
  for (let i = 0; i < turns; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

export { FakeNode }
