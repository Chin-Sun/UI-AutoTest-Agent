/** 门禁纯函数：每条规则至少一个正例一个反例；状态 × 反馈做全矩阵 */
import { describe, expect, it } from 'vitest'
import {
  applyFeedback, applyStepPatches, assertAttempt, assertRunTransition, bindingKeys, canPass, canPublishReport,
  declareMissingBindings, DEFAULT_POLICY, expandTemplate, FEEDBACK_KINDS, FINDING_STATUSES, flowOutputs, GateError, heuristicVerdict,
  initialFindingStatus, isAssertion, missingBindings, needsHumanApproval, OPEN_FINDING_STATUSES, planNeedsHumanApproval,
  resolveBindings, resolvePlanData, RUN_STATUSES, RUN_TRANSITIONS, shouldAutoRetryFlaky, shouldEscalate, stepProblems,
  TERMINAL_RUN_STATUSES, validateFinding, validatePlanData, validatePlanFlows, validatePlanSteps,
  type DataBinding, type Decision, type FeedbackKind, type FindingStatus, type FlowSpec, type Step,
} from '../src'

const login: Step[] = [
  { id: 's1', action: 'goto', value: '/login' },
  { id: 's2', action: 'fill', target: { label: '用户名' }, value: '${data.user}' },
  { id: 's3', action: 'click', target: { role: 'button', name: '登录' } },
  { id: 's4', action: 'assertText', target: { testId: 'welcome' }, expect: '欢迎' },
]

function gateCode(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof GateError ? error.code : 'not-gate-error'
  }
}

describe('run 状态机', () => {
  it('终态没有任何出边', () => {
    for (const status of TERMINAL_RUN_STATUSES) expect(RUN_TRANSITIONS[status]).toEqual([])
  })

  it('只允许 queued→running|cancelled、running→终态', () => {
    const allowed = new Set(['queued>running', 'queued>cancelled', 'running>passed', 'running>failed', 'running>cancelled'])
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const code = gateCode(() => assertRunTransition(from, to))
        expect(code, `${from}>${to}`).toBe(allowed.has(`${from}>${to}`) ? undefined : 'illegal-transition')
      }
    }
  })

  it('过期 attempt 与终态写入都以 stale-attempt 拒绝', () => {
    const run = { id: 'r1', attemptId: 'a2', status: 'running' as const }
    expect(gateCode(() => assertAttempt(run, 'a1'))).toBe('stale-attempt')
    expect(gateCode(() => assertAttempt(run, 'a2'))).toBeUndefined()
    for (const status of TERMINAL_RUN_STATUSES) expect(gateCode(() => assertAttempt({ ...run, status }, 'a2'))).toBe('stale-attempt')
  })
})

describe('步骤校验', () => {
  const valid: Record<Step['action'], Step> = {
    goto: { id: 'x', action: 'goto', value: 'a.html' },
    click: { id: 'x', action: 'click', target: { text: 'a' } },
    fill: { id: 'x', action: 'fill', target: { label: 'a' }, value: 'v' },
    select: { id: 'x', action: 'select', target: { label: 'a' }, value: 'v' },
    check: { id: 'x', action: 'check', target: { label: 'a' } },
    uncheck: { id: 'x', action: 'uncheck', target: { label: 'a' } },
    upload: { id: 'x', action: 'upload', target: { label: 'a' }, value: '/tmp/f' },
    press: { id: 'x', action: 'press', value: 'Enter' },
    hover: { id: 'x', action: 'hover', target: { text: 'a' } },
    waitFor: { id: 'x', action: 'waitFor', value: '100' },
    assertVisible: { id: 'x', action: 'assertVisible', target: { text: 'a' } },
    assertHidden: { id: 'x', action: 'assertHidden', target: { text: 'a' } },
    assertText: { id: 'x', action: 'assertText', target: { text: 'a' }, expect: 'a' },
    assertValue: { id: 'x', action: 'assertValue', target: { label: 'a' }, expect: 'a' },
    assertUrl: { id: 'x', action: 'assertUrl', expect: '/a' },
    assertCount: { id: 'x', action: 'assertCount', target: { css: 'li' }, expect: '2' },
    screenshot: { id: 'x', action: 'screenshot' },
    use: { id: 'x', action: 'use', flow: 'demo.find' },
  }

  it.each(Object.entries(valid))('%s 的最小合法步骤无问题', (_, step) => {
    expect(stepProblems(step)).toEqual([])
  })

  it.each([
    [{ id: 'x', action: 'click' }, '需要 target'],
    [{ id: 'x', action: 'fill', target: { label: 'a' } }, '需要 value'],
    [{ id: 'x', action: 'goto', value: '' }, '需要 value'],
    [{ id: 'x', action: 'assertText', target: { text: 'a' } }, '需要 expect'],
    [{ id: 'x', action: 'assertUrl' }, '需要 expect'],
    [{ id: 'x', action: 'assertCount', target: { css: 'li' }, expect: '两个' }, '必须是整数'],
    [{ id: 'x', action: 'waitFor', value: 'soon' }, '毫秒数'],
    [{ id: 'x', action: 'use' }, '需要 flow'],
    [{ id: 'x', action: 'goto', value: 'a.html', target: { text: 'a' } }, '不能带 target'],
  ] as [Step, string][])('%j → %s', (step, message) => {
    expect(stepProblems(step).join()).toContain(message)
  })

  it('计划级：空计划、重复 id、缺断言', () => {
    expect(validatePlanSteps([]).join()).toContain('至少需要 1 个步骤')
    expect(validatePlanSteps(login)).toEqual([])
    expect(validatePlanSteps([...login, { ...login[0]! }]).join()).toContain('id 重复')
    expect(validatePlanSteps(login.slice(0, 3)).join()).toContain('断言')
  })

  it('isAssertion 只认 assert* 动作', () => {
    expect(isAssertion('assertUrl')).toBe(true)
    expect(isAssertion('click')).toBe(false)
  })
})

describe('数据绑定', () => {
  it('提取 value / expect / target 里的全部 key，支持点号', () => {
    expect(bindingKeys('${data.a} 与 ${data.b.c}')).toEqual(['a', 'b.c'])
    expect(bindingKeys(undefined)).toEqual([])
    const steps: Step[] = [
      { id: 's1', action: 'click', target: { role: 'button', name: '${data.btn}' } },
      { id: 's2', action: 'assertText', target: { text: 'x' }, expect: '${data.want}' },
    ]
    expect(missingBindings(steps, { btn: 'ok' })).toEqual(['want'])
  })

  it('空字符串视为缺失，重复引用只报一次', () => {
    expect(missingBindings([...login, { ...login[1]!, id: 's5' }], { user: '' })).toEqual(['user'])
  })

  it('解析绑定；缺失时抛 GateError', () => {
    expect(resolveBindings('${data.a}-${data.a}', { a: '1' })).toBe('1-1')
    expect(resolveBindings('无绑定', {})).toBe('无绑定')
    expect(() => resolveBindings('${data.x}', {})).toThrow(GateError)
  })
})

describe('流程数据与决策点', () => {
  const flow: Step[] = [
    { id: 's1', stage: 'setup', action: 'goto', value: 'task?taskId=${data.taskId}' },
    { id: 's2', stage: 'decision', action: 'click', target: { role: 'option', name: '${data.target}' } },
    { id: 's3', stage: 'verify', action: 'assertHidden', target: { text: '${data.node}' } },
  ]
  const data: DataBinding[] = [
    { key: 'taskId', source: 'catalog', ref: 'task.iat' },
    { key: 'target', source: 'generated', value: 'uta-{{case}}-{{ts}}' },
    { key: 'node', source: 'human' },
  ]
  const decision: Decision = { id: 'd1', question: '转移到哪', options: ['审核', '标注'], chosen: '审核', reason: '避开 C6', stepIds: ['s2'] }
  const context = { caseDataKeys: [], catalogKeys: ['task.iat'] }

  it('声明完整、决策点自洽时无问题；用例数据里已有的 key 不必再声明', () => {
    expect(validatePlanData({ steps: flow, data, decisions: [decision] }, context)).toEqual([])
    expect(validatePlanData({ steps: flow, data: data.slice(0, 2), decisions: [] }, { ...context, caseDataKeys: ['node'] })).toEqual([])
  })

  it.each([
    ['未声明的引用', { data: data.slice(0, 2) }, '未声明的数据 ${data.node}'],
    ['目录里没有的 ref', { data: [{ ...data[0]!, ref: 'task.nope' }, ...data.slice(1)] }, '没有条目 task.nope'],
    ['catalog 省略 ref 时按 key 查', { data: [{ key: 'taskId', source: 'catalog' as const }, ...data.slice(1)] }, '没有条目 taskId'],
    ['generated 缺 value', { data: [data[0]!, { key: 'target', source: 'generated' as const }, data[2]!] }, 'generated 来源需要 value'],
    ['重复 key', { data: [...data, data[2]!] }, '数据 key 重复'],
    ['chosen 不在 options', { decisions: [{ ...decision, chosen: '验收' }] }, '不在 options'],
    ['引用不存在的步骤', { decisions: [{ ...decision, stepIds: ['s9'] }] }, '不存在的步骤 s9'],
    ['决策点 id 重复', { decisions: [decision, decision] }, '决策点 id 重复'],
  ] as [string, { data?: DataBinding[], decisions?: Decision[] }, string][])('%s → %s', (_, patch, message) => {
    expect(validatePlanData({ steps: flow, data, decisions: [decision], ...patch }, context).join()).toContain(message)
  })

  it('未声明的引用补为 human，已声明与用例已有的保持不变，重复引用只补一次', () => {
    const declared = declareMissingBindings([...flow, { ...flow[2]!, id: 's4' }], data.slice(0, 1), ['target'])
    expect(declared).toEqual([data[0], { key: 'node', source: 'human', reason: expect.stringContaining('没有声明来源') as string }])
  })

  it('模板：{{case}} {{ts}}（base36）{{rand}} 每处独立生成', () => {
    let n = 0
    expect(expandTemplate('uta-{{case}}-{{ts}}-{{rand}}-{{rand}}', { caseKey: '02-C5', now: 36, random: () => `r${++n}` })).toBe('uta-02-C5-10-r1-r2')
    expect(expandTemplate('无模板', { caseKey: 'x', now: 1 })).toBe('无模板')
  })

  it('执行数据：目录取值、模板展开；human 未补与目录未配置的 key 缺失；用例数据优先', () => {
    const catalog = [{ key: 'task.iat', value: '42' }]
    const resolved = resolvePlanData(data, {}, { catalog, caseKey: '02-C5', now: 36 })
    expect(resolved).toEqual({ taskId: '42', target: 'uta-02-C5-10' })
    expect(missingBindings(flow, resolved)).toEqual(['node'])
    expect(resolvePlanData(data, { node: '审核1', target: '人填的', empty: '' }, { catalog: [{ key: 'task.iat', value: '' }], caseKey: 'c', now: 1 }))
      .toEqual({ target: '人填的', node: '审核1' })
    expect(resolvePlanData([{ key: 'node', source: 'human', value: '直接填在计划里' }], {}, { catalog, caseKey: 'c', now: 1 })).toEqual({ node: '直接填在计划里' })
  })

  it('计划级审批：数据或决策点变化需要人审；阶段变化也要人审', () => {
    const plan = { steps: flow, data, decisions: [decision] }
    expect(planNeedsHumanApproval(plan, structuredClone(plan))).toBe(false)
    expect(planNeedsHumanApproval(plan, { ...plan, data: data.slice(0, 2) })).toBe(true)
    expect(planNeedsHumanApproval(plan, { ...plan, decisions: [{ ...decision, chosen: '标注' }] })).toBe(true)
    expect(needsHumanApproval(flow, flow.map((step) => (step.id === 's2' ? { ...step, stage: 'action' as const } : step)))).toBe(true)
  })
})

describe('流程积木', () => {
  const specs: FlowSpec[] = [{
    id: 'shop.find', description: '找订单', paramsSchema: {}, outputs: ['orderId'],
    validate: (params) => ((params as { tool?: unknown }).tool === 'IAT' ? [] : ['tool 必须是 IAT']),
  }]
  const steps: Step[] = [
    { id: 's1', action: 'use', flow: 'shop.find', params: { tool: 'IAT', note: ['${data.who}'] } },
    { id: 's2', action: 'goto', value: 'orders/${data.orderId}' },
    { id: 's3', action: 'assertUrl', expect: '${data.orderId}' },
  ]

  it('积木存在且参数合法才通过；不存在时列出可用积木', () => {
    expect(validatePlanFlows(steps, specs)).toEqual([])
    expect(validatePlanFlows([{ ...steps[0]!, params: { tool: 'X' } }], specs)).toEqual(['s1: 积木 shop.find 参数不合法：tool 必须是 IAT'])
    expect(validatePlanFlows([{ ...steps[0]!, flow: 'shop.nope' }], specs).join()).toContain('可用：shop.find')
    expect(validatePlanFlows([{ ...steps[0]!, flow: 'shop.nope' }], []).join()).toContain('本项目没有任何积木')
  })

  it('积木输出：调用之后引用视为已声明，之前引用报错；参数里的绑定同样检查', () => {
    const context = { caseDataKeys: ['who'], catalogKeys: [], flows: specs }
    expect(validatePlanData({ steps, data: [], decisions: [] }, context)).toEqual([])
    expect(validatePlanData({ steps: [steps[1]!, steps[0]!], data: [], decisions: [] }, context)).toEqual(['s2: 在积木 shop.find 产出之前引用了 ${data.orderId}'])
    expect(validatePlanData({ steps, data: [], decisions: [] }, { ...context, caseDataKeys: [] }).join()).toContain('未声明的数据 ${data.who}')
  })

  it('执行前缺数据检查与自动声明都跳过积木产出的 key', () => {
    expect(flowOutputs(steps, specs)).toEqual(['orderId'])
    expect(flowOutputs(steps, [])).toEqual([])
    expect(missingBindings(steps, {})).toEqual(['who', 'orderId'])
    expect(missingBindings(steps, { who: 'a' }, ['orderId'])).toEqual([])
    expect(declareMissingBindings(steps, [], [], ['orderId']).map((binding) => binding.key)).toEqual(['who'])
  })
})

describe('通过判定', () => {
  const passed = login.map((step) => ({ stepId: step.id, status: 'passed' as const, durationMs: 1 }))
  it('全部通过才通过，并给出原因', () => {
    expect(canPass({ steps: login }, passed)).toEqual({ ok: true, reasons: [] })
    expect(canPass({ steps: login }, passed.slice(0, 3)).reasons).toEqual(['s4 未执行'])
    const failed = canPass({ steps: login }, [...passed.slice(0, 3), { stepId: 's4', status: 'failed', durationMs: 1, error: { kind: 'assertion', message: '不符' } }])
    expect(failed.reasons).toEqual(['s4 failed: 不符'])
  })
})

describe('规则归因', () => {
  const result = (kind: 'locator' | 'timeout' | 'assertion' | 'navigation' | 'missing-data' | 'other', message = 'x', stepId = 's1') => (
    { stepId, status: 'failed' as const, durationMs: 1, error: { kind, message } }
  )
  it.each([
    [login[1], result('missing-data'), 'data-missing'],
    [login[0], result('navigation'), 'env-flaky'],
    [login[2], result('other', 'net::ERR_CONNECTION_RESET'), 'env-flaky'],
    [login[2], result('other', 'upstream 503'), 'env-flaky'],
    [login[3], result('assertion'), 'product-defect'],
    [{ ...login[3]!, stage: 'verify' as const }, result('assertion'), 'product-defect'],
    [{ ...login[3]!, stage: 'setup' as const }, result('assertion'), 'step-defect'],
    [login[2], result('locator'), 'step-defect'],
    [login[2], result('timeout'), 'step-defect'],
    [login[3], result('timeout'), 'step-defect'],
    [login[2], result('assertion'), 'step-defect'],
    [login[2], result('other', '未知'), 'step-defect'],
    [undefined, undefined, 'step-defect'],
  ] as const)('%#: %j + %j → %s', (step, stepResult, verdict) => {
    expect(heuristicVerdict(step, stepResult).verdict).toBe(verdict)
  })

  it('证据要求', () => {
    const product = { verdict: 'product-defect' as const, summary: 'x', evidence: {} }
    expect(validateFinding(product)).toHaveLength(3)
    expect(validateFinding({ ...product, expected: 'a', actual: 'b', evidence: { screenshot: 'p.png' } })).toEqual([])
    expect(validateFinding({ verdict: 'step-defect', summary: 'x', evidence: {} })).toEqual(['step-defect 必须指明出错的 stepId'])
    expect(validateFinding({ verdict: 'data-missing', summary: 'x', evidence: {}, missingKeys: [] })).toHaveLength(1)
    expect(validateFinding({ verdict: 'env-flaky', summary: ' ', evidence: {} })).toEqual(['summary 不能为空'])
  })
})

describe('门禁循环', () => {
  it('初始状态：缺陷始终进审阅；其余超轮次升级', () => {
    const over = DEFAULT_POLICY.maxRounds + 1
    expect(initialFindingStatus('product-defect', over, DEFAULT_POLICY)).toBe('awaiting_review')
    expect(initialFindingStatus('step-defect', DEFAULT_POLICY.maxRounds, DEFAULT_POLICY)).toBe('awaiting_human')
    expect(initialFindingStatus('data-missing', over, DEFAULT_POLICY)).toBe('escalated')
    expect(shouldEscalate(2, { maxRounds: 1, flakyRetries: 0 })).toBe(true)
  })

  // 状态 × 反馈 全矩阵：值为期望的 [新状态, 动作]，undefined 表示应拒绝
  const matrix: Partial<Record<FindingStatus, Partial<Record<FeedbackKind, [FindingStatus, string]>>>> = {
    awaiting_human: { 'fix-step': ['repairing', 'repair'], 'supply-data': ['rerunning', 'rerun'], 'confirm-defect': ['confirmed', 'none'], 'dismiss': ['dismissed', 'none'] },
    escalated: { 'fix-step': ['repairing', 'repair'], 'supply-data': ['rerunning', 'rerun'], 'confirm-defect': ['confirmed', 'none'], 'dismiss': ['dismissed', 'none'] },
    awaiting_review: { 'confirm-defect': ['confirmed', 'none'], 'not-a-defect': ['repairing', 'repair'], 'dismiss': ['dismissed', 'none'] },
  }
  const complete = { content: '按钮叫「保存」', dataPatch: { k: 'v' } }
  for (const status of FINDING_STATUSES) {
    for (const kind of FEEDBACK_KINDS) {
      const expected = matrix[status]?.[kind]
      it(`${status} + ${kind} → ${expected ? expected.join('/') : '拒绝'}`, () => {
        // 允许的组合得到 [新状态, 动作]；不允许的组合得到错误码
        const actual = (() => {
          try {
            const outcome = applyFeedback({ status, verdict: 'step-defect' }, { kind, ...complete })
            return [outcome.status, outcome.action]
          } catch (error) {
            return error instanceof GateError ? error.code : 'not-gate-error'
          }
        })()
        expect(actual).toEqual(expected ?? 'illegal-transition')
      })
    }
  }

  it('反馈改判 verdict：确认缺陷 → product-defect，驳回缺陷 → step-defect', () => {
    expect(applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'confirm-defect', content: '' }).verdict).toBe('product-defect')
    expect(applyFeedback({ status: 'awaiting_review', verdict: 'product-defect' }, { kind: 'not-a-defect', content: '应为「1」' }).verdict).toBe('step-defect')
  })

  it('反馈内容不足时拒绝', () => {
    expect(gateCode(() => applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'fix-step', content: '  ' }))).toBe('invalid')
    expect(gateCode(() => applyFeedback({ status: 'awaiting_human', verdict: 'data-missing' }, { kind: 'supply-data', content: '' }))).toBe('invalid')
    expect(gateCode(() => applyFeedback({ status: 'awaiting_review', verdict: 'product-defect' }, { kind: 'not-a-defect', content: '' }))).toBe('invalid')
    const patched = applyFeedback({ status: 'awaiting_human', verdict: 'step-defect' }, { kind: 'fix-step', content: '', stepPatches: [{ stepId: 's1', patch: { value: 'x' } }] })
    expect(patched.action).toBe('repair')
  })

  it('OPEN_FINDING_STATUSES 与报告阻塞项一致', () => {
    for (const status of FINDING_STATUSES) {
      const blocked = !canPublishReport([{ id: 'f', status, verdict: 'step-defect' }]).ok
      expect(blocked, status).toBe(OPEN_FINDING_STATUSES.includes(status))
    }
  })

  it('flaky 按策略次数重试', () => {
    expect(shouldAutoRetryFlaky(0, DEFAULT_POLICY)).toBe(true)
    expect(shouldAutoRetryFlaky(1, DEFAULT_POLICY)).toBe(false)
    expect(shouldAutoRetryFlaky(0, { maxRounds: 3, flakyRetries: 0 })).toBe(false)
  })
})

describe('修正审批', () => {
  it('只改定位 / 取值 / 超时：免审', () => {
    const patched = applyStepPatches(login, [
      { stepId: 's3', patch: { target: { role: 'button', name: '保存' }, timeoutMs: 9000 } },
      { stepId: 's2', patch: { value: 'bob' } },
    ])
    expect(needsHumanApproval(login, patched)).toBe(false)
  })

  it.each([
    ['改期望', applyStepPatches(login, [{ stepId: 's4', patch: { expect: '你好' } }])],
    ['改动作', applyStepPatches(login, [{ stepId: 's3', patch: { action: 'hover' } }])],
    ['删步骤', login.slice(0, 3)],
    ['加步骤', [...login, { id: 's5', action: 'screenshot' }]],
    ['调换顺序', [login[1]!, login[0]!, login[2]!, login[3]!]],
  ] as [string, Step[]][])('%s：需要人审', (_, next) => {
    expect(needsHumanApproval(login, next)).toBe(true)
  })

  it('补丁不修改入参，也不能改 id；引用不存在的步骤报错', () => {
    const copy = structuredClone(login)
    const patched = applyStepPatches(login, [{ stepId: 's1', patch: { value: '/x', id: 'hacked' } as never }])
    expect(login).toEqual(copy)
    expect(patched[0]).toEqual({ id: 's1', action: 'goto', value: '/x' })
    expect(applyStepPatches(login, undefined)).toEqual(login)
    expect(() => applyStepPatches(login, [{ stepId: 'nope', patch: {} }])).toThrow(/不存在/)
  })
})
