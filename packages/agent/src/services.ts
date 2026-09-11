/**
 * 面向 Pipeline 的 Agent 服务：每个方法 = 一个角色跑一次 Agent Loop，
 * 终结工具的输入经过与门禁相同的校验才会被接受（不合格以 is_error 回给模型重试）。
 */
import { z } from 'zod'
import {
  SEVERITIES, StepSchema, VERDICTS, validateFinding, validatePlanSteps,
  type Feedback, type Finding, type Project, type Step, type StepResult, type TestCase,
} from '@uta/core'
import type { ImageInput, LlmAdapter } from './llm/types'
import { runAgent, type AgentEvent, type AgentRunResult, type AgentTool } from './loop'
import type { ComponentRegistry } from './registry'
import { ROLES, type RoleName } from './roles'
import type { TriageOutput } from './heuristics'

const PlanProposal = z.object({ steps: z.array(StepSchema).min(1), rationale: z.string().optional() })
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

export interface AgentDeps {
  registry: ComponentRegistry
  llmFor(role: RoleName): LlmAdapter
  /** scope 形如 compile:<caseId>、triage:<runId>，server 据此推送到前端 */
  onEvent?(scope: string, event: AgentEvent): void
}

export interface AgentOutcome {
  transcript: AgentEvent[]
  model: string
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
        run: async (input) => registry.loadSkillBody(String(input['name'] ?? '')),
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
  }): Promise<AgentRunResult> {
    const def = ROLES[role]
    const system = [
      def.persona,
      this.deps.registry.catalogFor(role),
      def.requiredSkills.length === 0 ? '' : `开工前先用 load_skill 读取：${def.requiredSkills.join('、')}。`,
      def.terminalTool === undefined ? '' : `完成后必须调用 ${def.terminalTool} 提交结果；被拒绝时按返回的问题修正后重新提交。`,
      input.context ?? '',
    ].filter((line) => line !== '').join('\n\n')
    return runAgent({
      role,
      system,
      userText: `${input.instruction}\n\n\`\`\`json\n${JSON.stringify(input.payload, null, 2)}\n\`\`\``,
      ...(input.images === undefined ? {} : { images: input.images }),
      tools: [...this.builtinTools(role), ...(input.tools ?? []), ...this.deps.registry.mcpToolsFor(role)],
      llm: this.deps.llmFor(role),
      onEvent: (event) => this.deps.onEvent?.(scope, event),
    })
  }

  private planTool(onAccept: (plan: z.infer<typeof PlanProposal>) => void): AgentTool {
    return {
      terminal: true,
      spec: { name: 'propose_plan', description: '提交 Step DSL 计划。会按门禁规则校验，不合格会返回问题清单。', inputSchema: jsonSchema(PlanProposal) },
      run: async (input) => {
        const plan = parseInput(PlanProposal, input)
        const problems = validatePlanSteps(plan.steps)
        if (problems.length > 0) throw new Error(`计划未通过校验：\n${problems.join('\n')}`)
        onAccept(plan)
        return `计划已接受，共 ${plan.steps.length} 步`
      },
    }
  }

  async compile(testCase: TestCase, project: Project): Promise<AgentOutcome & { steps: Step[]; rationale?: string }> {
    let accepted: z.infer<typeof PlanProposal> | undefined
    const knowledge = project.knowledgeSkills.length === 0 ? '' : `\n本项目的领域知识 skill：${project.knowledgeSkills.join('、')}（请一并加载）`
    const result = await this.run('compiler', `compile:${testCase.id}`, {
      context: `被测项目：${project.name}，baseURL=${project.baseURL}${knowledge}`,
      instruction: '请把下面的测试用例编译成 Step DSL，并调用 propose_plan 提交。',
      payload: {
        case: {
          title: testCase.title, module: testCase.module, preconditions: testCase.preconditions,
          steps: testCase.steps, expected: testCase.expected, dataKeys: Object.keys(testCase.data), notes: testCase.notes,
        },
      },
      tools: [this.planTool((plan) => { accepted = plan })],
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '编译 Agent 没有提交计划', result.transcript)
    return { steps: accepted.steps, ...(accepted.rationale === undefined ? {} : { rationale: accepted.rationale }), transcript: result.transcript, model: result.model }
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
        accepted = verdict as TriageOutput
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
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '归因 Agent 没有提交结论', result.transcript)
    return { verdict: accepted, transcript: result.transcript, model: result.model }
  }

  async repair(input: {
    testCase: TestCase
    steps: readonly Step[]
    finding: Finding
    feedback: Feedback
  }): Promise<AgentOutcome & { steps: Step[]; rationale?: string }> {
    let accepted: z.infer<typeof PlanProposal> | undefined
    const result = await this.run('repairer', `repair:${input.finding.id}`, {
      instruction: '人对失败给出了反馈。请据此修正计划（保持无关步骤与 id 不变），并调用 propose_plan 提交修正后的完整计划。',
      payload: {
        case: { title: input.testCase.title, steps: input.testCase.steps, expected: input.testCase.expected },
        steps: input.steps,
        finding: { stepId: input.finding.stepId, verdict: input.finding.verdict, summary: input.finding.summary, suggestion: input.finding.suggestion },
        feedback: { kind: input.feedback.kind, content: input.feedback.content, stepPatches: input.feedback.stepPatches },
      },
      tools: [this.planTool((plan) => { accepted = plan })],
    })
    if (accepted === undefined) throw new AgentFailure(result.text || '修正 Agent 没有提交计划', result.transcript)
    return { steps: accepted.steps, ...(accepted.rationale === undefined ? {} : { rationale: accepted.rationale }), transcript: result.transcript, model: result.model }
  }

  /** 开放式请求：orchestrator 自行决定调用哪些组件，或起草新组件 */
  async ask(request: string): Promise<AgentOutcome & { text: string }> {
    const result = await this.run('orchestrator', 'ask', { instruction: '请处理下面的请求。', payload: { request } })
    return { text: result.text, transcript: result.transcript, model: result.model }
  }

  async summarize(payload: { summary: Record<string, number>; defects: string[]; open: string[] }): Promise<string> {
    const result = await this.run('reporter', 'report', { instruction: '请为下面的测试结果写一段 3-6 句的中文总结。', payload })
    return result.text
  }
}
