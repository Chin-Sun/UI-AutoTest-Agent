/**
 * 流程积木 SDK。
 *
 * 被测项目在 projects/<id>/flows/index.ts 里用 defineFlow 声明可复用的前置流程（找任务、进页面……），
 * 执行器在用例的同一个浏览器页面里调用它；AI 只看到 FlowSpec（说明 + 参数 JSON Schema + 输出），
 * 负责挑积木和填参数。积木代码是确定性的，可以单测，不经过 LLM。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserContext, Page } from 'playwright'
import { z } from 'zod'
import { withLock, writeFileAtomic, type FlowSpec, type TestDataEntry } from '@uta/core'

// 项目积木只依赖本包：参数 schema 与页面类型都从这里取，不必各自安装 zod / playwright
export { z }
export type { BrowserContext, Locator, Page, Response } from 'playwright'

/**
 * 积木失败的归因：
 * env 环境 / 网络 / 后端问题；data-missing 缺账号或缺前置数据，需要人补；
 * step 页面结构与积木假设不符；assertion 前置条件不成立（如任务类型不对）
 */
export type FlowErrorKind = 'env' | 'data-missing' | 'step' | 'assertion'

export class FlowError extends Error {
  constructor(readonly kind: FlowErrorKind, message: string) {
    super(message)
  }
}

/** 项目级持久键值：积木用它记住创建过的对象（如自动创建的任务），下次直接复用 */
export interface FlowState {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export function fileState(file: string): FlowState {
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  const write = (change: (doc: Record<string, unknown>) => void) => withLock(file, async () => {
    const doc = await read()
    change(doc)
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`)
  })
  return {
    async get<T>(key: string) {
      return (await read())[key] as T | undefined
    },
    set: (key, value) => write((doc) => { doc[key] = value }),
    delete: (key) => write((doc) => { delete doc[key] }),
  }
}

/** 不落盘的状态：没有提供项目状态文件时使用（如单测） */
export function memoryState(): FlowState {
  const doc = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return doc.get(key) as T | undefined
    },
    async set(key, value) {
      doc.set(key, value)
    },
    async delete(key) {
      doc.delete(key)
    },
  }
}

export interface FlowTimeouts {
  action: number
  navigation: number
  assert: number
}

export interface FlowContext {
  page: Page
  context: BrowserContext
  baseURL: string
  /** 本次执行的数据（含前面积木的输出），只读；积木通过返回值产出新数据 */
  data: Readonly<Record<string, string>>
  /** 项目测试数据目录（test-data.yaml） */
  catalog: readonly TestDataEntry[]
  state: FlowState
  timeouts: FlowTimeouts
  log(message: string): void
}

export interface FlowDefinition<P extends z.ZodType = z.ZodType> {
  /** 形如 <项目>.<动作>，如 molar.ensureTask */
  id: string
  /** 给 AI 与人看的说明：做什么、何时用、有什么副作用 */
  description: string
  params: P
  /** 执行后写入数据的 key，后续步骤用 ${data.key} 引用 */
  outputs: readonly string[]
  run(ctx: FlowContext, params: z.infer<P>): Promise<Record<string, string> | void>
}

const FLOW_ID = /^[a-z][\w-]*(\.[A-Za-z][\w-]*)+$/

export function defineFlow<P extends z.ZodType>(flow: FlowDefinition<P>): FlowDefinition<P> {
  if (!FLOW_ID.test(flow.id)) throw new Error(`积木 id「${flow.id}」应形如 <项目>.<动作>，例如 molar.ensureTask`)
  return flow
}

export function toFlowSpec(flow: FlowDefinition): FlowSpec {
  const { $schema: _ignored, ...paramsSchema } = z.toJSONSchema(flow.params) as Record<string, unknown>
  return {
    id: flow.id,
    description: flow.description,
    paramsSchema,
    outputs: [...flow.outputs],
    validate: (params) => {
      const result = flow.params.safeParse(params)
      return result.success ? [] : [z.prettifyError(result.error)]
    },
  }
}

/** 加载项目积木：projects/<id>/flows/index.ts 默认导出 FlowDefinition[]；没有该文件时返回空 */
export async function loadProjectFlows(projectDir: string): Promise<FlowDefinition[]> {
  const entry = ['index.ts', 'index.js'].map((name) => join(projectDir, 'flows', name)).find((file) => existsSync(file))
  if (entry === undefined) return []
  const module = await import(pathToFileURL(entry).href) as { default?: unknown }
  if (!Array.isArray(module.default)) throw new Error(`${entry} 必须默认导出积木数组（FlowDefinition[]）`)
  const flows = module.default as FlowDefinition[]
  const seen = new Set<string>()
  for (const flow of flows) {
    if (seen.has(flow.id)) throw new Error(`${entry} 中积木 id 重复：${flow.id}`)
    seen.add(flow.id)
  }
  return flows
}

/** 校验参数 → 执行 → 检查声明的输出都已产出 */
export async function runFlow(flow: FlowDefinition, ctx: FlowContext, params: unknown): Promise<Record<string, string>> {
  const parsed = flow.params.safeParse(params)
  if (!parsed.success) throw new FlowError('step', `积木 ${flow.id} 参数不合法：\n${z.prettifyError(parsed.error)}`)
  const produced = (await flow.run(ctx, parsed.data)) ?? {}
  const outputs: Record<string, string> = {}
  for (const key of flow.outputs) {
    const value = produced[key]
    if (typeof value !== 'string' || value === '') throw new FlowError('step', `积木 ${flow.id} 没有产出 ${key}`)
    outputs[key] = value
  }
  return outputs
}
