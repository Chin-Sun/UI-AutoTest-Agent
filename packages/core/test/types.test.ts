/** 领域模型 schema：默认值、合法取值与拒绝边界 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY, FeedbackSchema, FindingSchema, ProjectSchema, RunSchema, STEP_ACTIONS, StepPlanSchema, StepSchema,
  TargetSchema, TestCaseSchema,
} from '../src'

describe('TargetSchema', () => {
  it.each([
    [{ testId: 'welcome' }],
    [{ role: 'button', name: '登录' }],
    [{ role: 'link' }],
    [{ label: '用户名' }],
    [{ placeholder: '新待办' }],
    [{ text: '欢迎', exact: true }],
    [{ css: '#app > .x' }],
  ])('接受 %j', (target) => {
    expect(TargetSchema.parse(target)).toEqual(target)
  })

  it.each([[{}], [{ testId: '' }], [{ name: '登录' }], [{ label: '' }]])('拒绝 %j', (target) => {
    expect(TargetSchema.safeParse(target).success).toBe(false)
  })
})

describe('StepSchema', () => {
  it('覆盖全部 18 个动作', () => {
    expect(STEP_ACTIONS).toHaveLength(18)
    for (const action of STEP_ACTIONS) expect(StepSchema.safeParse({ id: 's1', action }).success).toBe(true)
  })

  it('拒绝未知动作、空 id、非正超时', () => {
    expect(StepSchema.safeParse({ id: 's1', action: 'drag' }).success).toBe(false)
    expect(StepSchema.safeParse({ id: '', action: 'click' }).success).toBe(false)
    expect(StepSchema.safeParse({ id: 's1', action: 'click', timeoutMs: 0 }).success).toBe(false)
    expect(StepSchema.safeParse({ id: 's1', action: 'click', caseRef: -1 }).success).toBe(false)
  })
})

describe('TestCaseSchema', () => {
  it('补齐数组与数据默认值', () => {
    const parsed = TestCaseSchema.parse({ id: 'c', projectId: 'p', title: 't', version: 1, createdAt: 0, updatedAt: 0 })
    expect(parsed).toMatchObject({ preconditions: [], steps: [], expected: [], data: {}, notes: [] })
  })

  it('标题不能为空，版本从 1 开始', () => {
    expect(TestCaseSchema.safeParse({ id: 'c', projectId: 'p', title: '', version: 1, createdAt: 0, updatedAt: 0 }).success).toBe(false)
    expect(TestCaseSchema.safeParse({ id: 'c', projectId: 'p', title: 't', version: 0, createdAt: 0, updatedAt: 0 }).success).toBe(false)
  })
})

describe('StepPlanSchema', () => {
  it('计划至少 1 步，状态只能是四种之一', () => {
    const base = { id: 'p', caseId: 'c', version: 1, status: 'draft', createdBy: 'agent', createdAt: 0 }
    expect(StepPlanSchema.safeParse({ ...base, steps: [] }).success).toBe(false)
    expect(StepPlanSchema.safeParse({ ...base, steps: [{ id: 's1', action: 'goto', value: '/' }] }).success).toBe(true)
    expect(StepPlanSchema.safeParse({ ...base, status: 'running', steps: [{ id: 's1', action: 'goto' }] }).success).toBe(false)
  })
})

describe('RunSchema', () => {
  it('默认无头、不录 OBS、证据为空', () => {
    const run = RunSchema.parse({ id: 'r', caseId: 'c', projectId: 'p', planId: 'pl', planVersion: 1, round: 1, attempt: 1, attemptId: 'a', trigger: 'manual', status: 'queued', createdAt: 0 })
    expect(run.options).toEqual({ headed: false, obs: false })
    expect(run.evidence).toEqual({})
    expect(run.stepResults).toEqual([])
  })
})

describe('FindingSchema', () => {
  const base = {
    id: 'f', caseId: 'c', projectId: 'p', runId: 'r', planId: 'pl', verdict: 'step-defect', severity: 'medium',
    summary: 'x', triagedBy: 'rule', status: 'awaiting_human', round: 1, createdAt: 0, updatedAt: 0,
  }
  it('合法 Finding 补齐 feedbackIds 与 evidence', () => {
    expect(FindingSchema.parse(base)).toMatchObject({ feedbackIds: [], evidence: {} })
  })
  it.each([['verdict', 'bug'], ['status', 'open'], ['severity', 'critical'], ['summary', ''], ['round', 0]])('拒绝非法 %s=%j', (field, value) => {
    expect(FindingSchema.safeParse({ ...base, [field]: value }).success).toBe(false)
  })
})

describe('FeedbackSchema', () => {
  it('步骤补丁不能改 id（会被剥离）', () => {
    const parsed = FeedbackSchema.parse({ id: 'fb', findingId: 'f', kind: 'fix-step', createdAt: 0, stepPatches: [{ stepId: 's1', patch: { id: 'evil', value: 'x' } }] })
    expect(parsed.stepPatches?.[0]?.patch).toEqual({ value: 'x' })
    expect(parsed.content).toBe('')
  })
})

describe('ProjectSchema', () => {
  it('补齐默认值，超时可选', () => {
    const project = ProjectSchema.parse({ id: 'demo', name: '演示', baseURL: 'http://x/' })
    expect(project).toMatchObject({ authRoles: {}, slowMo: 0, viewport: { width: 1280, height: 800 }, knowledgeSkills: [], importers: {} })
    expect(project.actionTimeoutMs).toBeUndefined()
    expect(ProjectSchema.safeParse({ id: 'd', name: 'd', baseURL: 'x', actionTimeoutMs: -1 }).success).toBe(false)
  })
})

describe('DEFAULT_POLICY', () => {
  it('默认 3 轮升级，flaky 重试 1 次', () => {
    expect(DEFAULT_POLICY).toEqual({ maxRounds: 3, flakyRetries: 1 })
  })
})
