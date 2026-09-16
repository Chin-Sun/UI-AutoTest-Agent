/** Pipeline 状态机：用例/计划/执行/门禁/修正/重跑/报告的全部分支（假执行器，不启动浏览器） */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GateError, LoginConfigSchema, NotFoundError, type Finding, type Run, type TestCase } from '@uta/core'
import { demoProject, failAt, makeHarness, passAll, REPO, until, type Harness } from './support'

let h: Harness
afterEach(async () => h?.cleanup())

async function seeded(options: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(options)
  await h.pipeline.seed('demo', join(REPO, 'projects/demo/cases.json'))
  const cases = await h.store.cases.list()
  const byTitle = (keyword: string) => cases.find((c) => c.title.includes(keyword))!
  return { cases, byTitle }
}

async function approved(caseId: string) {
  const plan = await h.pipeline.compile(caseId)
  return h.pipeline.approvePlan(plan.id)
}

const runsOf = (caseId: string) => h.store.runs.list((run) => run.caseId === caseId)
const findingsOf = (caseId: string) => h.store.findings.list((finding) => finding.caseId === caseId)
const settledRuns = (caseId: string, count: number) => until(() => runsOf(caseId), (runs) => runs.length >= count && runs.every((run) => ['passed', 'failed', 'cancelled'].includes(run.status)))
const findingWith = (caseId: string, ok: (finding: Finding) => boolean) => until(() => findingsOf(caseId), (list) => list.some(ok)).then((list) => list.find(ok)!)

describe('用例', () => {
  it('创建：未知项目拒绝；发出 case 事件', async () => {
    h = await makeHarness()
    await expect(h.pipeline.createCase({ projectId: 'ghost', title: 't' })).rejects.toBeInstanceOf(GateError)
    const created = await h.pipeline.createCase({ projectId: 'demo', title: '新用例', steps: ['打开「a.html」'] })
    expect(created).toMatchObject({ version: 1, preconditions: [], data: {} })
    expect(h.events.some((event) => event.type === 'case')).toBe(true)
  })

  it('部分更新只改传入字段，版本 +1，项目不可改（回归：zod 默认值曾清空步骤）', async () => {
    h = await makeHarness()
    const created = await h.pipeline.createCase({ projectId: 'demo', title: 'a', steps: ['s1', 's2'], data: { k: 'v' }, notes: ['n'] })
    const updated = await h.pipeline.updateCase(created.id, { title: 'b', projectId: 'other' } as never)
    expect(updated).toMatchObject({ title: 'b', steps: ['s1', 's2'], data: { k: 'v' }, notes: ['n'], version: 2, projectId: 'demo' })
    await expect(h.pipeline.updateCase(created.id, { title: '' })).rejects.toThrow()
    await expect(h.pipeline.updateCase('case_nope', { title: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('示例用例只导入一次；文件不存在时跳过', async () => {
    h = await makeHarness()
    expect(await h.pipeline.seed('demo', join(REPO, 'projects/demo/cases.json'))).toBe(4)
    expect(await h.pipeline.seed('demo', join(REPO, 'projects/demo/cases.json'))).toBe(0)
    expect(await h.pipeline.seed('other', join(h.root, 'none.json'))).toBe(0)
  })
})

describe('计划', () => {
  it('编译生成草稿；再次编译丢弃旧草稿、版本递增；过程记录落盘', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('登录').id
    const v1 = await h.pipeline.compile(id)
    const v2 = await h.pipeline.compile(id)
    expect([v1.version, v2.version]).toEqual([1, 2])
    expect((await h.store.plans.require(v1.id)).status).toBe('discarded')
    expect(v2).toMatchObject({ status: 'draft', createdBy: 'agent' })
    expect(v2.rationale).toContain('mock/rules')
    expect(existsSync(join(h.dataRoot, 'transcripts'))).toBe(true)
  })

  it('每次 Agent 运行落盘一条用量记录并广播（mock 计调用次数、token 为 0）', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('登录').id
    await h.pipeline.compile(id)
    const [record] = await until(() => h.store.usage.list(), (list) => list.length === 1)
    expect(record).toMatchObject({ scope: `compile:${id}`, role: 'compiler', projectId: 'demo', model: 'mock/rules', input: 0, output: 0 })
    expect(record!.calls).toBeGreaterThan(0)
    expect(h.events.some((event) => event.type === 'usage' && event.record.id === record!.id)).toBe(true)
  })

  it('编译失败抛错并记录日志', async () => {
    h = await makeHarness()
    const created = await h.pipeline.createCase({ projectId: 'demo', title: 'x', steps: ['看看'], expected: ['还行'] })
    await expect(h.pipeline.compile(created.id)).rejects.toThrow(/无法理解/)
    expect(h.logs().some((line) => line.startsWith('编译失败'))).toBe(true)
  })

  it('草稿可编辑（标记为人工）；非法步骤与已批准计划拒绝编辑', async () => {
    const { byTitle } = await seeded()
    const draft = await h.pipeline.compile(byTitle('登录').id)
    await expect(h.pipeline.savePlanDraft(draft.id, [{ id: 's1', action: 'click' }])).rejects.toBeInstanceOf(GateError)
    await expect(h.pipeline.savePlanDraft(draft.id, [{ id: 's1', action: 'fly' }])).rejects.toThrow()
    const edited = await h.pipeline.savePlanDraft(draft.id, draft.steps.slice(0, 1).concat({ id: 's9', action: 'assertUrl', expect: 'login' }))
    expect(edited).toMatchObject({ createdBy: 'human', steps: [{ id: 's1' }, { id: 's9' }] })
    await h.pipeline.approvePlan(draft.id)
    await expect(h.pipeline.savePlanDraft(draft.id, draft.steps)).rejects.toThrow(/不可变/)
    await expect(h.pipeline.discardPlan(draft.id)).rejects.toThrow(/只有草稿/)
    await expect(h.pipeline.approvePlan(draft.id)).rejects.toThrow(/不能批准/)
  })

  it('清单导入的用例：编译时附带原始清单上下文', async () => {
    const checklistDir = fileURLToPath(new URL('./fixtures/checklists/', import.meta.url))
    h = await makeHarness({ projects: [demoProject({ importers: { checklistDir } })] })
    const compile = vi.spyOn(h.agents, 'compile')
    const created = await h.pipeline.createCase({ projectId: 'demo', title: '02-A1', steps: ['内置节点不可删除'], expected: ['内置节点不可删除'], source: 'molardata:02-A1' })
    await h.pipeline.compile(created.id).catch(() => undefined)
    expect(compile.mock.calls[0]![2]).toMatchObject({ source: { section: 'A. 节点类型与内置节点', siblings: ['02-A2 「标注」节点不可删除'] } })
    const plain = await h.pipeline.createCase({ projectId: 'demo', title: '手写', steps: ['打开「a.html」'], expected: ['页面显示「a」'] })
    await h.pipeline.compile(plain.id)
    expect(compile.mock.calls[1]![2]).toEqual({ flows: [] })
  })

  it('草稿数据：人新引用的数据自动声明为待补充；目录里没有的引用被拒绝', async () => {
    const { byTitle } = await seeded()
    const draft = await h.pipeline.compile(byTitle('VIP').id)
    expect(draft.data).toEqual([expect.objectContaining({ key: 'vipCode', source: 'human' })])
    const extended = await h.pipeline.savePlanDraft(draft.id, draft.steps.map((step) => (step.id === 's2' ? { ...step, value: '${data.vipCode}${data.suffix}' } : step)))
    expect(extended.data.map((binding) => [binding.key, binding.source])).toEqual([['vipCode', 'human'], ['suffix', 'human']])
    await expect(h.pipeline.savePlanDraft(draft.id, draft.steps, { data: [{ key: 'vipCode', source: 'catalog', ref: 'code.nope' }] })).rejects.toThrow(/没有条目 code.nope/)
    await expect(h.pipeline.savePlanDraft(draft.id, draft.steps, { decisions: [{ id: 'd1', question: 'q', options: ['a'], chosen: 'b', reason: 'r' }] })).rejects.toThrow(/不在 options/)
  })

  it('批准新版本时旧的已批准版本变为 superseded', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('登录').id
    const v1 = await approved(id)
    const v2 = await approved(id)
    expect((await h.store.plans.require(v1.id)).status).toBe('superseded')
    expect((await h.pipeline.latestApproved(id))?.id).toBe(v2.id)
  })
})

describe('执行', () => {
  it('没有已批准计划时整批拒绝（不部分入队）；空列表拒绝', async () => {
    const { byTitle } = await seeded()
    await approved(byTitle('登录').id)
    await expect(h.pipeline.enqueue([byTitle('登录').id, byTitle('昵称').id], { headed: false, obs: false })).rejects.toThrow(/还没有已批准的计划/)
    expect(await h.store.runs.list()).toEqual([])
    await expect(h.pipeline.enqueue([], { headed: false, obs: false })).rejects.toThrow(/请选择/)
  })

  it('通过：run 状态流转 queued→running→passed，执行器收到计划、数据与项目配置', async () => {
    const { byTitle } = await seeded({ projects: [demoProject({ slowMo: 7, actionTimeoutMs: 1234, assertTimeoutMs: 567 })] })
    const id = byTitle('登录').id
    await approved(id)
    const [queued] = await h.pipeline.enqueue([id], { headed: true, obs: false })
    expect(queued).toMatchObject({ status: 'queued', round: 1, trigger: 'manual', attempt: 1 })
    const [run] = await settledRuns(id, 1)
    expect(run).toMatchObject({ status: 'passed', evidence: { video: `evidence/${run!.id}/video.webm` } })
    const statuses = h.events.flatMap((event) => (event.type === 'run' && event.run.id === run!.id ? [event.run.status] : []))
    expect(statuses).toEqual(['queued', 'running', 'passed'])
    expect(h.runner.calls[0]).toMatchObject({ headed: true, slowMo: 7, actionTimeoutMs: 1234, assertTimeoutMs: 567, baseURL: 'http://127.0.0.1:9/demo/', evidenceRel: `evidence/${run!.id}` })
    expect(await findingsOf(id)).toEqual([])
    expect(h.pipeline.queueState()).toEqual({ queued: [] })
  })

  it('执行数据：目录取值与生成模板在执行时解析并记录日志，交给执行器', async () => {
    const { byTitle } = await seeded({ projects: [demoProject({ testData: [{ key: 'code.vip', description: 'VIP 兑换码', value: 'VIP-2026', tags: [] }] })] })
    const vip = byTitle('VIP')
    const draft = await h.pipeline.compile(vip.id)
    const saved = await h.pipeline.savePlanDraft(draft.id, draft.steps, {
      data: [{ key: 'vipCode', source: 'catalog', ref: 'code.vip', reason: '目录里有' }, { key: 'runName', source: 'generated', value: 'uta-{{case}}-{{ts}}' }],
    })
    await h.pipeline.approvePlan(saved.id)
    await h.pipeline.enqueue([vip.id], { headed: false, obs: false })
    const [run] = await settledRuns(vip.id, 1)
    expect(run!.status).toBe('passed')
    expect(h.runner.calls[0]!.data).toMatchObject({ vipCode: 'VIP-2026', runName: expect.stringMatching(new RegExp(`^uta-${vip.id}-[0-9a-z]+$`)) as string })
    expect(h.logs().some((line) => line.startsWith('本次生成的数据：runName=uta-'))).toBe(true)
  })

  it('项目配置了 login：执行器收到会话、积木、状态与超时；缺账号时建议文案直接给出要补的变量', async () => {
    const login = LoginConfigSchema.parse({ url: '/login', accounts: { admin: { configured: false, passwordVar: 'DEMO_PASS' } } })
    const message = '登录会话失败：缺少 admin 的登录账号：请在 .env 中填写 DEMO_PASS'
    const { byTitle } = await seeded({
      projects: [demoProject({ login, navigationTimeoutMs: 999, localStorage: { LOCALE: 'zh-CN' } })],
      behavior: (options) => failAt(options, options.steps[0]!.id, { error: { kind: 'missing-data', message } }),
    })
    const id = byTitle('登录').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const finding = await findingWith(id, () => true)
    expect(h.runner.calls[0]).toMatchObject({
      navigationTimeoutMs: 999, localStorage: { LOCALE: 'zh-CN' }, flows: [],
      session: { role: 'admin', missingVars: ['login.accounts.admin'], authFile: join(h.dataRoot, 'auth', 'demo', 'admin.json') },
    })
    expect(h.runner.calls[0]!.session?.account).toBeUndefined()
    expect(h.runner.calls[0]!.storageState).toBeUndefined()
    expect(finding).toMatchObject({ verdict: 'data-missing', missingKeys: ['auth:admin'], suggestion: message })
  })

  it('多条用例串行执行（同一时间只有一个 running）', async () => {
    let running = 0
    let peak = 0
    const { cases } = await seeded({
      behavior: async (options) => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 30))
        running -= 1
        return { status: 'passed', stepResults: options.steps.map((step) => ({ stepId: step.id, status: 'passed', durationMs: 1 })) }
      },
    })
    for (const c of cases) await approved(c.id)
    await h.pipeline.enqueue(cases.map((c) => c.id), { headed: false, obs: false })
    await until(() => h.store.runs.list(), (runs) => runs.length === 4 && runs.every((run) => run.status === 'passed'))
    expect(peak).toBe(1)
  })

  it('执行器抛异常 → run failed，归为 env-flaky 并自动重试一次', async () => {
    const { byTitle } = await seeded({ behavior: () => { throw new Error('browser crashed') } })
    const id = byTitle('登录').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const runs = await settledRuns(id, 2)
    expect(runs.map((run) => run.trigger).sort()).toEqual(['flaky-retry', 'manual'])
    const findings = await until(() => findingsOf(id), (list) => list.some((f) => f.status === 'awaiting_human'))
    expect(findings.find((f) => f.status === 'awaiting_human')).toMatchObject({ verdict: 'env-flaky', summary: '执行器异常：browser crashed', triagedBy: 'rule' })
    expect(findings.find((f) => f.status === 'dismissed')?.supersededBy).toBeDefined()
  })

  it('取消排队中的 run：不执行；终态不能再取消', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { byTitle } = await seeded({
      behavior: async (options) => {
        await gate
        return passAll(options)
      },
    })
    const a = byTitle('登录').id
    const b = byTitle('昵称').id
    await approved(a)
    await approved(b)
    const [, second] = await h.pipeline.enqueue([a, b], { headed: false, obs: false })
    await until(async () => h.pipeline.queueState(), (state) => state.active !== undefined)
    const cancelled = await h.pipeline.cancel(second!.id)
    expect(cancelled.status).toBe('cancelled')
    release()
    await settledRuns(a, 1)
    expect(h.runner.calls).toHaveLength(1)
    await expect(h.pipeline.cancel(second!.id)).rejects.toThrow(/不能从 cancelled/)
  })

  it('取消执行中的 run：中止信号传给执行器，迟到结果被丢弃，不产生 Finding', async () => {
    const { byTitle } = await seeded({
      behavior: (options) => new Promise((resolve) => {
        options.signal!.addEventListener('abort', () => resolve(failAt(options, options.steps[0]!.id, { error: { kind: 'other', message: 'aborted' } })))
      }),
    })
    const id = byTitle('登录').id
    await approved(id)
    const [run] = await h.pipeline.enqueue([id], { headed: false, obs: false })
    await until(() => h.store.runs.require(run!.id), (r) => r.status === 'running')
    await h.pipeline.cancel(run!.id)
    await until(async () => h.logs(), (logs) => logs.some((line) => line.includes('执行结果已过期')))
    expect((await h.store.runs.require(run!.id)).status).toBe('cancelled')
    expect(await findingsOf(id)).toEqual([])
  })

  it('项目配置的登录态文件不存在：不启动执行器，判为缺数据', async () => {
    const { byTitle } = await seeded({ projects: [demoProject({ authRoles: { admin: '/no/such/admin.json' }, defaultAuthRole: 'admin' })] })
    const id = byTitle('登录').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const finding = await findingWith(id, () => true)
    expect(finding).toMatchObject({ verdict: 'data-missing', missingKeys: ['auth:admin'], status: 'awaiting_human' })
    expect(finding.suggestion).toContain('storageState')
    expect(h.runner.calls).toHaveLength(0)
  })

  it('勾选 OBS 但组件未就绪：记录跳过，执行照常', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('登录').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: true })
    await settledRuns(id, 1)
    expect(h.logs().some((line) => line.includes('跳过 OBS 录制'))).toBe(true)
  })
})

describe('门禁', () => {
  async function failing(keyword: string, options: Parameters<typeof makeHarness>[0] = {}) {
    const { byTitle } = await seeded(options)
    const testCase = byTitle(keyword)
    await approved(testCase.id)
    await h.pipeline.enqueue([testCase.id], { headed: false, obs: false })
    const finding = await findingWith(testCase.id, () => true)
    return { testCase, finding }
  }

  it('步骤错误 → 人指点 → 小修自动批准 → 第 2 轮通过 → resolved', async () => {
    const { testCase, finding } = await failing('昵称')
    expect(finding).toMatchObject({ verdict: 'step-defect', status: 'awaiting_human', stepId: 's3', round: 1, triagedBy: 'rule' })
    expect(finding.suggestion).toContain('「保存」')
    expect(finding.evidence.screenshot).toMatch(/^evidence\/run_/)

    const after = await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '按钮叫「保存」' })
    expect(after.status).toBe('repairing')
    await until(() => h.store.findings.require(finding.id), (f) => f.status === 'resolved')
    const plans = await h.pipeline.plansOf(testCase.id)
    expect(plans[0]).toMatchObject({ version: 2, status: 'approved', derivedFrom: { findingId: finding.id } })
    const reruns = (await runsOf(testCase.id)).filter((run) => run.trigger === 'gate-rerun')
    expect(reruns).toEqual([expect.objectContaining({ round: 2, status: 'passed', planVersion: 2 })])
    expect(h.logs().some((line) => line.includes('自动批准并重跑'))).toBe(true)
    expect((await h.store.feedback.list()).map((fb) => fb.kind)).toEqual(['fix-step'])
  })

  it('结构性修正需要人批准；批准后才重跑', async () => {
    const { testCase, finding } = await failing('昵称')
    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '', stepPatches: [{ stepId: 's3', patch: { action: 'dblclick' as never } }] }).catch(() => undefined)
    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '', stepPatches: [{ stepId: 's4', patch: { expect: '保存成功' } }] })
    const draft = await until(() => h.pipeline.plansOf(testCase.id), (plans) => plans[0]?.status === 'draft').then((plans) => plans[0]!)
    expect((await h.store.findings.require(finding.id)).status).toBe('repairing')
    expect(await runsOf(testCase.id)).toHaveLength(1)
    await h.pipeline.approvePlan(draft.id)
    await until(() => h.store.findings.require(finding.id), (f) => f.status !== 'repairing' && f.status !== 'rerunning')
    expect((await runsOf(testCase.id)).map((run) => run.round).sort()).toEqual([1, 2])
  })

  it('修正草稿被丢弃或被重新编译替代：Finding 退回门禁并说明原因（回归：曾永久卡在 repairing）', async () => {
    const { testCase, finding } = await failing('昵称')
    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '', stepPatches: [{ stepId: 's4', patch: { expect: '改了' } }] })
    const draft = await until(() => h.pipeline.plansOf(testCase.id), (plans) => plans[0]?.status === 'draft').then((plans) => plans[0]!)
    await h.pipeline.discardPlan(draft.id)
    const released = await h.store.findings.require(finding.id)
    expect(released).toMatchObject({ status: 'awaiting_human' })
    expect(released.lastError).toContain('被丢弃')

    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '', stepPatches: [{ stepId: 's4', patch: { expect: '再改' } }] })
    await until(() => h.pipeline.plansOf(testCase.id), (plans) => plans[0]?.status === 'draft' && plans[0].version === 3)
    await h.pipeline.compile(testCase.id)
    expect((await h.store.findings.require(finding.id)).lastError).toContain('被新的计划草稿替代')
  })

  it('修正失败（指点无法理解）：Finding 恢复原状态并记录错误', async () => {
    const { finding } = await failing('昵称')
    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '名字不对' })
    const reverted = await until(() => h.store.findings.require(finding.id), (f) => f.lastError !== undefined)
    expect(reverted).toMatchObject({ status: 'awaiting_human', verdict: 'step-defect' })
    expect(reverted.lastError).toContain('「」')
  })

  it('缺数据 → 规则归因 → 补数据写入用例（版本 +1）→ 第 2 轮通过', async () => {
    const { testCase, finding } = await failing('VIP')
    expect(finding).toMatchObject({ verdict: 'data-missing', missingKeys: ['vipCode'], triagedBy: 'rule' })
    await expect(h.pipeline.feedback(finding.id, { kind: 'supply-data', dataPatch: {} })).rejects.toBeInstanceOf(GateError)
    await h.pipeline.feedback(finding.id, { kind: 'supply-data', dataPatch: { vipCode: 'VIP-2026' } })
    await until(() => h.store.findings.require(finding.id), (f) => f.status === 'resolved')
    expect(await h.store.cases.require(testCase.id)).toMatchObject({ data: { vipCode: 'VIP-2026' }, version: 2 })
  })

  it('补了错误数据：新一轮失败产生新 Finding，旧的被取代', async () => {
    const { testCase, finding } = await failing('VIP')
    await h.pipeline.feedback(finding.id, { kind: 'supply-data', dataPatch: { vipCode: 'WRONG' } })
    const next = await findingWith(testCase.id, (f) => f.id !== finding.id)
    expect(next).toMatchObject({ verdict: 'product-defect', round: 2, status: 'awaiting_review' })
    expect(await h.store.findings.require(finding.id)).toMatchObject({ status: 'dismissed', supersededBy: next.id })
  })

  it('产品缺陷 → 审阅确认 → confirmed；报告定稿并包含缺陷', async () => {
    const { testCase, finding } = await failing('待办')
    expect(finding).toMatchObject({ verdict: 'product-defect', status: 'awaiting_review', expected: '共 2 项', severity: 'high' })
    expect(finding.actual).toContain('共 1 项')

    const draft = await h.pipeline.report('demo')
    expect(draft).toMatchObject({ status: 'draft', blockers: [`${finding.id}: 疑似缺陷尚未审阅`] })

    await h.pipeline.feedback(finding.id, { kind: 'confirm-defect' })
    const report = await h.pipeline.report('demo')
    expect(report).toMatchObject({ status: 'final', blockers: [], summary: { cases: 4, passed: 0, failed: 1, defects: 1, open: 0 } })
    expect(report.narrative).toContain('已确认缺陷 1')
    const html = await readFile(join(h.dataRoot, report.html), 'utf8')
    expect(html).toContain(testCase.title)
    expect(html).toContain('共 2 项')
  })

  it('驳回缺陷（预期写错）→ 按人给的正确预期修正断言 → 重跑', async () => {
    const { testCase, finding } = await failing('待办')
    await h.pipeline.feedback(finding.id, { kind: 'not-a-defect', content: '应该显示「共 1 项」' })
    const plan = await until(() => h.pipeline.plansOf(testCase.id), (plans) => plans[0]?.version === 2).then((plans) => plans[0]!)
    expect(plan.steps.at(-1)?.target).toEqual({ text: '共 1 项' })
    await until(() => h.store.findings.require(finding.id), (f) => f.status === 'resolved')
  })

  it('非法反馈被拒绝，不写入反馈记录', async () => {
    const { finding } = await failing('待办')
    await expect(h.pipeline.feedback(finding.id, { kind: 'supply-data', dataPatch: { a: 'b' } })).rejects.toThrow(/不接受/)
    await expect(h.pipeline.feedback(finding.id, { kind: 'bogus' } as never)).rejects.toThrow()
    await expect(h.pipeline.feedback('finding_nope', { kind: 'dismiss' })).rejects.toBeInstanceOf(NotFoundError)
    expect(await h.store.feedback.list()).toEqual([])
  })

  it('超过最大轮次：新 Finding 直接升级，停止自动循环', async () => {
    const { testCase, finding } = await failing('昵称', { policy: { maxRounds: 1, flakyRetries: 1 } })
    expect(finding.status).toBe('awaiting_human')
    // 人给了一个仍然错误的指点：第 2 轮继续失败
    await h.pipeline.feedback(finding.id, { kind: 'fix-step', content: '按钮叫「确定」' })
    const escalated = await findingWith(testCase.id, (f) => f.round === 2)
    expect(escalated.status).toBe('escalated')
    // 升级后人仍可继续指点
    await h.pipeline.feedback(escalated.id, { kind: 'fix-step', content: '按钮叫「保存」' })
    await until(() => h.store.findings.require(escalated.id), (f) => f.status === 'resolved')
  })

  it('归因 Agent 失败时退回规则归因并记录日志', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('昵称').id
    await approved(id)
    h.registry.skills.delete('failure-triage') // 归因 Agent 必读的 skill 缺失 → Agent 失败
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const finding = await findingWith(id, () => true)
    expect(finding).toMatchObject({ verdict: 'step-defect', triagedBy: 'rule' })
    expect(h.logs().some((line) => line.startsWith('归因 Agent 失败'))).toBe(true)
  })

  it('再次通过时关闭该用例所有未结 Finding', async () => {
    let fail = true
    const { byTitle } = await seeded({ behavior: (options) => (fail ? failAt(options, 's4', { error: { kind: 'locator', message: 'x' } }) : passAll(options)) })
    const id = byTitle('登录').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const finding = await findingWith(id, () => true)
    expect(finding.status).toBe('awaiting_human')
    fail = false
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    const closed = await until(() => h.store.findings.require(finding.id), (f) => f.status === 'resolved')
    expect(closed.supersededBy).toBeUndefined()
  })
})

describe('报告', () => {
  it('未执行的用例计为未执行；未知项目拒绝', async () => {
    const { byTitle } = await seeded()
    await approved(byTitle('登录').id)
    const report = await h.pipeline.report('demo')
    expect(report.summary).toEqual({ cases: 4, passed: 0, failed: 0, defects: 0, open: 0 })
    expect(await readFile(join(h.dataRoot, report.html), 'utf8')).toContain('未执行')
    await expect(h.pipeline.report('ghost')).rejects.toBeInstanceOf(GateError)
  })
})

describe('事件', () => {
  it('关键状态变化都发出事件', async () => {
    const { byTitle } = await seeded()
    const id = byTitle('昵称').id
    await approved(id)
    await h.pipeline.enqueue([id], { headed: false, obs: false })
    await findingWith(id, () => true)
    const types = new Set(h.events.map((event) => event.type))
    for (const type of ['case', 'plan', 'run', 'step', 'finding', 'agent', 'log'] as const) {
      if (type === 'step') continue // 假执行器不发步骤事件，步骤事件在 e2e 中验证
      expect(types.has(type), type).toBe(true)
    }
    const plans = h.events.filter((event) => event.type === 'plan')
    expect(plans.length).toBeGreaterThanOrEqual(2)
  })
})

export type { Run, TestCase }
