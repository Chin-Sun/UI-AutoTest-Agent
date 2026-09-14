/**
 * Pipeline：用例 → 计划 → 执行 → 归因 → 门禁 → 修正/重跑 → 报告。
 *
 * 状态驱动，不轮询（对应 dsh-agent-teams scheduler 的 idle 边沿 kick）：
 * 执行结束触发归因；人的反馈触发修正或重跑；计划批准触发门禁重跑。
 * 执行串行（workers=1），共享测试环境下避免数据互扰。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  applyFeedback, assertRunTransition, canPublishReport, DataBindingSchema, DecisionSchema, declareMissingBindings, DEFAULT_POLICY,
  FEEDBACK_KINDS, FeedbackSchema, GateError, initialFindingStatus, missingBindings, newId, OPEN_FINDING_STATUSES,
  planNeedsHumanApproval, resolvePlanData, shouldAutoRetryFlaky, shouldEscalate, StepSchema, validatePlanData, validatePlanSteps,
  type Finding, type FindingStatus, type GatePolicy, type Project, type Report, type Run, type Step, type StepPlan,
  type StepResult, type Store, type TestCase, type Verdict,
} from '@uta/core'
import { AgentFailure, heuristicTriage, type AgentEvent, type AgentServices, type ComponentRegistry, type TriageOutput } from '@uta/agent'
import { runPlan, type RunPlanResult } from '@uta/runner'
import type { Bus } from './bus'
import { checklistContext, type ChecklistContext } from './importers'
import { renderReport, type ReportRow } from './report'

export const CaseInputSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  module: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  expected: z.array(z.string()).default([]),
  data: z.record(z.string(), z.string()).default({}),
  notes: z.array(z.string()).default([]),
  source: z.string().optional(),
})
export type CaseInput = z.input<typeof CaseInputSchema>

/**
 * 部分更新专用：不能写成 CaseInputSchema.partial()。
 * zod 4 会给 optional 包裹下的 .default() 继续填默认值，只改标题会把步骤、数据清空。
 */
export const CasePatchSchema = z.object({
  title: z.string().min(1),
  module: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(z.string()),
  expected: z.array(z.string()),
  data: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
  source: z.string(),
}).partial()
export type CasePatch = z.input<typeof CasePatchSchema>

export const FeedbackInputSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  content: z.string().default(''),
  stepPatches: FeedbackSchema.shape.stepPatches,
  dataPatch: z.record(z.string(), z.string()).optional(),
})

export interface RunOptions {
  headed: boolean
  obs: boolean
}

export interface PipelineDeps {
  store: Store
  agents: AgentServices
  registry: ComponentRegistry
  projects: Map<string, Project>
  bus: Bus
  dataRoot: string
  policy?: GatePolicy
  /** 执行器；测试可注入假实现，不启动浏览器 */
  runPlan?: typeof runPlan
}

export class Pipeline {
  private readonly queue: string[] = []
  private active: { runId: string, controller: AbortController } | undefined
  private readonly policy: GatePolicy

  constructor(private readonly deps: PipelineDeps) {
    this.policy = deps.policy ?? DEFAULT_POLICY
  }

  private get store(): Store {
    return this.deps.store
  }

  project(id: string): Project {
    const project = this.deps.projects.get(id)
    if (project === undefined) throw new GateError(`未知项目 ${id}`)
    return project
  }

  log(scope: string, message: string): void {
    this.deps.bus.emit({ type: 'log', scope, message, ts: Date.now() })
  }

  private async saveTranscript(name: string, transcript: AgentEvent[]): Promise<void> {
    const dir = join(this.deps.dataRoot, 'transcripts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.json`), JSON.stringify(transcript, null, 2))
  }

  // ---------- 用例 ----------

  async createCase(input: CaseInput): Promise<TestCase> {
    const parsed = CaseInputSchema.parse(input)
    this.project(parsed.projectId)
    const now = Date.now()
    const testCase = await this.store.cases.put({ id: newId('case'), ...parsed, version: 1, createdAt: now, updatedAt: now })
    this.deps.bus.emit({ type: 'case', testCase })
    return testCase
  }

  async updateCase(id: string, patch: CasePatch): Promise<TestCase> {
    const parsed = CasePatchSchema.parse(patch)
    const testCase = await this.store.cases.update(id, (doc) => ({ ...doc, ...parsed, projectId: doc.projectId, version: doc.version + 1, updatedAt: Date.now() }))
    this.deps.bus.emit({ type: 'case', testCase })
    return testCase
  }

  // ---------- 计划 ----------

  async plansOf(caseId: string): Promise<StepPlan[]> {
    return (await this.store.plans.list((plan) => plan.caseId === caseId)).sort((a, b) => b.version - a.version)
  }

  async latestApproved(caseId: string): Promise<StepPlan | undefined> {
    return (await this.plansOf(caseId)).find((plan) => plan.status === 'approved')
  }

  /**
   * 门禁修正产生的草稿被丢弃或被新草稿替代时，对应 Finding 不能停留在 repairing
   * （repairing 不接受任何反馈，会永远卡住），退回门禁等人重新处理。
   */
  private async releaseRepair(plan: StepPlan, reason: string): Promise<void> {
    if (plan.derivedFrom === undefined) return
    const current = await this.store.findings.get(plan.derivedFrom.findingId)
    if (current?.status !== 'repairing') return
    const finding = await this.store.findings.update(current.id, (doc) => {
      doc.status = shouldEscalate(doc.round, this.policy) ? 'escalated' : 'awaiting_human'
      doc.lastError = reason
      doc.updatedAt = Date.now()
    })
    this.deps.bus.emit({ type: 'finding', finding })
  }

  private async putDraft(caseId: string, draft: Omit<StepPlan, 'id' | 'version' | 'status' | 'createdAt'>): Promise<StepPlan> {
    const existing = await this.plansOf(caseId)
    for (const old of existing.filter((plan) => plan.status === 'draft')) {
      const discarded = await this.store.plans.update(old.id, (plan) => { plan.status = 'discarded' })
      this.deps.bus.emit({ type: 'plan', plan: discarded })
      if (discarded.derivedFrom?.findingId !== draft.derivedFrom?.findingId) {
        await this.releaseRepair(discarded, `修正计划 v${discarded.version} 被新的计划草稿替代，请重新处理`)
      }
    }
    const plan = await this.store.plans.put({
      ...draft,
      id: newId('plan'),
      version: (existing[0]?.version ?? 0) + 1,
      status: 'draft',
      createdAt: Date.now(),
    })
    this.deps.bus.emit({ type: 'plan', plan })
    return plan
  }

  /** 用例在原始清单里的上下文（文件头、章节、同章节条目），帮编译 Agent 理解只有一句话的用例 */
  private async sourceContext(testCase: TestCase, project: Project): Promise<ChecklistContext | undefined> {
    const key = /^molardata:(.+)$/.exec(testCase.source ?? '')?.[1]
    const dir = project.importers['checklistDir']
    if (key === undefined || dir === undefined) return undefined
    return checklistContext(dir, key).catch(() => undefined)
  }

  /** 本次执行实际使用的数据：计划声明（目录取值、模板展开）+ 用例数据（人补的，优先） */
  private runData(plan: StepPlan, testCase: TestCase, project: Project): Record<string, string> {
    const caseKey = (/^[^:]+:(.+)$/.exec(testCase.source ?? '')?.[1] ?? testCase.id).replace(/[^\w-]/g, '-')
    return resolvePlanData(plan.data, testCase.data, { catalog: project.testData, caseKey, now: Date.now() })
  }

  async compile(caseId: string): Promise<StepPlan> {
    const testCase = await this.store.cases.require(caseId)
    const project = this.project(testCase.projectId)
    const scope = `compile:${caseId}`
    this.log(scope, `开始编译「${testCase.title}」`)
    try {
      const source = await this.sourceContext(testCase, project)
      const out = await this.deps.agents.compile(testCase, project, source === undefined ? {} : { source })
      await this.saveTranscript(`compile-${caseId}-${Date.now()}`, out.transcript)
      this.log(scope, `编译完成：${out.steps.length} 步、${out.data.length} 项数据、${out.decisions.length} 个决策点（${out.model}）`)
      return await this.putDraft(caseId, {
        caseId,
        steps: out.steps,
        data: out.data,
        decisions: out.decisions,
        ...(project.defaultAuthRole === undefined ? {} : { authRole: project.defaultAuthRole }),
        createdBy: 'agent',
        rationale: `${out.rationale ?? ''}（${out.model}）`,
      })
    } catch (error) {
      this.log(scope, `编译失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * 人编辑草稿：可同时改数据与决策点。人新引用的 ${data.key} 自动声明为待补充；
   * 被删掉的步骤从决策点的关联里移除。
   */
  async savePlanDraft(planId: string, steps: unknown, extra: { data?: unknown, decisions?: unknown } = {}): Promise<StepPlan> {
    const parsed = z.array(StepSchema).min(1).parse(steps)
    const current = await this.store.plans.require(planId)
    const testCase = await this.store.cases.require(current.caseId)
    const project = this.project(testCase.projectId)
    const caseDataKeys = Object.keys(testCase.data)
    const data = declareMissingBindings(parsed, extra.data === undefined ? current.data : z.array(DataBindingSchema).parse(extra.data), caseDataKeys)
    const stepIds = new Set(parsed.map((step) => step.id))
    const decisions = extra.decisions === undefined
      ? current.decisions.map((decision) => ({ ...decision, stepIds: decision.stepIds.filter((id) => stepIds.has(id)) }))
      : z.array(DecisionSchema).parse(extra.decisions)
    const problems = [
      ...validatePlanSteps(parsed),
      ...validatePlanData({ steps: parsed, data, decisions }, { caseDataKeys, catalogKeys: project.testData.map((entry) => entry.key) }),
    ]
    if (problems.length > 0) throw new GateError(`计划未通过校验：${problems.join('；')}`)
    const plan = await this.store.plans.update(planId, (doc) => {
      if (doc.status !== 'draft') throw new GateError('只有草稿计划可以编辑；已批准的计划不可变，请重新编译或走门禁修正')
      doc.steps = parsed
      doc.data = data
      doc.decisions = decisions
      doc.createdBy = 'human'
    })
    this.deps.bus.emit({ type: 'plan', plan })
    return plan
  }

  async discardPlan(planId: string): Promise<StepPlan> {
    const plan = await this.store.plans.update(planId, (doc) => {
      if (doc.status !== 'draft') throw new GateError('只有草稿计划可以丢弃')
      doc.status = 'discarded'
    })
    this.deps.bus.emit({ type: 'plan', plan })
    await this.releaseRepair(plan, `修正计划 v${plan.version} 被丢弃，请重新指点`)
    return plan
  }

  async approvePlan(planId: string): Promise<StepPlan> {
    const draft = await this.store.plans.require(planId)
    if (draft.status !== 'draft') throw new GateError(`计划状态为 ${draft.status}，不能批准`)
    const problems = validatePlanSteps(draft.steps)
    if (problems.length > 0) throw new GateError(`计划未通过校验：${problems.join('；')}`)
    for (const old of await this.store.plans.list((plan) => plan.caseId === draft.caseId && plan.status === 'approved')) {
      this.deps.bus.emit({ type: 'plan', plan: await this.store.plans.update(old.id, (plan) => { plan.status = 'superseded' }) })
    }
    const plan = await this.store.plans.update(planId, (doc) => {
      doc.status = 'approved'
      doc.approvedAt = Date.now()
    })
    this.deps.bus.emit({ type: 'plan', plan })
    // 门禁修正产生的计划被批准 → 自动重跑，轮次 +1
    if (plan.derivedFrom !== undefined) {
      const finding = await this.store.findings.get(plan.derivedFrom.findingId)
      if (finding?.status === 'repairing') await this.rerunFor(finding)
    }
    return plan
  }

  // ---------- 执行 ----------

  async enqueue(caseIds: string[], options: RunOptions, trigger: Run['trigger'] = 'manual', round = 1): Promise<Run[]> {
    if (caseIds.length === 0) throw new GateError('请选择要执行的用例')
    const targets: { testCase: TestCase, plan: StepPlan }[] = []
    for (const caseId of caseIds) {
      const testCase = await this.store.cases.require(caseId)
      const plan = await this.latestApproved(caseId)
      if (plan === undefined) throw new GateError(`用例「${testCase.title}」还没有已批准的计划`)
      targets.push({ testCase, plan })
    }
    const runs: Run[] = []
    for (const { testCase, plan } of targets) {
      const run = await this.store.runs.put({
        id: newId('run'), caseId: testCase.id, projectId: testCase.projectId, planId: plan.id, planVersion: plan.version,
        round, attempt: 1, attemptId: randomUUID(), trigger, status: 'queued', stepResults: [], evidence: {}, options, createdAt: Date.now(),
      })
      this.queue.push(run.id)
      this.deps.bus.emit({ type: 'run', run })
      runs.push(run)
    }
    void this.pump()
    return runs
  }

  async cancel(runId: string): Promise<Run> {
    const run = await this.store.runs.update(runId, (doc) => {
      assertRunTransition(doc.status, 'cancelled')
      doc.status = 'cancelled'
      doc.finishedAt = Date.now()
    })
    const index = this.queue.indexOf(runId)
    if (index >= 0) this.queue.splice(index, 1)
    if (this.active?.runId === runId) this.active.controller.abort()
    this.deps.bus.emit({ type: 'run', run })
    return run
  }

  queueState(): { active?: string, queued: string[] } {
    return { ...(this.active === undefined ? {} : { active: this.active.runId }), queued: [...this.queue] }
  }

  private async pump(): Promise<void> {
    if (this.active !== undefined) return
    const next = this.queue.shift()
    if (next === undefined) return
    const controller = new AbortController()
    this.active = { runId: next, controller }
    try {
      await this.execute(next, controller.signal)
    } catch (error) {
      this.log(`run:${next}`, `执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    } finally {
      this.active = undefined
      void this.pump()
    }
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    const queued = await this.store.runs.require(runId)
    if (queued.status !== 'queued') return
    const plan = await this.store.plans.require(queued.planId)
    const testCase = await this.store.cases.require(queued.caseId)
    const project = this.project(queued.projectId)
    const scope = `run:${runId}`
    const { attemptId } = queued
    let run = await this.store.updateRunAttempt(runId, attemptId, (doc) => {
      doc.status = 'running'
      doc.startedAt = Date.now()
    })
    this.deps.bus.emit({ type: 'run', run })
    this.log(scope, `执行「${testCase.title}」计划 v${plan.version} · 第 ${run.round} 轮`)

    const obs = run.options.obs && this.deps.registry.isMcpReady('obs-recorder')
    if (run.options.obs && !obs) this.log(scope, 'obs-recorder 组件未启用或未连接，跳过 OBS 录制')
    if (obs) await this.deps.registry.callMcp('obs-recorder', 'start_record', {}).then((m) => this.log(scope, `OBS：${m}`), (e: Error) => this.log(scope, `OBS 开始录制失败：${e.message}`))

    const role = plan.authRole ?? project.defaultAuthRole
    const storageState = role === undefined ? undefined : project.authRoles[role]
    let result: RunPlanResult
    if (storageState !== undefined && !existsSync(storageState)) {
      const step = plan.steps[0]!
      result = { status: 'failed', stepResults: [{ stepId: step.id, status: 'failed', durationMs: 0, error: { kind: 'missing-data', message: `缺少登录态：${role}（${storageState}）` } }] }
    } else {
      const data = this.runData(plan, testCase, project)
      const generated = plan.data.filter((binding) => (binding.source === 'generated' || binding.source === 'setup') && data[binding.key] !== undefined)
      if (generated.length > 0) this.log(scope, `本次生成的数据：${generated.map((binding) => `${binding.key}=${data[binding.key]}`).join('，')}`)
      result = await (this.deps.runPlan ?? runPlan)({
        steps: plan.steps,
        data,
        baseURL: project.baseURL,
        ...(storageState === undefined ? {} : { storageState }),
        headed: run.options.headed,
        slowMo: project.slowMo,
        viewport: project.viewport,
        ...(project.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: project.actionTimeoutMs }),
        ...(project.assertTimeoutMs === undefined ? {} : { assertTimeoutMs: project.assertTimeoutMs }),
        evidenceDir: join(this.deps.dataRoot, 'evidence', runId),
        evidenceRel: `evidence/${runId}`,
        signal,
        hooks: {
          onFrame: (data) => this.deps.bus.emit({ type: 'frame', runId, data }),
          onStepStart: (step, index) => this.deps.bus.emit({ type: 'step', runId, index, stepId: step.id, phase: 'start' }),
          onStepEnd: (stepResult, index) => this.deps.bus.emit({ type: 'step', runId, index, stepId: stepResult.stepId, phase: 'end', result: stepResult }),
          onLog: (message) => this.log(scope, message),
        },
      }).catch((error: unknown): RunPlanResult => ({ status: 'failed', stepResults: [], error: `执行器异常：${error instanceof Error ? error.message : String(error)}` }))
    }
    if (obs) await this.deps.registry.callMcp('obs-recorder', 'stop_record', {}).then((m) => this.log(scope, `OBS 录像：${m}`), (e: Error) => this.log(scope, `OBS 停止录制失败：${e.message}`))

    try {
      run = await this.store.updateRunAttempt(runId, attemptId, (doc) => {
        doc.status = result.status
        doc.stepResults = result.stepResults
        doc.evidence = { ...(result.video === undefined ? {} : { video: result.video }), ...(result.trace === undefined ? {} : { trace: result.trace }) }
        if (result.error !== undefined) doc.error = result.error
        doc.finishedAt = Date.now()
      })
    } catch (error) {
      // run 已被取消或 attempt 已轮换：迟到的结果不能覆盖
      if (error instanceof GateError && error.code === 'stale-attempt') {
        this.log(scope, '执行结果已过期（run 已取消），丢弃')
        return
      }
      throw error
    }
    this.deps.bus.emit({ type: 'run', run })
    this.log(scope, `结束：${run.status}`)
    await this.afterRun(run, plan, testCase)
  }

  // ---------- 门禁 ----------

  private async closeOpenFindings(caseId: string, status: FindingStatus, supersededBy?: string): Promise<void> {
    const open = await this.store.findings.list((finding) => finding.caseId === caseId && OPEN_FINDING_STATUSES.includes(finding.status))
    for (const old of open) {
      if (old.id === supersededBy) continue
      const finding = await this.store.findings.update(old.id, (doc) => {
        doc.status = status
        if (supersededBy !== undefined) doc.supersededBy = supersededBy
        doc.updatedAt = Date.now()
      })
      this.deps.bus.emit({ type: 'finding', finding })
    }
  }

  private async triage(run: Run, plan: StepPlan, testCase: TestCase): Promise<{ output: TriageOutput, by: Finding['triagedBy'], failed?: StepResult }> {
    const failed = run.stepResults.find((result) => result.status === 'failed')
    if (failed === undefined) {
      return { output: { verdict: 'env-flaky', severity: 'low', summary: run.error ?? '执行器异常，未产生步骤结果' }, by: 'rule' }
    }
    if (failed.error?.kind === 'missing-data') {
      const keys = missingBindings(plan.steps, this.runData(plan, testCase, this.project(run.projectId)))
      const missingKeys = keys.length > 0 ? keys : [`auth:${plan.authRole ?? 'default'}`]
      return {
        failed,
        by: 'rule',
        output: {
          verdict: 'data-missing', severity: 'medium', summary: failed.error.message, missingKeys,
          suggestion: keys.length > 0 ? `请补充：${keys.map((key) => `${key}=…`).join('、')}` : '登录态文件不存在：请先在被测工程生成 storageState（molardata-e2e：npm run auth:all）',
        },
      }
    }
    let screenshot: { mediaType: 'image/png', base64: string } | undefined
    if (failed.screenshot !== undefined) {
      screenshot = await readFile(join(this.deps.dataRoot, failed.screenshot)).then((buffer) => ({ mediaType: 'image/png' as const, base64: buffer.toString('base64') }), () => undefined)
    }
    try {
      const out = await this.deps.agents.triage({ testCase, runId: run.id, steps: plan.steps, failedStepId: failed.stepId, result: failed, ...(screenshot === undefined ? {} : { screenshot }) })
      await this.saveTranscript(`triage-${run.id}`, out.transcript)
      return { output: out.verdict, by: out.model.startsWith('mock/') ? 'rule' : 'agent', failed }
    } catch (error) {
      this.log(`run:${run.id}`, `归因 Agent 失败，改用规则归因：${error instanceof Error ? error.message : String(error)}`)
      return { output: heuristicTriage({ caseTitle: testCase.title, steps: plan.steps, failedStepId: failed.stepId, result: failed }), by: 'rule', failed }
    }
  }

  private async afterRun(run: Run, plan: StepPlan, testCase: TestCase): Promise<void> {
    if (run.status === 'cancelled') return
    if (run.status === 'passed') {
      await this.closeOpenFindings(run.caseId, 'resolved')
      return
    }
    const { output, by, failed } = await this.triage(run, plan, testCase)
    const flakySoFar = (await this.store.findings.list((finding) => finding.planId === plan.id && finding.verdict === 'env-flaky')).length
    const retry = output.verdict === 'env-flaky' && shouldAutoRetryFlaky(flakySoFar, this.policy)
    const now = Date.now()
    const finding = await this.store.findings.put({
      id: newId('finding'), caseId: run.caseId, projectId: run.projectId, runId: run.id, planId: plan.id,
      ...(failed === undefined ? {} : { stepId: failed.stepId }),
      verdict: output.verdict, severity: output.severity, summary: output.summary,
      ...(output.expected === undefined ? {} : { expected: output.expected }),
      ...(output.actual === undefined ? {} : { actual: output.actual }),
      ...(output.suggestion === undefined ? {} : { suggestion: output.suggestion }),
      ...(output.missingKeys === undefined ? {} : { missingKeys: output.missingKeys }),
      evidence: {
        ...(failed?.screenshot === undefined ? {} : { screenshot: failed.screenshot }),
        ...(run.evidence.video === undefined ? {} : { video: run.evidence.video }),
        ...(run.evidence.trace === undefined ? {} : { trace: run.evidence.trace }),
      },
      triagedBy: by,
      status: retry ? 'rerunning' : initialFindingStatus(output.verdict, run.round, this.policy),
      round: run.round, feedbackIds: [], createdAt: now, updatedAt: now,
    })
    await this.closeOpenFindings(run.caseId, 'dismissed', finding.id)
    this.deps.bus.emit({ type: 'finding', finding })
    this.log(`run:${run.id}`, `归因：${finding.verdict} → ${finding.status}`)
    if (retry) await this.enqueue([run.caseId], run.options, 'flaky-retry', run.round)
  }

  private async rerunFor(finding: Finding): Promise<void> {
    const updated = await this.store.findings.update(finding.id, (doc) => {
      doc.status = 'rerunning'
      doc.updatedAt = Date.now()
    })
    this.deps.bus.emit({ type: 'finding', finding: updated })
    const previous = await this.store.runs.require(finding.runId)
    await this.enqueue([finding.caseId], previous.options, 'gate-rerun', finding.round + 1)
  }

  async feedback(findingId: string, input: z.input<typeof FeedbackInputSchema>): Promise<Finding> {
    const parsed = FeedbackInputSchema.parse(input)
    const before = await this.store.findings.require(findingId)
    const feedback = FeedbackSchema.parse({ id: newId('fb'), findingId, ...parsed, createdAt: Date.now() })
    const outcome = applyFeedback(before, feedback)
    await this.store.feedback.put(feedback)
    const finding = await this.store.findings.update(findingId, (doc) => {
      doc.status = outcome.status
      doc.verdict = outcome.verdict
      doc.feedbackIds.push(feedback.id)
      delete doc.lastError
      doc.updatedAt = Date.now()
    })
    this.deps.bus.emit({ type: 'finding', finding })
    if (outcome.action === 'rerun') {
      const testCase = await this.store.cases.update(finding.caseId, (doc) => {
        doc.data = { ...doc.data, ...feedback.dataPatch }
        doc.version += 1
        doc.updatedAt = Date.now()
      })
      this.deps.bus.emit({ type: 'case', testCase })
      const previous = await this.store.runs.require(finding.runId)
      await this.enqueue([finding.caseId], previous.options, 'gate-rerun', finding.round + 1)
    }
    if (outcome.action === 'repair') void this.repair(finding, feedback, { status: before.status, verdict: before.verdict })
    return finding
  }

  private async repair(finding: Finding, feedback: z.infer<typeof FeedbackSchema>, previous: { status: FindingStatus, verdict: Verdict }): Promise<void> {
    const scope = `repair:${finding.id}`
    try {
      const base = await this.latestApproved(finding.caseId) ?? await this.store.plans.require(finding.planId)
      const testCase = await this.store.cases.require(finding.caseId)
      this.log(scope, '修正 Agent 开始根据反馈修改计划')
      const out = await this.deps.agents.repair({
        testCase, project: this.project(testCase.projectId), steps: base.steps, data: base.data, decisions: base.decisions, finding, feedback,
      })
      await this.saveTranscript(`repair-${finding.id}-${Date.now()}`, out.transcript)
      const draft = await this.putDraft(finding.caseId, {
        caseId: finding.caseId,
        steps: out.steps,
        data: out.data,
        decisions: out.decisions,
        ...(base.authRole === undefined ? {} : { authRole: base.authRole }),
        createdBy: 'agent',
        derivedFrom: { planId: base.id, findingId: finding.id, feedbackId: feedback.id },
        rationale: `${out.rationale ?? ''}（${out.model}）`,
      })
      if (planNeedsHumanApproval(base, out)) {
        this.log(scope, `修正涉及步骤结构、预期、数据来源或决策点，计划 v${draft.version} 等待人工批准`)
      } else {
        this.log(scope, `小修（仅定位/取值），计划 v${draft.version} 自动批准并重跑`)
        await this.approvePlan(draft.id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(scope, `修正失败：${message}`)
      const reverted = await this.store.findings.update(finding.id, (doc) => {
        doc.status = previous.status
        doc.verdict = previous.verdict
        doc.lastError = message
        doc.updatedAt = Date.now()
      })
      this.deps.bus.emit({ type: 'finding', finding: reverted })
    }
  }

  // ---------- 报告 ----------

  async report(projectId: string): Promise<Report> {
    const project = this.project(projectId)
    const cases = await this.store.cases.list((doc) => doc.projectId === projectId)
    const runs = await this.store.runs.list((run) => run.projectId === projectId && run.status !== 'cancelled')
    const findings = await this.store.findings.list((finding) => finding.projectId === projectId)
    const rows: ReportRow[] = []
    for (const testCase of cases) {
      const run = runs.filter((candidate) => candidate.caseId === testCase.id).sort((a, b) => b.createdAt - a.createdAt)[0]
      const plan = run === undefined ? await this.latestApproved(testCase.id) : await this.store.plans.get(run.planId)
      rows.push({ testCase, ...(run === undefined ? {} : { run }), ...(plan === undefined ? {} : { plan }) })
    }
    const defects = findings.filter((finding) => finding.status === 'confirmed')
    const open = findings.filter((finding) => OPEN_FINDING_STATUSES.includes(finding.status))
    const gate = canPublishReport(open)
    const summary = {
      cases: cases.length,
      passed: rows.filter((row) => row.run?.status === 'passed').length,
      failed: rows.filter((row) => row.run?.status === 'failed').length,
      defects: defects.length,
      open: open.length,
    }
    const narrative = await this.deps.agents.summarize({ summary, defects: defects.map((d) => d.summary), open: open.map((f) => `${f.verdict}: ${f.summary}`) }, projectId).catch(() => undefined)
    const meta: Omit<Report, 'html'> = {
      id: newId('report'), projectId, status: gate.ok ? 'final' : 'draft', blockers: gate.blockers, summary,
      ...(narrative === undefined || narrative === '' ? {} : { narrative }), createdAt: Date.now(),
    }
    const dir = join(this.deps.dataRoot, 'report-html')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${meta.id}.html`), renderReport({ project, report: meta, rows, defects, open }))
    const report = await this.store.reports.put({ ...meta, html: `report-html/${meta.id}.html` })
    this.deps.bus.emit({ type: 'report', report })
    return report
  }

  /** 首次启动时导入项目自带的示例用例 */
  async seed(projectId: string, file: string): Promise<number> {
    if (!existsSync(file) || (await this.store.cases.list((doc) => doc.projectId === projectId)).length > 0) return 0
    const items = JSON.parse(await readFile(file, 'utf8')) as Omit<CaseInput, 'projectId'>[]
    for (const item of items) await this.createCase({ ...item, projectId })
    return items.length
  }

  steps(plan: StepPlan): Step[] {
    return plan.steps
  }
}

export { AgentFailure }
