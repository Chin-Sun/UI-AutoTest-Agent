/**
 * server 测试共用：临时数据目录 + 临时组件目录（复制内置 skill）+ mock LLM + 可编排的假执行器。
 * 假执行器按“演示站点的真实行为”返回结果，不启动浏览器。
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, DEFAULT_POLICY, missingBindings, type GatePolicy, type Project, type StepResult } from '@uta/core'
import { AgentServices, ComponentRegistry, MockAdapter } from '@uta/agent'
import type { RunPlanOptions, RunPlanResult } from '@uta/runner'
import { Bus, type BusEvent } from '../src/bus'
import { Pipeline } from '../src/pipeline'
import { usageRecorder } from '../src/usage'

export const REPO = fileURLToPath(new URL('../../../', import.meta.url))

export const demoProject = (patch: Partial<Project> = {}): Project => ({
  id: 'demo', name: '演示', baseURL: 'http://127.0.0.1:9/demo/', authRoles: {}, slowMo: 0,
  viewport: { width: 800, height: 600 }, knowledgeSkills: [], importers: {}, testData: [], ...patch,
})

export type Behavior = (options: RunPlanOptions) => RunPlanResult | Promise<RunPlanResult>

export interface FakeRunner {
  (options: RunPlanOptions): Promise<RunPlanResult>
  calls: RunPlanOptions[]
}

export function fakeRunner(behavior: Behavior = demoSite): FakeRunner {
  const calls: RunPlanOptions[] = []
  const fn = (async (options: RunPlanOptions) => {
    calls.push(options)
    return behavior(options)
  }) as FakeRunner
  fn.calls = calls
  return fn
}

/** 在 stepId 处失败，之前通过，之后跳过 */
export function failAt(options: RunPlanOptions, stepId: string, failure: Omit<StepResult, 'stepId' | 'status' | 'durationMs'>): RunPlanResult {
  const index = options.steps.findIndex((step) => step.id === stepId)
  return {
    status: 'failed',
    error: `${stepId}: ${failure.error?.message ?? ''}`,
    video: `${options.evidenceRel}/video.webm`,
    trace: `${options.evidenceRel}/trace.zip`,
    stepResults: options.steps.map((step, i): StepResult => (
      i < index
        ? { stepId: step.id, status: 'passed', durationMs: 1 }
        : i === index
          ? { stepId: step.id, status: 'failed', durationMs: 1, screenshot: `${options.evidenceRel}/step-${i + 1}.png`, ...failure }
          : { stepId: step.id, status: 'skipped', durationMs: 0 }
    )),
  }
}

export function passAll(options: RunPlanOptions): RunPlanResult {
  return {
    status: 'passed',
    video: `${options.evidenceRel}/video.webm`,
    trace: `${options.evidenceRel}/trace.zip`,
    stepResults: options.steps.map((step) => ({ stepId: step.id, status: 'passed', durationMs: 1 })),
  }
}

/** 模拟 demo 站点：只有「登录/保存/兑换/添加」按钮；待办计数少 1；兑换码只认 VIP-2026 */
export function demoSite(options: RunPlanOptions): RunPlanResult {
  const missing = missingBindings(options.steps, options.data)
  if (missing.length > 0) {
    const step = options.steps.find((s) => JSON.stringify(s).includes(`\${data.${missing[0]}}`))!
    return { status: 'failed', error: `缺少测试数据：${missing.join(', ')}`, stepResults: [{ stepId: step.id, status: 'failed', durationMs: 0, error: { kind: 'missing-data', message: `缺少测试数据：${missing.join(', ')}` } }] }
  }
  for (const step of options.steps) {
    const target = step.target as Record<string, string> | undefined
    if (step.action === 'click' && target?.['role'] === 'button' && !['登录', '保存', '兑换', '添加'].includes(target['name'] ?? '')) {
      return failAt(options, step.id, { error: { kind: 'locator', message: 'locator.click: Timeout 1500ms exceeded' }, ariaSnapshot: '- button "保存"' })
    }
    if (step.action === 'assertVisible' && target?.['text'] === '共 2 项') {
      return failAt(options, step.id, { actual: '不可见或不存在', error: { kind: 'assertion', message: '元素不可见' }, ariaSnapshot: '- paragraph: 共 1 项' })
    }
    if (step.action === 'assertVisible' && target?.['text'] === '兑换成功' && options.data['vipCode'] !== 'VIP-2026') {
      return failAt(options, step.id, { actual: '不可见或不存在', error: { kind: 'assertion', message: '元素不可见' }, ariaSnapshot: '- status: 兑换码无效' })
    }
  }
  return passAll(options)
}

export interface Harness {
  root: string
  dataRoot: string
  store: ReturnType<typeof createStore>
  bus: Bus
  events: BusEvent[]
  registry: ComponentRegistry
  agents: AgentServices
  projects: Map<string, Project>
  pipeline: Pipeline
  runner: FakeRunner
  logs(): string[]
  cleanup(): Promise<void>
}

export async function makeHarness(options: { behavior?: Behavior, policy?: GatePolicy, projects?: Project[], skills?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'uta-server-'))
  const dataRoot = join(root, 'data')
  await mkdir(join(root, 'components'), { recursive: true })
  if (options.skills ?? true) await cp(join(REPO, 'components/skills'), join(root, 'components/skills'), { recursive: true })
  const store = createStore(dataRoot)
  const bus = new Bus()
  const events: BusEvent[] = []
  bus.on((event) => { if (event.type !== 'frame') events.push(event) })
  const registry = new ComponentRegistry(join(root, 'components'), REPO)
  await registry.load()
  const agents = new AgentServices({
    registry,
    llmFor: () => new MockAdapter(),
    onEvent: (scope, event) => bus.emit({ type: 'agent', scope, event }),
    onUsage: usageRecorder(store, bus),
  })
  const projects = new Map((options.projects ?? [demoProject()]).map((project) => [project.id, project]))
  const runner = fakeRunner(options.behavior)
  const pipeline = new Pipeline({ store, agents, registry, projects, bus, dataRoot, policy: options.policy ?? DEFAULT_POLICY, runPlan: runner })
  return {
    root, dataRoot, store, bus, events, registry, agents, projects, pipeline, runner,
    logs: () => events.flatMap((event) => (event.type === 'log' ? [event.message] : [])),
    async cleanup() {
      await registry.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function until<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${JSON.stringify(value).slice(0, 600)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
