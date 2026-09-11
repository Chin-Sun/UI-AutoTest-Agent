/**
 * 门禁引擎：全部是纯函数，由 vitest 覆盖。
 *
 * 借鉴 dsh-agent-teams/src/quality-gates.ts 的思路：规则写成机器可判定的
 * 状态转换，而不是只写进 prompt；终态只读，修正生成新版本而不是复活旧对象。
 */
import type {
  Feedback, FeedbackKind, Finding, FindingStatus, GatePolicy, Run, RunStatus, Step, StepPlan,
  StepResult, Verdict,
} from './types'

// ---------- Run 状态机 + attempt 令牌 ----------

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['passed', 'failed', 'cancelled']

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['passed', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
}

export class GateError extends Error {
  constructor(message: string, readonly code: 'illegal-transition' | 'stale-attempt' | 'invalid' = 'invalid') {
    super(message)
  }
}

export function assertRunTransition(current: RunStatus, next: RunStatus): void {
  if (!RUN_TRANSITIONS[current].includes(next)) {
    throw new GateError(`run 状态不能从 ${current} 变为 ${next}`, 'illegal-transition')
  }
}

/** 迟到写入防护：只有持有当前 attemptId 且 run 未终结的执行者能写 */
export function assertAttempt(run: Pick<Run, 'attemptId' | 'status' | 'id'>, attemptId: string): void {
  if (run.attemptId !== attemptId) {
    throw new GateError(`run ${run.id} 的 attempt 已轮换，拒绝过期写入`, 'stale-attempt')
  }
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw new GateError(`run ${run.id} 已是终态 ${run.status}，只读`, 'stale-attempt')
  }
}

// ---------- Step / Plan 校验 ----------

const NEEDS_TARGET = new Set<Step['action']>([
  'click', 'fill', 'select', 'check', 'uncheck', 'upload', 'hover',
  'assertVisible', 'assertHidden', 'assertText', 'assertValue', 'assertCount',
])
const NEEDS_VALUE = new Set<Step['action']>(['goto', 'fill', 'select', 'upload', 'press'])
const NEEDS_EXPECT = new Set<Step['action']>(['assertText', 'assertValue', 'assertUrl', 'assertCount'])

export function isAssertion(action: Step['action']): boolean {
  return action.startsWith('assert')
}

export function stepProblems(step: Step): string[] {
  const problems: string[] = []
  if (NEEDS_TARGET.has(step.action) && step.target === undefined) problems.push(`${step.id}: ${step.action} 需要 target`)
  if (NEEDS_VALUE.has(step.action) && (step.value === undefined || step.value === '')) problems.push(`${step.id}: ${step.action} 需要 value`)
  if (NEEDS_EXPECT.has(step.action) && (step.expect === undefined || step.expect === '')) problems.push(`${step.id}: ${step.action} 需要 expect`)
  if (step.action === 'assertCount' && step.expect !== undefined && !/^\d+$/.test(step.expect)) problems.push(`${step.id}: assertCount 的 expect 必须是整数`)
  if (step.action === 'waitFor' && step.target === undefined && !/^\d+$/.test(step.value ?? '')) problems.push(`${step.id}: waitFor 需要 target 或毫秒数 value`)
  return problems
}

export function validatePlanSteps(steps: readonly Step[]): string[] {
  const problems: string[] = []
  if (steps.length === 0) problems.push('计划至少需要 1 个步骤')
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) problems.push(`步骤 id 重复: ${step.id}`)
    seen.add(step.id)
    problems.push(...stepProblems(step))
  }
  if (!steps.some((step) => isAssertion(step.action))) problems.push('计划至少需要 1 个断言步骤，否则无法判定是否符合预期')
  return problems
}

// ---------- 数据绑定 ----------

const BINDING = /\$\{data\.([A-Za-z0-9_.-]+)\}/g

export function bindingKeys(text: string | undefined): string[] {
  if (text === undefined) return []
  return [...text.matchAll(BINDING)].map((match) => match[1]!)
}

function stepStrings(step: Step): string[] {
  const target = step.target === undefined ? [] : Object.values(step.target).filter((v): v is string => typeof v === 'string')
  return [step.value ?? '', step.expect ?? '', ...target]
}

/** 执行前检查：Plan 引用了但用例数据里没有的 key。非空即直接判 data-missing，不浪费一次执行 */
export function missingBindings(steps: readonly Step[], data: Readonly<Record<string, string>>): string[] {
  const missing = new Set<string>()
  for (const step of steps) {
    for (const text of stepStrings(step)) {
      for (const key of bindingKeys(text)) {
        if (data[key] === undefined || data[key] === '') missing.add(key)
      }
    }
  }
  return [...missing]
}

export function resolveBindings(text: string, data: Readonly<Record<string, string>>): string {
  return text.replace(BINDING, (_, key: string) => {
    const value = data[key]
    if (value === undefined) throw new GateError(`缺少测试数据 ${key}`)
    return value
  })
}

// ---------- 通过判定 ----------

/** 所有步骤都执行完毕且全部通过才算 passed；缺步骤、跳过、失败都不行 */
export function canPass(plan: Pick<StepPlan, 'steps'>, results: readonly StepResult[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const byId = new Map(results.map((result) => [result.stepId, result]))
  for (const step of plan.steps) {
    const result = byId.get(step.id)
    if (result === undefined) reasons.push(`${step.id} 未执行`)
    else if (result.status !== 'passed') reasons.push(`${step.id} ${result.status}${result.error ? `: ${result.error.message}` : ''}`)
  }
  return { ok: reasons.length === 0, reasons }
}

// ---------- 归因 ----------

/**
 * 规则归因：LLM 不可用时的确定性基线，也是 mock 模式的 triager。
 * 真实 triager 可以推翻它，但必须通过 validateFinding。
 */
export function heuristicVerdict(step: Step | undefined, result: StepResult | undefined): { verdict: Verdict; reason: string } {
  const kind = result?.error?.kind ?? 'other'
  const message = result?.error?.message ?? ''
  if (kind === 'missing-data') return { verdict: 'data-missing', reason: message || '缺少测试数据' }
  if (kind === 'navigation' || /net::ERR_|ECONNREFUSED|ECONNRESET|503|502/.test(message)) {
    return { verdict: 'env-flaky', reason: `环境/网络异常：${message}` }
  }
  if (step !== undefined && isAssertion(step.action) && kind === 'assertion') {
    return { verdict: 'product-defect', reason: `断言不成立：期望 ${step.expect ?? '(可见)'}，实际 ${result?.actual ?? '(未知)'}` }
  }
  if (kind === 'locator' || kind === 'timeout') {
    return { verdict: 'step-defect', reason: `步骤 ${step?.id ?? '?'} 的定位或时序不对：${message}` }
  }
  return { verdict: 'step-defect', reason: message || '未知错误，默认按步骤问题交人判断' }
}

export function validateFinding(finding: Pick<Finding, 'verdict' | 'stepId' | 'expected' | 'actual' | 'evidence' | 'missingKeys' | 'summary'>): string[] {
  const problems: string[] = []
  if (finding.summary.trim() === '') problems.push('summary 不能为空')
  if (finding.verdict === 'product-defect') {
    if (!finding.expected) problems.push('product-defect 必须写明 expected')
    if (!finding.actual) problems.push('product-defect 必须写明 actual')
    if (!finding.evidence.screenshot) problems.push('product-defect 必须附截图证据')
  }
  if (finding.verdict === 'step-defect' && !finding.stepId) problems.push('step-defect 必须指明出错的 stepId')
  if (finding.verdict === 'data-missing' && (finding.missingKeys === undefined || finding.missingKeys.length === 0)) {
    problems.push('data-missing 必须列出缺少的数据 key')
  }
  return problems
}

/** 新 Finding 的初始状态 */
export function initialFindingStatus(verdict: Verdict, round: number, policy: GatePolicy): FindingStatus {
  if (verdict === 'product-defect') return 'awaiting_review'
  if (shouldEscalate(round, policy)) return 'escalated'
  return 'awaiting_human'
}

// ---------- 反馈 → 下一步 ----------

export const OPEN_FINDING_STATUSES: readonly FindingStatus[] = ['awaiting_human', 'awaiting_review', 'repairing', 'rerunning', 'escalated']

const FEEDBACK_ALLOWED: Readonly<Record<FindingStatus, readonly FeedbackKind[]>> = {
  awaiting_human: ['fix-step', 'supply-data', 'confirm-defect', 'dismiss'],
  escalated: ['fix-step', 'supply-data', 'confirm-defect', 'dismiss'],
  awaiting_review: ['confirm-defect', 'not-a-defect', 'dismiss'],
  repairing: [],
  rerunning: [],
  resolved: [],
  confirmed: [],
  dismissed: [],
}

export type FeedbackAction = 'repair' | 'rerun' | 'none'

export interface FeedbackOutcome {
  status: FindingStatus
  verdict: Verdict
  action: FeedbackAction
}

export function applyFeedback(finding: Pick<Finding, 'status' | 'verdict'>, feedback: Pick<Feedback, 'kind' | 'content' | 'stepPatches' | 'dataPatch'>): FeedbackOutcome {
  if (!FEEDBACK_ALLOWED[finding.status].includes(feedback.kind)) {
    throw new GateError(`状态 ${finding.status} 不接受反馈 ${feedback.kind}`, 'illegal-transition')
  }
  switch (feedback.kind) {
    case 'fix-step':
      if (feedback.content.trim() === '' && (feedback.stepPatches?.length ?? 0) === 0) {
        throw new GateError('修正步骤需要文字指点或直接修改的步骤')
      }
      return { status: 'repairing', verdict: finding.verdict, action: 'repair' }
    case 'supply-data':
      if (feedback.dataPatch === undefined || Object.keys(feedback.dataPatch).length === 0) {
        throw new GateError('补充数据需要至少一个 key=value')
      }
      return { status: 'rerunning', verdict: finding.verdict, action: 'rerun' }
    case 'confirm-defect':
      return { status: 'confirmed', verdict: 'product-defect', action: 'none' }
    case 'not-a-defect':
      // 人判定预期写错了：当作步骤问题，按人的说明修正断言
      if (feedback.content.trim() === '' && (feedback.stepPatches?.length ?? 0) === 0) {
        throw new GateError('驳回缺陷时请说明正确的预期，Agent 据此修正用例')
      }
      return { status: 'repairing', verdict: 'step-defect', action: 'repair' }
    case 'dismiss':
      return { status: 'dismissed', verdict: finding.verdict, action: 'none' }
  }
}

/**
 * 修正后的 Plan 是否需要人再审批：只改 target/value/timeout 的小修自动批准；
 * 增删步骤、改动作或改期望（expect）都要人看过。
 */
export function needsHumanApproval(oldSteps: readonly Step[], newSteps: readonly Step[]): boolean {
  if (oldSteps.length !== newSteps.length) return true
  return oldSteps.some((old, index) => {
    const next = newSteps[index]!
    return old.id !== next.id || old.action !== next.action || (old.expect ?? '') !== (next.expect ?? '')
  })
}

export function applyStepPatches(steps: readonly Step[], patches: Feedback['stepPatches']): Step[] {
  if (patches === undefined) return steps.map((step) => ({ ...step }))
  const byId = new Map(patches.map((item) => [item.stepId, item.patch]))
  for (const id of byId.keys()) {
    if (!steps.some((step) => step.id === id)) throw new GateError(`补丁引用了不存在的步骤 ${id}`)
  }
  return steps.map((step) => {
    const patch = byId.get(step.id)
    return patch === undefined ? { ...step } : { ...step, ...patch, id: step.id }
  })
}

export function shouldEscalate(round: number, policy: GatePolicy): boolean {
  return round > policy.maxRounds
}

/** 同一 Plan 版本上已经发生过的 env-flaky 次数未超限时自动重试 */
export function shouldAutoRetryFlaky(previousFlakyForPlan: number, policy: GatePolicy): boolean {
  return previousFlakyForPlan < policy.flakyRetries
}

// ---------- 报告发布 ----------

export function canPublishReport(findings: readonly Pick<Finding, 'id' | 'status' | 'verdict'>[]): { ok: boolean; blockers: string[] } {
  const blockers: string[] = []
  for (const finding of findings) {
    if (finding.status === 'awaiting_review') blockers.push(`${finding.id}: 疑似缺陷尚未审阅`)
    else if (finding.status === 'awaiting_human' || finding.status === 'escalated') blockers.push(`${finding.id}: 门禁等待人工补充`)
    else if (finding.status === 'repairing' || finding.status === 'rerunning') blockers.push(`${finding.id}: 修正/重跑进行中`)
  }
  return { ok: blockers.length === 0, blockers }
}
