/** Agent 服务：每个角色一次完整 Agent Loop（mock 规则引擎 + 可编排的假模型） */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LoginConfigSchema, planNeedsHumanApproval, validatePlanSteps, type Finding, type FlowSpec, type Project, type Step, type TestCase } from '@uta/core'
import {
  AgentFailure, AgentServices, ComponentRegistry, MockAdapter, ROLES,
  type AgentUsage, type ChatRequest, type ChatResponse, type LlmAdapter,
} from '../src'
import { extractPayload } from '../src/llm/mock'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const demoCases = JSON.parse(await readFile(join(repo, 'projects/demo/cases.json'), 'utf8')) as Partial<TestCase>[]
const project: Project = { id: 'demo', name: '演示', baseURL: 'http://x/demo/', authRoles: {}, slowMo: 0, viewport: { width: 1, height: 1 }, knowledgeSkills: [], importers: {}, testData: [] }

function testCase(partial: Partial<TestCase>): TestCase {
  return { id: 'case_x', projectId: 'demo', title: 't', preconditions: [], steps: [], expected: [], data: {}, notes: [], version: 1, createdAt: 0, updatedAt: 0, ...partial }
}
const demo = (index: number) => testCase({ id: `case_${index}`, ...demoCases[index] })

/** 按顺序返回脚本化响应，并记录每次请求 */
function scripted(responses: ChatResponse[]): LlmAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    provider: 'fake', model: 'script', requests,
    async chat(request) {
      requests.push(request)
      return responses[Math.min(requests.length - 1, responses.length - 1)]!
    },
  }
}
const call = (name: string, input: Record<string, unknown>): ChatResponse => ({ text: '', stop: 'tool_use', toolCalls: [{ id: `${name}_${Math.random()}`, name, input }] })

// 用组件目录的临时副本：orchestrator 可能起草组件，绝不能写进仓库
let componentsCopy: string
let registry: ComponentRegistry
let services: AgentServices
beforeAll(async () => {
  componentsCopy = await mkdtemp(join(tmpdir(), 'uta-services-components-'))
  await cp(join(repo, 'components/skills'), join(componentsCopy, 'skills'), { recursive: true })
  registry = new ComponentRegistry(componentsCopy, repo)
  await registry.loadSkills()
  services = new AgentServices({ registry, llmFor: () => new MockAdapter() })
})
afterAll(async () => rm(componentsCopy, { recursive: true, force: true }))

describe('compile', () => {
  it('四条演示用例：先加载 case-to-steps，再提交合法计划', async () => {
    for (const index of demoCases.keys()) {
      const compiled = await services.compile(demo(index), project)
      expect(validatePlanSteps(compiled.steps)).toEqual([])
      expect(compiled.model).toBe('mock/rules')
      const tools = compiled.transcript.filter((event) => event.type === 'tool')
      expect(tools.map((event) => event.name)).toEqual(['load_skill', 'load_skill', 'propose_plan'])
      expect(tools.slice(0, 2).map((event) => (event.input as { name: string }).name)).toEqual(['case-to-flow', 'case-to-steps'])
    }
    const login = await services.compile(demo(0), project)
    expect(login.steps.map((step) => step.action)).toEqual(['goto', 'fill', 'fill', 'click', 'assertVisible'])
    expect(login.steps.map((step) => step.stage)).toEqual(['action', 'action', 'action', 'action', 'verify'])
  })

  it('规则引擎：用例引用但没有数据的 key 声明为待人补充', async () => {
    const out = await services.compile(testCase({ steps: ['在「兑换码」中填入「${data.vipCode}」'], expected: ['页面显示「兑换成功」'] }), project)
    expect(out.data).toEqual([{ key: 'vipCode', source: 'human', reason: expect.any(String) as string }])
    const known = await services.compile(testCase({ steps: ['在「兑换码」中填入「${data.vipCode}」'], expected: ['页面显示「兑换成功」'], data: { vipCode: 'x' } }), project)
    expect(known.data).toEqual([])
  })

  it('真实模型路径：查测试数据目录 → 提交带阶段 / 数据 / 决策点的计划；目录里没有的 ref 被退回后修正', async () => {
    const catalogProject: Project = {
      ...project,
      testData: [
        { key: 'task.iat', description: '图像任务', value: '42', tags: ['task', 'image'] },
        { key: 'task.asr', description: '音频任务', value: '', tags: ['task', 'audio'] },
      ],
    }
    const steps: Step[] = [
      { id: 's1', stage: 'setup', action: 'goto', value: 'task?taskId=${data.taskId}' },
      { id: 's2', stage: 'decision', action: 'click', target: { role: 'option', name: '合格数据' } },
      { id: 's3', stage: 'verify', action: 'assertHidden', target: { role: 'tab', name: '${data.node}' } },
    ]
    const data = [{ key: 'taskId', source: 'catalog', ref: 'task.iat', reason: '有数据' }, { key: 'node', source: 'human', reason: 'Canvas 造不出' }]
    const decisions = [{ id: 'd1', question: '转移到哪', options: ['合格数据', '标注'], chosen: '合格数据', reason: '避开 C6', stepIds: ['s2'] }]
    const llm = scripted([
      call('list_test_data', { tags: ['task'] }),
      call('propose_plan', { steps, data: [{ ...data[0], ref: 'task.nope' }, data[1]], decisions }),
      call('propose_plan', { steps, data, decisions, rationale: '拦截流程' }),
    ])
    const local = new AgentServices({ registry, llmFor: () => llm })
    const source = { section: 'C. 节点增删改', siblings: ['02-C6 目标为标注节点时需额外选择接收团队'] }
    const out = await local.compile(testCase({ steps: ['删除有数据的节点'], expected: ['删除有数据的节点'] }), catalogProject, { source })

    expect(out).toMatchObject({ steps, data, decisions, rationale: '拦截流程' })
    const tools = out.transcript.filter((event) => event.type === 'tool')
    expect(tools.map((event) => [event.name, event.isError])).toEqual([['list_test_data', false], ['propose_plan', true], ['propose_plan', false]])
    expect(tools[0]!.output).toContain('task.iat = 42')
    expect(tools[0]!.output).toContain('task.asr = （未配置）')
    expect(tools[0]!.output).toContain('{{ts}}')
    expect(tools[1]!.output).toContain('没有条目 task.nope')
    expect(extractPayload(llm.requests[0]!.messages)).toMatchObject({ source })
    expect(llm.requests[0]!.system).toContain('list_test_data 查看')
  })

  it('list_test_data 按 tags 与关键词过滤；没有目录时如实说明', async () => {
    const catalogProject: Project = { ...project, testData: [{ key: 'task.iat', description: '图像任务', value: '42', tags: ['task', 'image'] }, { key: 'file.voc', description: 'VOC 样本', value: '/d/voc', tags: ['file'] }] }
    const outputs = async (target: Project, input: Record<string, unknown>) => {
      const llm = scripted([call('list_test_data', input), { text: '不做', stop: 'end', toolCalls: [] }])
      const failure = await new AgentServices({ registry, llmFor: () => llm }).compile(testCase({}), target).catch((e: unknown) => e) as AgentFailure
      return failure.transcript.find((event) => event.type === 'tool')!.output
    }
    expect(await outputs(catalogProject, { tags: ['file'] })).not.toContain('task.iat')
    expect(await outputs(catalogProject, { query: '图像' })).toContain('task.iat')
    expect(await outputs(catalogProject, { query: '点云' })).toContain('没有匹配的条目')
    expect(await outputs(project, {})).toContain('本项目没有测试数据目录')
  })

  it('规则引擎无法理解时抛 AgentFailure 并带过程记录', async () => {
    const failure = await services.compile(testCase({ steps: ['随便点点'], expected: ['看起来不错'] }), project).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentFailure)
    expect((failure as AgentFailure).message).toContain('随便点点')
    expect((failure as AgentFailure).transcript.length).toBeGreaterThan(0)
  })

  it('不合格计划被门禁退回，模型修正后通过', async () => {
    const good: Step[] = [{ id: 's1', action: 'goto', value: 'a.html' }, { id: 's2', action: 'assertUrl', expect: 'a' }]
    const llm = scripted([
      call('propose_plan', { steps: [{ id: 's1', action: 'click' }] }),
      call('propose_plan', { steps: good, rationale: '修正' }),
    ])
    const local = new AgentServices({ registry, llmFor: () => llm })
    const out = await local.compile(testCase({}), project)
    expect(out.steps).toEqual(good)
    const rejected = out.transcript.find((event) => event.type === 'tool' && event.isError)
    expect(rejected).toMatchObject({ name: 'propose_plan' })
    expect(JSON.stringify(rejected)).toContain('需要 target')
  })

  it('系统提示包含角色、组件目录与项目知识 skill；只提供该角色白名单工具', async () => {
    const llm = scripted([{ text: '不做', stop: 'end', toolCalls: [] }])
    const local = new AgentServices({ registry, llmFor: () => llm })
    await local.compile(testCase({}), { ...project, knowledgeSkills: ['molar-platform'] }).catch(() => undefined)
    const request = llm.requests[0]!
    expect(request.role).toBe('compiler')
    expect(request.system).toContain(ROLES.compiler.persona)
    expect(request.system).toContain('case-to-steps：')
    expect(request.system).toContain('case-to-flow：')
    expect(request.system).toContain('molar-platform（请一并加载）')
    expect(request.tools.map((tool) => tool.name).sort()).toEqual(['list_components', 'list_flows', 'list_test_data', 'load_skill', 'propose_plan'])
  })

  it('list_flows 列出积木与登录会话；propose_plan 退回不存在的积木、非法参数和提前引用积木输出', async () => {
    const flows: FlowSpec[] = [{
      id: 'shop.openOrder', description: '打开订单页', paramsSchema: { type: 'object' }, outputs: ['orderId'],
      validate: (params) => ((params as { id?: unknown }).id === undefined ? ['缺少 id'] : []),
    }]
    const loginProject: Project = { ...project, login: LoginConfigSchema.parse({ accounts: { admin: { configured: true } } }) }
    const good: Step[] = [
      { id: 's1', action: 'use', flow: 'shop.openOrder', params: { id: '1' } },
      { id: 's2', action: 'assertText', target: { text: '订单' }, expect: '${data.orderId}' },
    ]
    const llm = scripted([
      call('list_flows', {}),
      call('propose_plan', { steps: [{ id: 's1', action: 'use', flow: 'shop.nope' }, good[1]] }),
      call('propose_plan', { steps: [{ ...good[0], params: {} }, good[1]] }),
      call('propose_plan', { steps: [good[1], good[0]] }),
      call('propose_plan', { steps: good }),
    ])
    const out = await new AgentServices({ registry, llmFor: () => llm }).compile(testCase({}), loginProject, { flows })
    expect(out.steps).toEqual(good)
    const tools = out.transcript.filter((event) => event.type === 'tool')
    expect(tools[0]!.output).toContain('计划里不要写登录步骤')
    expect(tools[0]!.output).toContain('shop.openOrder：打开订单页')
    expect(tools.slice(1).map((event) => event.isError)).toEqual([true, true, true, false])
    expect(tools[1]!.output).toContain('项目没有积木 shop.nope')
    expect(tools[2]!.output).toContain('缺少 id')
    expect(tools[3]!.output).toContain('产出之前引用')
    expect(llm.requests[0]!.system).toContain('list_flows 查看')

    const bare = scripted([call('list_flows', {}), { text: '不做', stop: 'end', toolCalls: [] }])
    const failure = await new AgentServices({ registry, llmFor: () => bare }).compile(testCase({}), project).catch((e: unknown) => e) as AgentFailure
    expect(failure.transcript.find((event) => event.type === 'tool')!.output).toBe('本项目没有配置登录。\n本项目没有流程积木。')
  })
})

describe('triage', () => {
  const steps: Step[] = [{ id: 's1', action: 'goto', value: 'a.html' }, { id: 's2', action: 'click', target: { role: 'button', name: '提交' } }, { id: 's3', action: 'assertVisible', target: { text: '成功' } }]

  it('定位失败 → step-defect，建议来自 ARIA 快照', async () => {
    const out = await services.triage({ testCase: testCase({}), runId: 'r', steps, failedStepId: 's2', result: { stepId: 's2', status: 'failed', durationMs: 1, screenshot: 'e/1.png', error: { kind: 'locator', message: 'Timeout' }, ariaSnapshot: '- button "保存"' } })
    expect(out.verdict).toMatchObject({ verdict: 'step-defect' })
    expect(out.verdict.suggestion).toContain('「保存」')
  })

  it('准备阶段的可见性检查失败 → step-defect，摘要用定位文字而不是 expect 里的说明', async () => {
    const setup: Step[] = [{ id: 's3', stage: 'setup', action: 'assertVisible', target: { role: 'button', name: '导入数据' }, expect: '确认当前账号可见导入入口' }]
    const out = await services.triage({
      testCase: testCase({}), runId: 'r', steps: setup, failedStepId: 's3',
      result: { stepId: 's3', status: 'failed', durationMs: 1, screenshot: 'e/3.png', actual: '不可见或不存在', error: { kind: 'assertion', message: '元素不可见' }, ariaSnapshot: '- generic: 导入数据' },
    })
    expect(out.verdict).toMatchObject({ verdict: 'step-defect', summary: 's3 找不到「导入数据」' })
  })

  it('断言失败 → product-defect', async () => {
    const out = await services.triage({ testCase: testCase({}), runId: 'r', steps, failedStepId: 's3', result: { stepId: 's3', status: 'failed', durationMs: 1, screenshot: 'e/2.png', actual: '失败', error: { kind: 'assertion', message: 'x' } } })
    expect(out.verdict).toMatchObject({ verdict: 'product-defect', expected: '成功', actual: '失败' })
  })

  it('结论不满足证据要求会被退回；始终不修正则 AgentFailure', async () => {
    const llm = scripted([call('record_verdict', { verdict: 'product-defect', severity: 'high', summary: '坏了' })])
    const local = new AgentServices({ registry, llmFor: () => llm })
    const failure = await local.triage({ testCase: testCase({}), runId: 'r', steps, failedStepId: 's3', result: { stepId: 's3', status: 'failed', durationMs: 1, error: { kind: 'assertion', message: 'x' } } }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentFailure)
    const errors = (failure as AgentFailure).transcript.filter((event) => event.type === 'tool' && event.isError)
    expect(JSON.stringify(errors)).toContain('必须写明 expected')
  })

  it('截图作为图片随首条消息发给模型', async () => {
    const llm = scripted([call('record_verdict', { verdict: 'env-flaky', severity: 'low', summary: '网络' })])
    const local = new AgentServices({ registry, llmFor: () => llm })
    await local.triage({ testCase: testCase({}), runId: 'r', steps, failedStepId: 's1', result: { stepId: 's1', status: 'failed', durationMs: 1, error: { kind: 'navigation', message: 'x' } }, screenshot: { mediaType: 'image/png', base64: 'QUJD' } })
    const first = llm.requests[0]!.messages[0]!
    expect(first.role === 'user' && first.images).toEqual([{ mediaType: 'image/png', base64: 'QUJD' }])
    expect(llm.requests[0]!.tools.map((t) => t.name).sort()).toEqual(['load_skill', 'record_verdict'])
  })
})

describe('repair', () => {
  const steps: Step[] = [{ id: 's1', action: 'goto', value: 'p.html' }, { id: 's2', action: 'click', target: { role: 'button', name: '提交' } }, { id: 's3', action: 'assertVisible', target: { text: '已保存' } }]
  const finding = { id: 'f1', stepId: 's2', verdict: 'step-defect', summary: 'x' } as Finding

  it('按指点修正且属于免审小修；原有数据与决策点原样保留', async () => {
    const data = [{ key: 'x', source: 'generated' as const, value: 'v' }]
    const decisions = [{ id: 'd1', question: 'q', options: ['a'], chosen: 'a', reason: 'r', stepIds: ['s2'] }]
    const out = await services.repair({ testCase: testCase({}), project, steps, data, decisions, finding, feedback: { id: 'fb', findingId: 'f1', kind: 'fix-step', content: '按钮叫「保存」', createdAt: 0 } })
    expect(out.steps[1]?.target).toEqual({ role: 'button', name: '保存' })
    expect(planNeedsHumanApproval({ steps, data, decisions }, out)).toBe(false)
  })

  it('指点无法理解时 AgentFailure，提示用「」', async () => {
    const failure = await services.repair({ testCase: testCase({}), project, steps, finding, feedback: { id: 'fb', findingId: 'f1', kind: 'fix-step', content: '按钮名字不对', createdAt: 0 } }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentFailure)
    expect((failure as Error).message).toContain('「」')
  })
})

describe('token 用量', () => {
  it('成功与 AgentFailure 各上报一次：scope、角色、模型、项目与累计用量', async () => {
    const reports: AgentUsage[] = []
    const good: Step[] = [{ id: 's1', action: 'goto', value: 'a.html' }, { id: 's2', action: 'assertUrl', expect: 'a' }]
    const llm = scripted([
      { ...call('load_skill', { name: 'case-to-flow' }), usage: { input: 100, output: 10 } },
      { ...call('propose_plan', { steps: good }), usage: { input: 150, output: 40 } },
    ])
    await new AgentServices({ registry, llmFor: () => llm, onUsage: (usage) => reports.push(usage) }).compile(testCase({ id: 'case_u' }), project)
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toEqual({ scope: 'compile:case_u', role: 'compiler', model: 'fake/script', projectId: 'demo', input: 250, output: 50, calls: 2 })

    const refusing = scripted([{ text: '不做', stop: 'end', toolCalls: [], usage: { input: 7, output: 1 } }])
    const failure = await new AgentServices({ registry, llmFor: () => refusing, onUsage: (usage) => reports.push(usage) }).compile(testCase({ id: 'case_f' }), project).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(AgentFailure)
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports[1]).toMatchObject({ scope: 'compile:case_f', input: 7, output: 1, calls: 1 })
  })

  it('模型一次都没调通不上报；报告总结按项目记 scope；上报方抛错不影响 Agent', async () => {
    const reports: AgentUsage[] = []
    const broken: LlmAdapter = { provider: 'fake', model: 'down', chat: async () => { throw new Error('网络断了') } }
    await expect(new AgentServices({ registry, llmFor: () => broken, onUsage: (usage) => reports.push(usage) }).compile(testCase({}), project)).rejects.toThrow('网络断了')
    await new AgentServices({ registry, llmFor: () => new MockAdapter(), onUsage: (usage) => reports.push(usage) }).summarize({ summary: {}, defects: [], open: [] }, 'demo')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ scope: 'report:demo', role: 'reporter', projectId: 'demo', model: 'mock/rules', input: 0, output: 0, calls: 1 })
    const throwing = new AgentServices({ registry, llmFor: () => new MockAdapter(), onUsage: () => { throw new Error('写盘失败') } })
    expect(await throwing.summarize({ summary: {}, defects: [], open: [] })).toBeTruthy()
  })
})

describe('ask / summarize', () => {
  it('非组件请求：列出本角色可见的组件后以文本回答，不起草任何东西', async () => {
    const out = await services.ask('你好，介绍一下平台')
    expect(out.text).toContain('component-forge')
    expect(out.text).not.toContain('case-to-steps') // 编译专用 skill 对编排角色不可见
    expect(out.transcript.filter((event) => event.type === 'tool').map((event) => event.name)).toEqual(['list_components'])
    expect(await registry.listDrafts()).toEqual([])
  })

  it('组件请求：起草组件草稿（写入临时组件目录）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uta-services-'))
    try {
      const local = new ComponentRegistry(dir)
      await local.load()
      await new AgentServices({ registry: local, llmFor: () => new MockAdapter() }).ask('需要一个校验 PDF 的组件')
      expect((await local.listDrafts()).map((draft) => draft.kind)).toEqual(['skill'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('报告总结使用 reporter 角色、不提供任何工具', async () => {
    const text = await services.summarize({ summary: { cases: 4, passed: 3, failed: 1, defects: 1, open: 0 }, defects: ['计数错误'], open: [] })
    expect(text).toBe('共 4 条用例：通过 3，未通过 1，已确认缺陷 1，待处理门禁 0。')
    expect(ROLES.reporter.tools).toEqual([])
  })
})

describe('mock 适配器', () => {
  it('从首条用户消息的 json 代码块读取输入', () => {
    expect(extractPayload([{ role: 'user', content: '说明\n\n```json\n{"a":1}\n```' }])).toEqual({ a: 1 })
    expect(extractPayload([{ role: 'user', content: '没有代码块' }])).toEqual({})
  })
})
