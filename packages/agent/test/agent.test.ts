import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { needsHumanApproval, validatePlanSteps, type Finding, type Project, type TestCase } from '@uta/core'
import { AgentServices, ComponentRegistry, MockAdapter, runAgent, type LlmAdapter } from '../src'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const demoCases = JSON.parse(await readFile(join(repo, 'projects/demo/cases.json'), 'utf8')) as Partial<TestCase>[]
const project: Project = { id: 'demo', name: '演示', baseURL: 'http://x/demo/', authRoles: {}, slowMo: 0, viewport: { width: 1, height: 1 }, knowledgeSkills: [], importers: {} }

function testCase(index: number): TestCase {
  return { id: `case_${index}`, projectId: 'demo', preconditions: [], data: {}, notes: [], version: 1, createdAt: 0, updatedAt: 0, steps: [], expected: [], title: '', ...demoCases[index] } as TestCase
}

let services: AgentServices
beforeAll(async () => {
  const registry = new ComponentRegistry(join(repo, 'components'))
  await registry.load()
  services = new AgentServices({ registry, llmFor: () => new MockAdapter() })
})

describe('mock Agent 走完整链路', () => {
  it('编译全部演示用例，先加载 skill 再提交合法计划', async () => {
    for (const index of demoCases.keys()) {
      const compiled = await services.compile(testCase(index), project)
      expect(validatePlanSteps(compiled.steps)).toEqual([])
      expect(compiled.transcript.some((event) => event.type === 'tool' && event.name === 'load_skill' && !event.isError)).toBe(true)
    }
    const login = await services.compile(testCase(0), project)
    expect(login.steps.map((step) => step.action)).toEqual(['goto', 'fill', 'fill', 'click', 'assertVisible'])
  })

  it('定位失败 → step-defect，并从 ARIA 快照给出候选', async () => {
    const steps = (await services.compile(testCase(1), project)).steps
    const out = await services.triage({
      testCase: testCase(1), runId: 'run_x', steps, failedStepId: 's3',
      result: { stepId: 's3', status: 'failed', durationMs: 1, screenshot: 'e/1.png', error: { kind: 'locator', message: 'Timeout 8000ms exceeded' }, ariaSnapshot: '- heading "个人资料"\n- button "保存"' },
    })
    expect(out.verdict.verdict).toBe('step-defect')
    expect(out.verdict.suggestion).toContain('「保存」')
  })

  it('断言失败 → product-defect，实际值取相近内容', async () => {
    const steps = (await services.compile(testCase(3), project)).steps
    const last = steps.at(-1)!
    const out = await services.triage({
      testCase: testCase(3), runId: 'run_y', steps, failedStepId: last.id,
      result: { stepId: last.id, status: 'failed', durationMs: 1, screenshot: 'e/2.png', actual: '不可见或不存在', error: { kind: 'assertion', message: '元素不可见' }, ariaSnapshot: '- listitem: 写周报\n- paragraph: 共 1 项' },
    })
    expect(out.verdict.verdict).toBe('product-defect')
    expect(out.verdict.actual).toContain('共 1 项')
  })

  it('人指点「保存」→ 修正计划且属于免审小修', async () => {
    const steps = (await services.compile(testCase(1), project)).steps
    const finding = { id: 'f1', stepId: 's3', verdict: 'step-defect', summary: 'x' } as Finding
    const repaired = await services.repair({ testCase: testCase(1), steps, finding, feedback: { id: 'fb', findingId: 'f1', kind: 'fix-step', content: '按钮叫「保存」', createdAt: 0 } })
    expect(repaired.steps[2]?.target).toEqual({ role: 'button', name: '保存' })
    expect(needsHumanApproval(steps, repaired.steps)).toBe(false)
  })

  it('orchestrator 缺能力时起草组件，人批准后热加载', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uta-components-'))
    try {
      const registry = new ComponentRegistry(dir)
      await registry.load()
      const local = new AgentServices({ registry, llmFor: () => new MockAdapter() })
      await local.ask('需要一个能校验 PDF 下载内容的组件')
      const drafts = await registry.listDrafts()
      expect(drafts).toHaveLength(1)
      await registry.approveDraft(drafts[0]!.name)
      expect(registry.skills.has(drafts[0]!.name)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Agent Loop', () => {
  it('白名单外的工具不执行，校验失败以错误回传', async () => {
    let turn = 0
    const llm: LlmAdapter = {
      provider: 'fake', model: 'fake',
      async chat() {
        turn += 1
        if (turn === 1) return { text: '', stop: 'tool_use', toolCalls: [{ id: '1', name: 'rm_rf', input: {} }, { id: '2', name: 'submit', input: { ok: false } }] }
        if (turn === 2) return { text: '', stop: 'tool_use', toolCalls: [{ id: '3', name: 'submit', input: { ok: true } }] }
        return { text: 'unreachable', stop: 'end', toolCalls: [] }
      },
    }
    const result = await runAgent({
      role: 'compiler', system: '', userText: 'go', llm,
      tools: [{ terminal: true, spec: { name: 'submit', description: '', inputSchema: { type: 'object' } }, run: async (input) => { if (input['ok'] !== true) throw new Error('not ok'); return 'ok' } }],
    })
    const tools = result.transcript.filter((event) => event.type === 'tool')
    expect(tools.map((event) => [event.name, event.isError])).toEqual([['rm_rf', true], ['submit', true], ['submit', false]])
    expect(result.terminal?.name).toBe('submit')
    expect(turn).toBe(2)
  })
})
