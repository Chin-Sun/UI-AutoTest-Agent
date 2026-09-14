/**
 * 边界流程（真实浏览器）：驳回缺陷修正预期、环境抖动自动重试、登录态缺失、执行中取消、OBS 组件、重启后数据仍在。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Run, TestCase } from '@uta/core'
import { REPO, startTestServer, type TestServer } from '../support/harness'
import { client, collectEvents, terminal, until, type EventLog } from '../support/http'

let t: TestServer
let ws: EventLog
const api = client(() => t.base)

async function newCase(projectId: string, title: string, steps: string[], expected: string[]): Promise<TestCase> {
  const testCase = await api.post<TestCase>('/api/cases', { projectId, title, steps, expected })
  await api.prepare(testCase.id)
  return testCase
}
const runCase = (caseId: string, options: { obs?: boolean } = {}) => api.post<Run[]>('/api/runs', { caseIds: [caseId], ...options }).then((runs) => runs[0]!)
const findingsOf = async (projectId: string, caseId: string) => (await api.findings(projectId)).filter((f) => f.caseId === caseId)

beforeAll(async () => {
  t = await startTestServer()
  ws = await collectEvents(t.port)
})
afterAll(async () => {
  ws?.close()
  await t?.close()
})

describe('边界流程', () => {
  it('驳回缺陷：人给出正确预期 → Agent 修正断言（需审批的改动之外）→ 第 2 轮通过', async () => {
    const testCase = await newCase('demo', '计数（预期写错）', ['打开「todos.html」', '在「新待办」输入「买牛奶」', '点击「添加」按钮'], ['页面显示「共 5 项」'])
    await runCase(testCase.id)
    const [finding] = await until(() => findingsOf('demo', testCase.id), (list) => list.length === 1)
    expect(finding).toMatchObject({ verdict: 'product-defect', status: 'awaiting_review' })
    await api.post(`/api/findings/${finding!.id}/feedback`, { kind: 'not-a-defect', content: '只加了一条，应显示「共 1 项」' })
    await until(() => findingsOf('demo', testCase.id), (list) => list[0]?.status === 'resolved')
    const [plan] = await api.plans(testCase.id)
    expect(plan).toMatchObject({ version: 2, status: 'approved' })
    expect(plan!.steps.at(-1)?.target).toEqual({ text: '共 1 项' })
    expect((await api.runs(`caseId=${testCase.id}`)).map((r) => [r.round, r.status])).toEqual([[2, 'passed'], [1, 'failed']])
  })

  it('环境抖动：站点不可达 → 自动重试一次 → 仍失败则交给人（旧 Finding 被取代）', async () => {
    const testCase = await newCase('offline', '离线站点', ['打开「index.html」'], ['页面显示「首页」'])
    await runCase(testCase.id)
    const runs = await until(() => api.runs(`caseId=${testCase.id}`), (list) => list.length === 2 && list.every(terminal))
    expect(runs.map((r) => r.trigger).sort()).toEqual(['flaky-retry', 'manual'])
    expect(runs[0]!.stepResults[0]?.error?.kind).toBe('navigation')
    const findings = await until(() => findingsOf('offline', testCase.id), (list) => list.some((f) => f.status === 'awaiting_human'))
    const open = findings.find((f) => f.status === 'awaiting_human')!
    expect(open.verdict).toBe('env-flaky')
    expect(findings.find((f) => f.id !== open.id)).toMatchObject({ status: 'dismissed', supersededBy: open.id })
  })

  it('登录态缺失：不启动浏览器，直接判为缺数据并提示生成 storageState', async () => {
    const testCase = await newCase('locked', '需要登录', ['打开「login.html」'], ['页面显示「登录」'])
    const run = await runCase(testCase.id)
    const [finding] = await until(() => findingsOf('locked', testCase.id), (list) => list.length === 1)
    expect(finding).toMatchObject({ verdict: 'data-missing', missingKeys: ['auth:admin'] })
    expect(finding!.suggestion).toContain('storageState')
    const done = (await api.runs(`caseId=${testCase.id}`)).find((r) => r.id === run.id)!
    expect(done.evidence).toEqual({})
    expect(ws.frames.get(run.id)).toBeUndefined()
  })

  it('执行中取消：立即变为已取消，浏览器迟到的结果被丢弃，不产生 Finding', async () => {
    const testCase = await newCase('demo', '慢用例', ['打开「login.html」', '等待 3 秒'], ['页面显示「登录」'])
    const run = await runCase(testCase.id)
    await until(() => api.runs(`caseId=${testCase.id}`), (list) => list[0]?.status === 'running', 30_000, 50)
    expect((await api.post<Run>(`/api/runs/${run.id}/cancel`)).status).toBe('cancelled')
    await until(async () => ws.logs(`run:${run.id}`), (lines) => lines.some((line) => line.includes('执行结果已过期')), 30_000)
    expect((await api.runs(`caseId=${testCase.id}`))[0]?.status).toBe('cancelled')
    expect(await findingsOf('demo', testCase.id)).toEqual([])
    expect((await api.send('POST', `/api/runs/${run.id}/cancel`)).status).toBe(409)
  })

  it('OBS 组件：启用后执行会调用录制；OBS 未运行时只记录失败，执行照常通过', async () => {
    const enabled = await api.post<{ status: string, tools: { name: string }[] }>('/api/components/mcp/obs-recorder', { enabled: true })
    expect(enabled.status).toBe('ready')
    expect(enabled.tools.map((tool) => tool.name)).toContain('start_record')
    type McpFile = { servers: Record<string, { enabled: boolean }> }
    const config = JSON.parse(await readFile(join(t.componentsDir, 'mcp.json'), 'utf8')) as McpFile
    expect(config.servers['obs-recorder']?.enabled).toBe(true)
    const repoConfig = JSON.parse(await readFile(join(REPO, 'components/mcp.json'), 'utf8')) as McpFile
    expect(repoConfig.servers['obs-recorder']?.enabled).toBe(false)

    const [login] = (await api.cases()).filter((c) => c.title.includes('登录成功'))
    await api.prepare(login!.id)
    const run = await runCase(login!.id, { obs: true })
    await until(() => api.runs(`caseId=${login!.id}`), (list) => list.some((r) => r.id === run.id && terminal(r)))
    expect((await api.runs(`caseId=${login!.id}`)).find((r) => r.id === run.id)?.status).toBe('passed')
    const lines = ws.logs(`run:${run.id}`)
    expect(lines.some((line) => line.startsWith('OBS 开始录制失败'))).toBe(true)
    expect(lines.some((line) => line.startsWith('OBS 停止录制失败'))).toBe(true)
    expect((await api.post<{ status: string }>('/api/components/mcp/obs-recorder', { enabled: false })).status).toBe('disabled')
  })

  it('重启服务：数据来自磁盘，用例/计划/Finding 全部保留，演示用例不重复导入', async () => {
    const before = { cases: (await api.cases()).length, findings: (await api.findings()).length, plans: (await api.plans((await api.cases())[0]!.id)).length }
    await t.restart()
    ws.close()
    ws = await collectEvents(t.port)
    expect((await api.cases()).length).toBe(before.cases)
    expect((await api.findings()).length).toBe(before.findings)
    expect((await api.plans((await api.cases())[0]!.id)).length).toBe(before.plans)
    const report = await api.report()
    expect(report.summary.cases).toBe(before.cases)
  })
})
