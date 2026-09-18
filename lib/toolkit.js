/**
 * deskpet-guard — 工具定义适配层（**零依赖**）。
 *
 * 为什么需要它：官方写法是
 *   import { defineTool } from '@deepseek-ai/dsh-tools'
 *   ctx.effect(() => ctx.tools.register(defineTool({ ... })), 'label')
 * 但本机没有 dsh 源码检出 / 也没有把 @deepseek-ai/* 链接进本包，
 * 运行期 `import '@deepseek-ai/dsh-tools'` 解析不到。为了保持
 * "零依赖、离线可运行"，这里按 defineTool 的**输出形状**手写等价实现。
 *
 * 形状证据（不是猜的）：dsh-super-injector 的打包产物里内联了 defineTool，
 * 见 D:\keep-records\super-injector-pkg\package\lib\index.js:4055-4101 ——
 * 它返回的普通对象长这样：
 *   { name, description, parameters(JSON Schema), output: { schema, render },
 *     timeoutMs?, execute(args, exec) }
 * 即"registry-ready 的普通对象"，不是类实例；因此本地等价实现可直接注册。
 *
 * 若日后本包能解析到 @deepseek-ai/dsh-tools，把真实 defineTool 作为第二参传入
 * 即可切回官方实现（参数声明保持同一套 spec 形式）。
 */

const TYPE_MAP = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  object: 'object',
  array: 'array',
  integer: 'integer',
}

/**
 * 参数 spec → JSON Schema（defineTool 内部 parameterSchemaSpecToJsonSchema 的最小等价）。
 * @param {Record<string, {type?:string, required?:boolean, description?:string, enum?:any[], items?:any, default?:any}>} spec
 */
export function parametersToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec || {})) {
    const p = raw || {}
    const type = TYPE_MAP[p.type] || (p.type ? String(p.type) : 'string')
    const prop = { type }
    if (p.description) prop.description = String(p.description)
    if (Array.isArray(p.enum)) prop.enum = p.enum
    if (p.type === 'array') prop.items = p.items || { type: 'string' }
    if (p.default !== undefined) prop.default = p.default
    properties[key] = prop
    if (p.required) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length) schema.required = required
  return schema
}

/** 默认结果渲染：文本原样，其余 JSON 化（与官方 render 返回 content 数组的约定一致）。 */
export function defaultRender(_args, value) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 定义一枚 registry-ready 的工具（defineTool 等价）。
 * @param {{name:string, description:string, parameters?:object, execute:Function, render?:Function, schema?:object, timeoutMs?:number}} options
 * @param {Function} [defineToolImpl] 官方 defineTool（可用时优先）
 */
export function defineGuardTool(options, defineToolImpl) {
  if (typeof defineToolImpl === 'function') {
    return defineToolImpl({
      name: options.name,
      description: options.description,
      parameters: options.parameters || {},
      output: {
        schema: options.schema || { type: 'string' },
        render: options.render || defaultRender,
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      execute: options.execute,
    })
  }
  const tool = {
    name: options.name,
    description: options.description,
    parameters: parametersToJsonSchema(options.parameters || {}),
    output: {
      schema: options.schema || { type: 'string' },
      render: options.render || defaultRender,
    },
    async execute(args) {
      return options.execute(args || {})
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  return tool
}

/**
 * 统一注册入口：优先 ctx.effect(注册)（这样卸载插件时工具会被 fiber 一起回收，
 * 否则就是 injector 一直在清理的"僵尸工具"）；降级直注册，再降级返回 false。
 * @returns {{ok:boolean, via?:string, error?:string}}
 */
export function registerTool(ctx, tool) {
  const svc = resolveTools(ctx)
  if (!svc || typeof svc.register !== 'function') {
    return { ok: false, error: 'tools 服务不可用（降级为纯监控）' }
  }
  const doRegister = () => svc.register(tool)
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(doRegister, 'deskpet-guard: ' + tool.name)
      return { ok: true, via: 'effect' }
    } catch (e) {
      /* 落到直注册 */
      return tryDirect(doRegister, e)
    }
  }
  return tryDirect(doRegister)
}

function tryDirect(fn, firstError) {
  try {
    fn()
    return { ok: true, via: 'direct' }
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || firstError || 'unknown').slice(0, 200),
    }
  }
}

/** 取 tools 服务（cordis：ctx.get('tools') 或属性直取）。 */
export function resolveTools(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (viaGet) return viaGet
  } catch {
    /* 继续 */
  }
  return ctx.tools
}
