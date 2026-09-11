/**
 * 端到端闭环（mock LLM + 真实浏览器 + 真实 HTTP/WS）：
 * 编译 → 批准 → 执行 → 归因 → 门禁反馈 → 修正/补数据重跑 → 审阅 → 报告定稿
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding, Report, Run, StepPlan, TestCase } from '@uta/core'
import { startServer } from '../src'

let server: Awaited<ReturnType<typeof startServer>>
let base: string
let dataRoot: string
const frames: string[] = []
let socket: WebSocket

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(`${path}: ${data.error}`)
  return data
}

async function until<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${JSON.stringify(value).slice(0, 400)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

beforeAll(async () => {
  process.env['LLM_PROVIDER'] = 'mock'
  dataRoot = await mkdtemp(join(tmpdir(), 'uta-e2e-'))
  server = await startServer({ port: await freePort(), dataRoot })
  base = `http://127.0.0.1:${server.port}`
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as { type: string }
    if (event.type === 'frame') frames.push('f')
  }
  await new Promise((resolve) => { socket.onopen = resolve })
})

afterAll(async () => {
  socket.close()
  await server.close()
  await rm(dataRoot, { recursive: true, force: true })
})

describe('完整闭环', () => {
  it('四条演示用例覆盖通过 / 步骤错误 / 缺数据 / 产品缺陷', async () => {
    const cases = await call<TestCase[]>('/api/cases?projectId=demo')
    expect(cases).toHaveLength(4)
    const byTitle = (keyword: string) => cases.find((c) => c.title.includes(keyword))!

    // ② 编译 + 人工批准
    for (const testCase of cases) {
      const plan = await call<StepPlan>(`/api/cases/${testCase.id}/compile`, {})
      expect(plan.status).toBe('draft')
      await call(`/api/plans/${plan.id}/approve`, {})
    }

    // ③ 执行全部
    await call<Run[]>('/api/runs', { caseIds: cases.map((c) => c.id) })
    const findings = await until(() => call<Finding[]>('/api/findings?projectId=demo'), (list) => list.length >= 3, 90_000)
    const runs = await until(() => call<Run[]>('/api/runs?projectId=demo'), (list) => list.every((r) => r.status === 'passed' || r.status === 'failed'))
    expect(runs.find((r) => r.caseId === byTitle('登录').id)?.status).toBe('passed')
    expect(frames.length).toBeGreaterThan(0)

    const findingOf = (keyword: string) => findings.find((f) => f.caseId === byTitle(keyword).id)!
    expect(findingOf('昵称')).toMatchObject({ verdict: 'step-defect', status: 'awaiting_human', stepId: 's3' })
    expect(findingOf('VIP')).toMatchObject({ verdict: 'data-missing', status: 'awaiting_human', missingKeys: ['vipCode'] })
    expect(findingOf('待办')).toMatchObject({ verdict: 'product-defect', status: 'awaiting_review' })
    expect(findingOf('待办').actual).toContain('共 1 项')

    // ④ 门禁：人指点按钮名 → Agent 修正（小修自动批准）→ 重跑第 2 轮
    await call(`/api/findings/${findingOf('昵称').id}/feedback`, { kind: 'fix-step', content: '按钮叫「保存」' })
    // ④ 门禁：人补充数据 → 重跑第 2 轮
    await call(`/api/findings/${findingOf('VIP').id}/feedback`, { kind: 'supply-data', dataPatch: { vipCode: 'VIP-2026' } })
    // ⑤ 审阅：确认产品缺陷
    await call(`/api/findings/${findingOf('待办').id}/feedback`, { kind: 'confirm-defect' })

    const settled = await until(() => call<Finding[]>('/api/findings?projectId=demo'), (list) => (
      ['昵称', 'VIP'].every((k) => list.find((f) => f.caseId === byTitle(k).id)?.status === 'resolved')
    ), 90_000)
    expect(settled.find((f) => f.caseId === byTitle('待办').id)?.status).toBe('confirmed')

    const reruns = (await call<Run[]>('/api/runs?projectId=demo')).filter((r) => r.trigger === 'gate-rerun')
    expect(reruns.map((r) => [r.round, r.status])).toEqual([[2, 'passed'], [2, 'passed']])
    const repaired = await call<StepPlan[]>(`/api/cases/${byTitle('昵称').id}/plans`)
    expect(repaired[0]).toMatchObject({ version: 2, status: 'approved' })
    expect(repaired[0]?.steps[2]?.target).toEqual({ role: 'button', name: '保存' })

    // 报告：没有待处理项时定稿
    const report = await call<Report>('/api/reports', { projectId: 'demo' })
    expect(report.status).toBe('final')
    expect(report.summary).toEqual({ cases: 4, passed: 3, failed: 1, defects: 1, open: 0 })
    const html = await fetch(`${base}/files/${report.html}`).then((r) => r.text())
    expect(html).toContain('共 2 项')
  }, 240_000)

  it('已批准计划不可编辑，非法反馈被门禁拒绝', async () => {
    const [testCase] = await call<TestCase[]>('/api/cases?projectId=demo')
    const [plan] = await call<StepPlan[]>(`/api/cases/${testCase!.id}/plans`)
    const edit = await fetch(`${base}/api/plans/${plan!.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: plan!.steps }) })
    expect(edit.status).toBe(409)
    const [finding] = (await call<Finding[]>('/api/findings?projectId=demo')).filter((f) => f.status === 'resolved')
    const feedback = await fetch(`${base}/api/findings/${finding!.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fix-step', content: 'x' }) })
    expect(feedback.status).toBe(409)
  })
})
