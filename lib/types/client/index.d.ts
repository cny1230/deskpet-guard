/**
 * deskpet-guard — 客户端插件（浏览器侧）类型声明。
 *
 * 运行时产物是手写 bundle lib/client.js（DSH ModuleLoader 约定）；这里只声明
 * 插件契约本身：导出 apply / inject。面板内部用到的 host 数据面见
 * lib/api.js（HTTP）与 lib/types/index.d.ts（host 库 API）。
 */

/** 面板在 apply 里用 ctx.slots，必须声明 slots 服务注入，否则宿主报 "cannot get slots"。 */
export declare const inject: ['slots']

export interface ClientSlotRegistration {
  name: string
  id: string
  order?: number
  label?: () => string
  component: () => { render: () => unknown; dispose?: () => void }
}

export interface ClientSlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(registration: ClientSlotRegistration): unknown
}

export interface ClientContext {
  slots: ClientSlotsService
  effect(fn: () => unknown, label?: string): unknown
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
}

/**
 * 注册两个 slot：
 *   · conversation.view → 详情面板（统计 / 候选目标两步确认 / 事件流）
 *   · shell.overlay     → 常驻桌宠（表情 + 一句话 + 新事件角标）
 */
export declare function apply(ctx: ClientContext): void
