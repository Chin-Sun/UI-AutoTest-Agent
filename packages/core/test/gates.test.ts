import { describe, expect, it } from 'vitest'
import {
  applyFeedback, applyStepPatches, assertAttempt, assertRunTransition, canPass, canPublishReport,
  DEFAULT_POLICY, heuristicVerdict, initialFindingStatus, missingBindings, needsHumanApproval,
  resolveBindings, shouldAutoRetryFlaky, shouldEscalate, validateFinding, validatePlanSteps,
  type Step,
} from '../src'

const login: Step[] = [
  { id: 's1', action: 'goto', value: '/login' },
  { id: 's2', action: 'fill', target: { label: '用户名' }, value: '${data.user}' },
  { id: 's3', action: 'click', target: { role: 'button', name: '登录' } },
  { id: 's4', action: 'assertText', target: { testId: 'welcome' }, expect: '欢迎' },
]

describe('run 状态机与 attempt', () => {
  it('终态只读', () => {
    expect(() => assertRunTransition('passed', 'running')).toThrow(/不能/)
    expect(() => assertRunTransition('queued', 'running')).not.toThrow()
  })
  it('过期 attempt 写入被拒绝', () => {
    const run = { id: 'r1', attemptId: 'a2', status: 'running' as const }
    expect(() => assertAttempt(run, 'a1')).toThrow(/过期/)
    expect(() => assertAttempt(run, 'a2')).not.toThrow()
    expect(() => assertAttempt({ ...run, status: 'failed' }, 'a2')).toThrow(/只读/)
  })
})

describe('计划校验', () => {
  it('合法计划无问题', () => expect(validatePlanSteps(login)).toEqual([]))
  it('缺 target / value / 断言都会报出', () => {
    const problems = validatePlanSteps([{ id: 'x', action: 'click' }, { id: 'x', action: 'fill', target: { css: 'input' } }])
    expect(problems.join('\n')).toMatch(/需要 target/)
    expect(problems.join('\n')).toMatch(/需要 value/)
    expect(problems.join('\n')).toMatch(/id 重复/)
    expect(problems.join('\n')).toMatch(/断言/)
  })
})

describe('数据绑定', () => {
  it('执行前找出缺失数据', () => {
    expect(missingBindings(login, {})).toEqual(['user'])
    expect(missingBindings(login, { user: 'alice' })).toEqual([])
  })
  it('解析绑定', () => expect(resolveBindings('hi ${data.user}', { user: 'alice' })).toBe('hi alice'))
})

describe('通过判定', () => {
  it('全部步骤通过才算通过', () => {
    const passed = login.map((step) => ({ stepId: step.id, status: 'passed' as const, durationMs: 1 }))
    expect(canPass({ steps: login }, passed).ok).toBe(true)
    expect(canPass({ steps: login }, passed.slice(0, 3)).ok).toBe(false)
    expect(canPass({ steps: login }, [...passed.slice(0, 3), { stepId: 's4', status: 'skipped' as const, durationMs: 0 }]).ok).toBe(false)
  })
})

describe('规则归因', () => {
  it('四类 verdict', () => {
    expect(heuristicVerdict(login[1], { stepId: 's2', status: 'failed', durationMs: 1, error: { kind: 'missing-data', message: 'user' } }).verdict).toBe('data-missing')
    expect(heuristicVerdict(login[2], { stepId: 's3', status: 'failed', durationMs: 1, error: { kind: 'locator', message: 'timeout' } }).verdict).toBe('step-defect')
    expect(heuristicVerdict(login[3], { stepId: 's4', status: 'failed', durationMs: 1, actual: '你好', error: { kind: 'assertion', message: 'x' } }).verdict).toBe('product-defect')
    expect(heuristicVerdict(login[0], { stepId: 's1', status: 'failed', durationMs: 1, error: { kind: 'navigation', message: 'net::ERR_CONNECTION_REFUSED' } }).verdict).toBe('env-flaky')
  })
  it('product-defect 必须带预期/实际/截图', () => {
    const base = { verdict: 'product-defect' as const, summary: 'x', evidence: {} }
    expect(validateFinding(base).length).toBe(3)
    expect(validateFinding({ ...base, expected: 'a', actual: 'b', evidence: { screenshot: 'p.png' } })).toEqual([])
    expect(validateFinding({ verdict: 'step-defect', summary: 'x', evidence: {} })).toEqual(['step-defect 必须指明出错的 stepId'])
    expect(validateFinding({ verdict: 'data-missing', summary: 'x', evidence: {}, missingKeys: [] }).length).toBe(1)
  })
})

describe('门禁循环', () => {
  it('初始状态：缺陷进审阅，超轮次升级', () => {
    expect(initialFindingStatus('product-defect', 1, DEFAULT_POLICY)).toBe('awaiting_review')
    expect(initialFindingStatus('step-defect', 1, DEFAULT_POLICY)).toBe('awaiting_human')
    expect(initialFindingStatus('step-defect', DEFAULT_POLICY.maxRounds + 1, DEFAULT_POLICY)).toBe('escalated')
    expect(shouldEscalate(DEFAULT_POLICY.maxRounds, DEFAULT_POLICY)).toBe(false)
  })
  it('反馈驱动下一步', () => {
    expect(applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'fix-step', content: '按钮叫保存' }).action).toBe('repair')
    expect(applyFeedback({ status: 'awaiting_human', verdict: 'data-missing' }, { kind: 'supply-data', content: '', dataPatch: { code: 'VIP' } }).action).toBe('rerun')
    expect(applyFeedback({ status: 'awaiting_review', verdict: 'product-defect' }, { kind: 'confirm-defect', content: '' }).status).toBe('confirmed')
    const rejected = applyFeedback({ status: 'awaiting_review', verdict: 'product-defect' }, { kind: 'not-a-defect', content: '计数应为 2' })
    expect(rejected).toEqual({ status: 'repairing', verdict: 'step-defect', action: 'repair' })
  })
  it('非法反馈被拒绝', () => {
    expect(() => applyFeedback({ status: 'resolved', verdict: 'step-defect' }, { kind: 'fix-step', content: 'x' })).toThrow()
    expect(() => applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'fix-step', content: ' ' })).toThrow()
    expect(() => applyFeedback({ status: 'awaiting_human', verdict: 'data-missing' }, { kind: 'supply-data', content: '', dataPatch: {} })).toThrow()
    expect(() => applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'not-a-defect', content: 'x' })).toThrow()
  })
  it('小修自动批准，改结构或期望要人审', () => {
    const relocated = applyStepPatches(login, [{ stepId: 's3', patch: { target: { role: 'button', name: '保存' } } }])
    expect(needsHumanApproval(login, relocated)).toBe(false)
    expect(needsHumanApproval(login, applyStepPatches(login, [{ stepId: 's4', patch: { expect: '你好' } }]))).toBe(true)
    expect(needsHumanApproval(login, login.slice(0, 3))).toBe(true)
    expect(() => applyStepPatches(login, [{ stepId: 'nope', patch: {} }])).toThrow()
  })
  it('flaky 只自动重试一次', () => {
    expect(shouldAutoRetryFlaky(0, DEFAULT_POLICY)).toBe(true)
    expect(shouldAutoRetryFlaky(1, DEFAULT_POLICY)).toBe(false)
  })
  it('有未审阅或进行中的门禁时报告不能定稿', () => {
    expect(canPublishReport([{ id: 'f1', status: 'confirmed', verdict: 'product-defect' }]).ok).toBe(true)
    const blocked = canPublishReport([{ id: 'f1', status: 'awaiting_review', verdict: 'product-defect' }, { id: 'f2', status: 'repairing', verdict: 'step-defect' }])
    expect(blocked.ok).toBe(false)
    expect(blocked.blockers.length).toBe(2)
  })
})
