/**
 * 主流程（API 层）：真实服务 + 真实浏览器执行 + mock 模型。
 * 用例录入 → 编译/编辑/批准 → 执行（实时事件）→ 证据 → 归因 → 门禁反馈 → 重跑 → 审阅 → 报告定稿。
 * 各 it 按顺序共享同一个服务实例，前一步的产物是后一步的输入。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding, Run, StepPlan, TestCase } from '@uta/core'
import { startTestServer, type TestServer } from '../support/harness'
import { client, collectEvents, terminal, until, type EventLog } from '../support/http'

let t: TestServer
let ws: EventLog
const api = client(() => t.base)
const state: { cases: TestCase[], plans: Map<string, StepPlan>, findings: Finding[] } = { cases: [], plans: new Map(), findings: [] }
const caseOf = (keyword: string) => state.cases.find((c) => c.title.includes(keyword))!
const findingOf = (keyword: string) => state.findings.find((f) => f.caseId === caseOf(keyword).id)!

beforeAll(async () => {
  t = await startTestServer()
  ws = await collectEvents(t.port)
})
afterAll(async () => {
  ws?.close()
  await t?.close()
})

describe('主流程 · API', () => {
  it('1. 服务启动：健康检查通过，强制 mock 模型，导入 4 条演示用例', async () => {
    const health = await api.get<{ ok: boolean, llm: Record<string, string>, projects: { id: string }[] }>('/api/health')
    expect(health.ok).toBe(true)
    expect(Object.values(health.llm).every((provider) => provider === 'mock')).toBe(true)
    expect(health.projects.map((p) => p.id).sort()).toEqual(['demo', 'fixture', 'locked', 'offline'])
    state.cases = await api.cases()
    expect(state.cases).toHaveLength(4)
  })

  it('2. 编译四条用例为草稿；人工编辑一条草稿；全部批准', async () => {
    for (const testCase of state.cases) {
      const draft = await api.post<StepPlan>(`/api/cases/${testCase.id}/compile`)
      expect(draft).toMatchObject({ status: 'draft', version: 1, createdBy: 'agent' })
      state.plans.set(testCase.id, draft)
    }
    const login = state.plans.get(caseOf('登录').id)!
    expect(login.steps.map((s) => s.action)).toEqual(['goto', 'fill', 'fill', 'click', 'assertVisible'])
    const edited = await api.put<StepPlan>(`/api/plans/${login.id}`, { steps: login.steps.map((s) => (s.id === 's5' ? { ...s, timeoutMs: 3000 } : s)) })
    expect(edited.createdBy).toBe('human')
    for (const plan of state.plans.values()) expect((await api.post<StepPlan>(`/api/plans/${plan.id}/approve`)).status).toBe('approved')
    expect(ws.events.filter((event) => event.type === 'plan').length).toBeGreaterThanOrEqual(8)
  })

  it('3. 执行全部：串行执行；实时推送画面帧、每步开始/结束、状态变化；登录用例通过', async () => {
    const queued = await api.post<Run[]>('/api/runs', { caseIds: state.cases.map((c) => c.id) })
    expect(queued.map((r) => r.status)).toEqual(['queued', 'queued', 'queued', 'queued'])
    const runs = await until(() => api.runs(), (list) => list.length >= 4 && list.every(terminal))
    const login = runs.find((r) => r.caseId === caseOf('登录').id)!
    expect(login).toMatchObject({ status: 'passed', round: 1, trigger: 'manual' })
    expect(login.stepResults.every((r) => r.status === 'passed')).toBe(true)
    expect(ws.frames.get(login.id) ?? 0).toBeGreaterThan(0)

    const stepEvents = ws.events.filter((event) => event.type === 'step' && event['runId'] === login.id).map((event) => `${String(event['stepId'])}:${String(event['phase'])}`)
    expect(stepEvents).toEqual(['s1', 's2', 's3', 's4', 's5'].flatMap((id) => [`${id}:start`, `${id}:end`]))
    const statuses = ws.events.filter((event) => event.type === 'run' && (event['run'] as Run).id === login.id).map((event) => (event['run'] as Run).status)
    expect(statuses).toEqual(['queued', 'running', 'passed'])

    // 串行：每个 run 的开始时间不早于前一个的结束时间
    const ordered = [...runs].sort((a, b) => a.startedAt! - b.startedAt!)
    for (let i = 1; i < ordered.length; i += 1) expect(ordered[i]!.startedAt!).toBeGreaterThanOrEqual(ordered[i - 1]!.finishedAt!)
  })

  it('4. 证据：截图 / 录像 / trace 可通过 /files 访问；Agent 过程记录已落盘', async () => {
    const login = (await api.runs(`caseId=${caseOf('登录').id}`))[0]!
    const checks: [string | undefined, string][] = [
      [login.stepResults[0]!.screenshot, 'image/png'],
      [login.evidence.video, 'video/webm'],
      [login.evidence.trace, 'application/zip'],
    ]
    for (const [path, type] of checks) {
      const response = await fetch(`${t.base}/files/${path}`)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type')).toContain(type)
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100)
    }
    const transcripts = await readdir(join(t.dataRoot, 'transcripts'))
    expect(transcripts.filter((name) => name.startsWith('compile-')).length).toBeGreaterThanOrEqual(4)
    expect(transcripts.some((name) => name.startsWith('triage-'))).toBe(true)
  })

  it('5. 归因：步骤错误 / 缺数据 / 产品缺陷 各进对应队列；报告因未处理项为草稿', async () => {
    state.findings = await until(() => api.findings(), (list) => list.length >= 3)
    expect(findingOf('昵称')).toMatchObject({ verdict: 'step-defect', status: 'awaiting_human', stepId: 's3' })
    expect(findingOf('昵称').suggestion).toContain('「保存」')
    expect(findingOf('VIP')).toMatchObject({ verdict: 'data-missing', status: 'awaiting_human', missingKeys: ['vipCode'], triagedBy: 'rule' })
    expect(findingOf('待办')).toMatchObject({ verdict: 'product-defect', status: 'awaiting_review', expected: '共 2 项' })
    expect(findingOf('待办').actual).toContain('共 1 项')
    expect(findingOf('待办').evidence.screenshot).toMatch(/\.png$/)

    const draft = await api.report()
    expect(draft.status).toBe('draft')
    expect(draft.blockers).toHaveLength(3)
  })

  it('6. 门禁：人指点按钮名 → 小修自动批准重跑；人补数据 → 重跑；两条都在第 2 轮通过', async () => {
    await api.post(`/api/findings/${findingOf('昵称').id}/feedback`, { kind: 'fix-step', content: '页面上的按钮叫「保存」' })
    await api.post(`/api/findings/${findingOf('VIP').id}/feedback`, { kind: 'supply-data', dataPatch: { vipCode: 'VIP-2026' } })
    await until(() => api.findings(), (list) => ['昵称', 'VIP'].every((k) => list.find((f) => f.caseId === caseOf(k).id)?.status === 'resolved'))

    const reruns = (await api.runs()).filter((run) => run.trigger === 'gate-rerun')
    expect(reruns.map((run) => [run.round, run.status])).toEqual([[2, 'passed'], [2, 'passed']])
    const nickPlans = await api.plans(caseOf('昵称').id)
    expect(nickPlans.map((p) => [p.version, p.status])).toEqual([[2, 'approved'], [1, 'superseded']])
    expect(nickPlans[0]!.steps.find((s) => s.id === 's3')?.target).toEqual({ role: 'button', name: '保存' })
    expect(nickPlans[0]!.derivedFrom?.findingId).toBe(findingOf('昵称').id)
    const vip = (await api.cases()).find((c) => c.id === caseOf('VIP').id)!
    expect(vip).toMatchObject({ data: { vipCode: 'VIP-2026' }, version: 2 })
    expect(ws.logs(`repair:${findingOf('昵称').id}`).some((line) => line.includes('自动批准并重跑'))).toBe(true)
  })

  it('7. 审阅：确认产品缺陷 → 报告定稿，HTML 含预期/实际与证据', async () => {
    await api.post(`/api/findings/${findingOf('待办').id}/feedback`, { kind: 'confirm-defect' })
    const report = await api.report()
    expect(report).toMatchObject({ status: 'final', blockers: [], summary: { cases: 4, passed: 3, failed: 1, defects: 1, open: 0 } })
    const html = await (await fetch(`${t.base}/files/${report.html}`)).text()
    expect(html).toContain(caseOf('待办').title)
    expect(html).toContain('共 2 项')
    expect(html).toMatch(/<img src="\.\.\/evidence\/run_[^"]+\.png"/)
  })

  it('8. 不可变与门禁拒绝：已批准计划不可编辑，已关闭的 Finding 不再接受反馈', async () => {
    const approved = (await api.plans(caseOf('登录').id))[0]!
    expect((await api.send('PUT', `/api/plans/${approved.id}`, { steps: approved.steps })).status).toBe(409)
    expect((await api.send('POST', `/api/findings/${findingOf('昵称').id}/feedback`, { kind: 'fix-step', content: '「x」' })).status).toBe(409)
    expect((await api.send('POST', `/api/findings/${findingOf('待办').id}/feedback`, { kind: 'dismiss' })).status).toBe(409)
  })
})
