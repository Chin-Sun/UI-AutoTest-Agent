/**
 * 面向 Pipeline 的 Agent 服务：每个方法 = 一个角色跑一次 Agent Loop，
 * 终结工具的输入经过与门禁相同的校验才会被接受（不合格以 is_error 回给模型重试）。
 */
import { z } from 'zod'
import {
  DataBindingSchema, DecisionSchema, SEVERITIES, StepSchema, VERDICTS, validateFinding, validatePlanData, validatePlanFlows, validatePlanSteps,
  type DataBinding, type Decision, type Feedback, type Finding, type FlowSpec, type PlanDataContext, type Project, type Step,
  type StepResult, type TestCase,
} from '@uta/core'
import type { ImageInput, LlmAdapter } from './llm/types'
import { runAgent, type AgentEvent, type AgentRunResult, type AgentTool } from './loop'
import type { ComponentRegistry } from './registry'
import { ROLES, type RoleName } from './roles'
import type { TriageOutput } from './heuristics'

const PlanProposal = z.object({
  steps: z.array(StepSchema).min(1),
  data: z.array(DataBindingSchema).optional(),
  decisions: z.array(DecisionSchema).optional(),
  rationale: z.string().optional(),
})
const TestDataQuery = z.object({
  tags: z.array(z.string()).optional().describe('全部命中才返回，如 ["task","image"]'),
  query: z.string().optional().describe('按 key 或说明里的关键词过滤'),
})
const VerdictProposal = z.object({
  verdict: z.enum(VERDICTS),
  severity: z.enum(SEVERITIES),
  summary: z.string().min(1),
  expected: z.string().optional(),
  actual: z.string().optional(),
  suggestion: z.string().optional(),
  missingKeys: z.array(z.string()).optional(),
})
const DraftProposal = z.object({
  kind: z.enum(['skill', 'mcp']),
  name: z.string(),
  description: z.string().min(1),
  roles: z.array(z.string()).default([]),
  content: z.string().min(1),
})

const GENERATOR_HINT = '生成模板（source=generated/setup 的 value 可用）：{{case}} 用例键（如 02-C5）、{{ts}} 执行时间戳、{{rand}} 4 位随机串。例：uta-{{case}}-{{ts}}'

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error(`参数不合法：\n${z.prettifyError(result.error)}`)
  return result.data
}

export class AgentFailure extends Error {
  constructor(message: string, readonly transcript: AgentRunResult['transcript']) {
    super(message)
  }
}

/** 一次 Agent 运行的 Token 用量（成功或失败都会上报） */
export interface AgentUsage {
  scope: string
  role: RoleName
  model: string
  projectId?: string
  input: number
  output: number
  calls: number
}

export interface AgentDeps {
  registry: ComponentRegistry
  llmFor(role: RoleName): LlmAdapter
  /** scope 形如 compile:<caseId>、triage:<runId>，server 据此推送到前端 */
  onEvent?(scope: string, event: AgentEvent): void
  /** 每次运行结束（含失败）上报用量；至少调用过一次模型才上报 */
  onUsage?(usage: AgentUsage): unknown
}

export interface AgentOutcome {
  transcript: AgentEvent[]
  model: string
}

/** 编译 / 修正 Agent 提交并通过校验的计划 */
export interface CompiledPlan {
  steps: Step[]
  data: DataBinding[]
  decisions: Decision[]
  rationale?: string
}

function dataContext(testCase: TestCase, project: Project, flows: readonly FlowSpec[]): PlanDataContext {
  return { caseDataKeys: Object.keys(testCase.data), catalogKeys: project.testData.map((entry) => entry.key), flows }
}

export class AgentServices {
  constructor(private readonly deps: AgentDeps) {}

  private builtinTools(role: RoleName): AgentTool[] {
    const registry = this.deps.registry
    const builtin: Record<string, AgentTool> = {
      list_components: {
        spec: { name: 'list_components', description: '列出当前角色可用的 Skill 与 MCP 组件', inputSchema: { type: 'object', properties: {} } },
        run: async () => registry.catalogFor(role),
      },
      load_skill: {
        spec: {
          name: 'load_skill',
          description: '读取一个 Skill 的正文（规则、模板、领域知识）',
          inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'skill 名' } }, required: ['name'] },
        },
        run: async (input) => registry.loadSkillBody(typeof input['name'] === 'string' ? input['name'] : ''),
      },
      draft_component: {
        spec: { name: 'draft_component', description: '起草新的 Skill 或 MCP 组件（写入 _drafts，需人工批准后才生效）', inputSchema: jsonSchema(DraftProposal) },
        run: async (input) => {
          const draft = await registry.writeDraft(parseInput(DraftProposal, input))
          return `草稿已写入 components/_drafts/${draft.name}，等待人在「组件中心」批准`
        },
      },
    }
    return ROLES[role].tools.flatMap((name) => (builtin[name] === undefined ? [] : [builtin[name]]))
  }

  private async run(role: RoleName, scope: string, input: {
    context?: string
    instruction: string
    payload: unknown
    tools?: AgentTool[]
    images?: ImageInput[]
    projectId?: string
  }): Promise<AgentRunResult> {
    const def = ROLES[role]
    const system = [
      def.persona,
      this.deps.registry.catalogFor(role),
      def.requiredSkills.length === 0 ? '' : `开工前先用 load_skill 读取：${def.requiredSkills.join('、')}。`,
      def.terminalTool === undefined ? '' : `完成后必须调用 ${def.terminalTool} 提交结果；被拒绝时按返回的问题修正后重新提交。`,
      input.context ?? '',
    ].filter((line) => line !== '').join('\n\n')
    const llm = this.deps.llmFor(role)
    // 从事件累加而不是等返回值：模型调用中途抛错时，已经花掉的 token 也要记下
    const usage = { input: 0, output: 0, calls: 0 }
    try {
      return await runAgent({
        role,
        system,
        userText: `${input.instruction}\n\n\`\`\`json\n${JSON.stringify(input.payload, null, 2)}\n\`\`\``,
        ...(input.images === undefined ? {} : { images: input.images }),
        tools: [...this.builtinTools(role), ...(input.tools ?? []), ...this.deps.registry.mcpToolsFor(role)],
        llm,
        onEvent: (event) => {
          if (event.type === 'llm') {
            usage.calls += 1
            usage.input += event.usage?.input ?? 0
            usage.output += event.usage?.output ?? 0
          }
          this.deps.onEvent?.(scope, event)
        },
      })
    } finally {
      if (usage.calls > 0) {
        const report = { scope, role, model: `${llm.provider}/${llm.model}`, ...(input.projectId === undefined ? {} : { projectId: input.projectId }), ...usage }
        void Promise.resolve().then(() => this.deps.onUsage?.(report)).catch(() => undefined)
      }
    }
  }

  /** 项目测试数据目录：只暴露 test-data.yaml 里登记的条目 */
  private testDataTool(project: Project): AgentTool {
    return {
      spec: { name: 'list_test_data', description: '查看项目测试数据目录（任务、账号、本地素材等）与生成模板写法；可按 tags 或关键词过滤', inputSchema: jsonSchema(TestDataQuery) },
      run: async (input) => {
        const query = parseInput(TestDataQuery, input)
        const entries = project.testData.filter((entry) => (query.tags ?? []).every((tag) => entry.tags.includes(tag))
          && (query.query === undefined || `${entry.key} ${entry.description}`.includes(query.query)))
        const lines = entries.map((entry) => `- ${entry.key} = ${entry.value === undefined || entry.value === '' ? '（未配置）' : entry.value}  [${entry.tags.join(', ')}]  ${entry.description}`)
        return [
          project.testData.length === 0 ? '本项目没有测试数据目录' : entries.length === 0 ? '目录中没有匹配的条目' : `测试数据目录（${entries.length} 条）：`,
          ...lines,
          '',
          GENERATOR_HINT,
        ].join('\n')
      },
    }
  }

  /** 项目流程积木与登录会话说明 */
  private flowsTool(project: Project, flows: readonly FlowSpec[]): AgentTool {
    return {
      spec: { name: 'list_flows', description: '查看项目的流程积木（到达页面、准备前置对象等可复用步骤）与登录会话配置', inputSchema: { type: 'object', properties: {} } },
      run: async () => {
        const roles = Object.keys(project.login?.accounts ?? {})
        const session = project.login === undefined
          ? '本项目没有配置登录。'
          : `本项目已配置登录：执行前自动复用或建立会话（角色：${roles.length === 0 ? '未配置' : roles.join('、')}），计划里不要写登录步骤。`
        if (flows.length === 0) return `${session}\n本项目没有流程积木。`
        return [
          session,
          `流程积木 ${flows.length} 个。调用写法 {"action":"use","flow":"<id>","params":{…}}，输出在后续步骤里用 \${data.<key>} 引用：`,
          ...flows.map((flow) => `- ${flow.id}：${flow.description}\n  参数：${JSON.stringify(flow.paramsSchema)}\n  输出：${flow.outputs.length === 0 ? '(无)' : flow.outputs.join(', ')}`),
        ].join('\n')
      },
    }
  }

  private planTool(context: PlanDataContext, base: Pick<CompiledPlan, 'data' | 'decisions'>, onAccept: (plan: CompiledPlan) => void): AgentTool {
    return {
      terminal: true,
      spec: {
        name: 'propose_plan',
        description: '提交计划：steps（每步带 stage）、data（测试数据及来源）、decisions（决策点）。会按门禁规则校验，不合格会返回问题清单。',
        inputSchema: jsonSchema(PlanProposal),
      },
      run: async (input) => {
        const proposal = parseInput(PlanProposal, input)
        const plan: CompiledPlan = {
          steps: proposal.steps,
          data: proposal.data ?? base.data,
          decisions: proposal.decisions ?? base.decisions,
          ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
        }
        const problems = [...validatePlanSteps(plan.steps), ...validatePlanFlows(plan.steps, context.flows as FlowSpec[] | undefined ?? []), ...validatePlanData(plan, context)]
        if (problems.length > 0) throw new Error(`计划未通过校验：\n${problems.join('\n')}`)
        onAccept(plan)
        return `计划已接受，共 ${plan.steps.length} 步、${plan.data.length} 项数据、${plan.decisions.length} 个决策点`
      },
    }
  }

  /**
   * @param options.source 用例在原始文件中的上下文（清单文件头、章节、相邻条目）
   * @param options.flows 项目流程积木
   */
  async compile(testCase: TestCase, project: Project, options: { source?: unknown, flows?: readonly FlowSpec[] } = {}): Promise<AgentOutcome & CompiledPlan> {
    const flows = options.flows ?? []
    let accepted: CompiledPlan | undefined
    const knowledge = project.knowledgeSkills.length === 0 ? '' : `\n本项目的领域知识 skill：${project.knowledgeSkills.join('、')}（请一并加载）`
    const catalog = project.testData.length === 0 ? '' : `\n本项目有测试数据目录（${project.testData.length} 条），用 list_test_data 查看`
    const flowHint = flows.length === 0 && project.login === undefined ? '' : '\n本项目有流程积木或登录会话配置，用 list_flows 查看；准备阶段优先用积木到达页面，不要写登录步骤'
    const result = await this.run('compiler', `compile:${testCase.id}`, {
      context: `被测项目：${project.name}，baseURL=${project.baseURL}${knowledge}${catalog}${flowHint}`,
      instruction: '请把下面的测试用例编译成分阶段流程，并调用 propose_plan 提交。用例可能只有一句话、不是规范句式：按 case-to-flow 推断被测行为、前置条件与测试数据，信息不足时写明假设继续编译，不要放弃。source（如有）是用例在原始文件中的上下文。',
      payload: {
        case: {
          title: testCase.title, module: testCase.module, preconditions: testCase.preconditions,
          steps: testCase.steps, expected: testCase.expected, dataKeys: Object.keys(testCase.data), notes: testCase.notes,
        },
        ...(options.source === undefined ? {} : { source: options.source }),
      },
      tools: [
        this.testDataTool(project),
        this.flowsTool(project, flows),
        this.planTool(dataContext(testCase, project, flows), { data: [], decisions: [] }, (plan) => { accepted = plan }),
      ],
      projectId: project.id,
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '编译 Agent 没有提交计划', result.transcript)
    return { ...accepted, transcript: result.transcript, model: result.model }
  }

  async triage(input: {
    testCase: TestCase
    runId: string
    steps: readonly Step[]
    failedStepId: string
    result: StepResult
    screenshot?: ImageInput
  }): Promise<AgentOutcome & { verdict: TriageOutput }> {
    let accepted: TriageOutput | undefined
    const record: AgentTool = {
      terminal: true,
      spec: { name: 'record_verdict', description: '提交失败归因结论', inputSchema: jsonSchema(VerdictProposal) },
      run: async (raw) => {
        const verdict = parseInput(VerdictProposal, raw)
        const problems = validateFinding({
          ...verdict,
          stepId: input.failedStepId,
          evidence: input.result.screenshot === undefined ? {} : { screenshot: input.result.screenshot },
        })
        if (problems.length > 0) throw new Error(`结论未通过校验：\n${problems.join('\n')}`)
        accepted = verdict
        return '结论已记录'
      },
    }
    const result = await this.run('triager', `triage:${input.runId}`, {
      instruction: '下面是一次失败的执行，请归因并调用 record_verdict。截图（如有）是失败瞬间的页面。',
      payload: {
        caseTitle: input.testCase.title,
        expected: input.testCase.expected,
        steps: input.steps,
        failedStepId: input.failedStepId,
        result: input.result,
      },
      tools: [record],
      ...(input.screenshot === undefined ? {} : { images: [input.screenshot] }),
      projectId: input.testCase.projectId,
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '归因 Agent 没有提交结论', result.transcript)
    return { verdict: accepted, transcript: result.transcript, model: result.model }
  }

  async repair(input: {
    testCase: TestCase
    project: Project
    flows?: readonly FlowSpec[]
    steps: readonly Step[]
    data?: readonly DataBinding[]
    decisions?: readonly Decision[]
    finding: Finding
    feedback: Feedback
  }): Promise<AgentOutcome & CompiledPlan> {
    let accepted: CompiledPlan | undefined
    const base = { data: [...(input.data ?? [])], decisions: [...(input.decisions ?? [])] }
    const result = await this.run('repairer', `repair:${input.finding.id}`, {
      instruction: '人对失败给出了反馈。请据此修正计划（保持无关步骤、数据、决策点与 id 不变），并调用 propose_plan 提交修正后的完整计划；data 与 decisions 不变时可以省略。',
      payload: {
        case: { title: input.testCase.title, steps: input.testCase.steps, expected: input.testCase.expected, dataKeys: Object.keys(input.testCase.data) },
        steps: input.steps,
        data: base.data,
        decisions: base.decisions,
        finding: { stepId: input.finding.stepId, verdict: input.finding.verdict, summary: input.finding.summary, suggestion: input.finding.suggestion },
        feedback: { kind: input.feedback.kind, content: input.feedback.content, stepPatches: input.feedback.stepPatches },
      },
      tools: [
        this.testDataTool(input.project),
        this.flowsTool(input.project, input.flows ?? []),
        this.planTool(dataContext(input.testCase, input.project, input.flows ?? []), base, (plan) => { accepted = plan }),
      ],
      projectId: input.project.id,
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '修正 Agent 没有提交计划', result.transcript)
    return { ...accepted, transcript: result.transcript, model: result.model }
  }

  /** 开放式请求：orchestrator 自行决定调用哪些组件，或起草新组件 */
  async ask(request: string): Promise<AgentOutcome & { text: string }> {
    const result = await this.run('orchestrator', 'ask', { instruction: '请处理下面的请求。', payload: { request } })
    return { text: result.text, transcript: result.transcript, model: result.model }
  }

  /** @param projectId 有项目时 scope 为 report:<projectId>，用量计入该项目 */
  async summarize(payload: { summary: Record<string, number>, defects: string[], open: string[] }, projectId?: string): Promise<string> {
    const result = await this.run('reporter', projectId === undefined ? 'report' : `report:${projectId}`, {
      instruction: '请为下面的测试结果写一段 3-6 句的中文总结。',
      payload,
      ...(projectId === undefined ? {} : { projectId }),
    })
    return result.text
  }
}
