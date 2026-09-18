/**
 * 守护循环形态（daemon-loop）——**参考模板，不是本插件的宿主入口**。
 *
 * ⚠️ 血案记录（2026-09）：这个文件原先位于 src/index.ts，而 tsconfig 的
 * rootDir=src / outDir=lib 会让 `tsc` 把它编译成 lib/index.js —— 恰好覆盖掉
 * 真正的守护实现（手写的 lib/index.js：探针 + 规则 + 只追加事件流 + 两步终止）。
 * 于是 `bash scripts/build.sh` 一次就把产品换成了一个只会读 self-heal.log 的
 * 自省循环。现在：①本文件挪到 src/daemon/（不再与宿主入口同名）；②tsc 产物
 * 统一进 build/（tsconfig outDir=build）；③scripts/build.sh 有硬守卫。
 *
 * 保留它是因为这个形态本身有价值：timer 驱动的小 agent loop，观察 → LLM 决策
 * → 行动 → 再睡，可作为"守护之上的自治层"的起点（例如让模型解释一次告警）。
 * 若要启用，请在 lib/index.js 的 apply() 里显式挂载，不要靠改文件名。
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'

type AppContext = Context & {
  llm: LlmService
  setInterval(fn: () => void, ms: number): any
}

export const name = "deskpet-guard-daemon"
export const inject = ['timer', 'llm']

export interface Config {
  intervalMs: number
  logFile: string
  watchFile: string
}

export const Config = z.object({
  intervalMs: z.number().min(5000).default(60000),
  logFile: z.string().default(''),
  watchFile: z.string().default(''),
})

export function apply(ctx: AppContext, config: Config): void {
  // 短名（去 scope）：日志文件名不能含 '/'（会变成子路径）
  const SHORT = "deskpet-guard-daemon"
  // DSH_HOME 优先：web 进程 homedir 可能与 DSH_HOME 不一致（部署常见），homedir() 推导会错位
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')
  const watchFile = config.watchFile || join(dshHome, 'super-injector', 'self-heal.log')
  let cycles = 0
  let llmCalls = 0
  let lastRoute: { provider: string; model: string } | null = null

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 日志失败静默 */ }
  }

  // 观察面：捕获主模型路由（waterfall 必须 next() 委托）
  ctx.on('llm/stream', (options, next) => {
    lastRoute = { provider: options.provider, model: options.model }
    return next()
  })

  async function decideWithLlm(tail: string): Promise<string> {
    if (!lastRoute) return '无可用 LLM 路由（未捕获到主模型调用），跳过决策'
    llmCalls += 1
    try {
      let text = ''
      const stream = ctx.llm.stream({
        provider: lastRoute.provider,
        model: lastRoute.model,
        system: '你是守护 agent。分析给定日志尾部，判断是否需要人工介入。直接输出结论：需介入（10 字内原因）/ OK。',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: tail.slice(0, 800) }] })],
        temperature: 0,
        reasoningEffort: ReasoningEffortId('off'),
        maxTokens: 200,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      return text.trim().slice(0, 60) || 'LLM 无输出'
    } catch (e) {
      return 'LLM 调用失败: ' + String(e).slice(0, 40)
    }
  }

  // ═══ 小 agent loop：每 intervalMs 醒来 → 观察 → 决策 → 行动 → 再睡 ═══
  ctx.setInterval(() => {
    void (async () => {
      cycles += 1
      let tail = ''
      try {
        const { readFileSync } = await import('node:fs')
        const t = readFileSync(watchFile, 'utf8').trim().split('\n')
        tail = t.slice(-3).join('\n')
      } catch { /* 无观察源 */ }
      let decision: string
      if (tail.includes('heal-failed') || tail.includes('reboot-failed')) {
        decision = await decideWithLlm(tail)
      } else {
        decision = 'OK（无异常，LLM 未唤醒）'
      }
      log('cycle=' + cycles + ' llmCalls=' + llmCalls + ' decision=' + decision)
    })().catch((e) => log('loop error: ' + String(e)))
  }, config.intervalMs)

  ctx.logger?.info?.('[' + name + '] 参考模板已挂载（每 ' + config.intervalMs + 'ms 一轮，非宿主入口）')
}
