/** HTTP 接口：Fastify inject（不监听端口）；错误码映射、静态资源安全、导入、上传、组件 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding, StepPlan, TestCase } from '@uta/core'
import { buildApp } from '../src/app'
import { demoProject, makeHarness, REPO, until, type Harness } from './support'

const checklists = fileURLToPath(new URL('./fixtures/checklists/', import.meta.url))
let h: Harness
let app: FastifyInstance

beforeAll(async () => {
  h = await makeHarness({ projects: [demoProject(), demoProject({ id: 'fixture', name: '夹具', importers: { checklistDir: checklists } })] })
  await h.pipeline.seed('demo', join(REPO, 'projects/demo/cases.json'))
  app = await buildApp({
    repoRoot: REPO, projectsDir: join(REPO, 'projects'), dataRoot: h.dataRoot, webDist: join(h.root, 'no-web-dist'),
    store: h.store, pipeline: h.pipeline, agents: h.agents, registry: h.registry, projects: h.projects, bus: h.bus,
    llm: { describe: () => ({ compiler: 'mock' }) },
  })
})
afterAll(async () => {
  await app.close()
  await h.cleanup()
})

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number, body: T }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: (response.headers['content-type']?.includes('json') ? response.json() : response.body) as T }
}

describe('基础', () => {
  it('health / projects', async () => {
    const health = await req<{ ok: boolean, llm: object, projects: { id: string }[] }>('GET', '/api/health')
    expect(health.body).toMatchObject({ ok: true, llm: { compiler: 'mock' }, queue: { queued: [] } })
    expect(health.body.projects.map((p) => p.id)).toEqual(['demo', 'fixture'])
    expect((await req<unknown[]>('GET', '/api/projects')).body).toHaveLength(2)
    expect((await req<unknown[]>('GET', '/api/projects/demo/flows')).body).toEqual([])
    expect((await req('GET', '/api/projects/ghost/flows')).status).toBe(409)
  })
})

describe('Token 用量', () => {
  it('按项目与 scope 前缀（逗号分隔多个）过滤；返回累计与按时间倒序的记录', async () => {
    const put = (id: string, scope: string, projectId: string | undefined, input: number, createdAt: number) => h.store.usage.put({
      id, scope, role: 'compiler', model: 'm', ...(projectId === undefined ? {} : { projectId }), input, output: 1, calls: 1, createdAt,
    })
    await put('usage_t1', 'compile:usage_case_a', 'usage-project', 100, 1)
    await put('usage_t2', 'repair:usage_f1', 'usage-project', 20, 2)
    await put('usage_t3', 'compile:usage_case_b', 'usage-other', 5, 3)
    await put('usage_t4', 'compile:usage_case_c', undefined, 7, 4)
    const byProject = await req<{ total: object, records: { id: string }[] }>('GET', '/api/usage?projectId=usage-project')
    expect(byProject.body.total).toEqual({ input: 120, output: 2, calls: 2 })
    expect(byProject.body.records.map((record) => record.id)).toEqual(['usage_t2', 'usage_t1'])
    const byScopes = await req<{ total: object }>('GET', '/api/usage?scope=compile:usage_case_a,compile:usage_case_c')
    expect(byScopes.body.total).toEqual({ input: 107, output: 2, calls: 2 })
    expect((await req<{ total: object }>('GET', '/api/usage?scope=compile:usage_case_a&projectId=usage-other')).body.total).toEqual({ input: 0, output: 0, calls: 0 })
  })
})

describe('用例与计划', () => {
  it('创建：参数不合法 400（带可读错误）；成功返回用例；列表按项目过滤并按时间倒序', async () => {
    const bad = await req<{ error: string }>('POST', '/api/cases', { projectId: 'demo' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('title')
    const unknown = await req('POST', '/api/cases', { projectId: 'ghost', title: 't' })
    expect(unknown.status).toBe(409)
    const created = await req<TestCase>('POST', '/api/cases', { projectId: 'fixture', title: 'HTTP 用例', steps: ['打开「a.html」'], expected: ['页面显示「a」'] })
    expect(created.status).toBe(200)
    const list = await req<TestCase[]>('GET', '/api/cases?projectId=fixture')
    expect(list.body.map((c) => c.title)).toEqual(['HTTP 用例'])
  })

  it('PUT 部分更新不清空其他字段', async () => {
    const created = await req<TestCase>('POST', '/api/cases', { projectId: 'fixture', title: 'a', steps: ['s'], data: { k: 'v' } })
    const updated = await req<TestCase>('PUT', `/api/cases/${created.body.id}`, { title: 'b' })
    expect(updated.body).toMatchObject({ title: 'b', steps: ['s'], data: { k: 'v' }, version: 2 })
    expect((await req('PUT', '/api/cases/case_nope', { title: 'x' })).status).toBe(404)
  })

  it('编译 → 编辑 → 批准；已批准计划编辑 409；未知用例 404', async () => {
    const [testCase] = (await req<TestCase[]>('GET', '/api/cases?projectId=demo')).body.filter((c) => c.title.includes('登录'))
    const plan = await req<StepPlan>('POST', `/api/cases/${testCase!.id}/compile`, {})
    expect(plan.body.status).toBe('draft')
    expect((await req('PUT', `/api/plans/${plan.body.id}`, { steps: [{ id: 's1', action: 'click' }] })).status).toBe(409)
    expect((await req('PUT', `/api/plans/${plan.body.id}`, { steps: 'nope' })).status).toBe(400)
    expect((await req<StepPlan>('PUT', `/api/plans/${plan.body.id}`, { steps: plan.body.steps })).body.createdBy).toBe('human')
    expect((await req<StepPlan>('POST', `/api/plans/${plan.body.id}/approve`, {})).body.status).toBe('approved')
    expect((await req('PUT', `/api/plans/${plan.body.id}`, { steps: plan.body.steps })).status).toBe(409)
    expect((await req<StepPlan>('GET', `/api/plans/${plan.body.id}`)).body.id).toBe(plan.body.id)
    expect((await req<StepPlan[]>('GET', `/api/cases/${testCase!.id}/plans`)).body).toHaveLength(1)
    expect((await req('POST', '/api/cases/case_nope/compile', {})).status).toBe(404)
    expect((await req('GET', '/api/plans/plan_nope')).status).toBe(404)
  })

  it('编译 Agent 失败 → 422', async () => {
    const created = await req<TestCase>('POST', '/api/cases', { projectId: 'fixture', title: '看不懂', steps: ['随便点点'], expected: ['还行'] })
    const compiled = await req<{ error: string }>('POST', `/api/cases/${created.body.id}/compile`, {})
    expect(compiled.status).toBe(422)
    expect(compiled.body.error).toContain('无法理解')
  })
})

describe('执行与门禁', () => {
  it('参数校验与门禁错误码：空列表 400、无计划 409、未知 run 404', async () => {
    expect((await req('POST', '/api/runs', { caseIds: [] })).status).toBe(400)
    const [nick] = (await req<TestCase[]>('GET', '/api/cases?projectId=demo')).body.filter((c) => c.title.includes('昵称'))
    expect((await req('POST', '/api/runs', { caseIds: [nick!.id] })).status).toBe(409)
    expect((await req('POST', '/api/runs/run_nope/cancel', {})).status).toBe(404)
    expect((await req('GET', '/api/runs/run_nope')).status).toBe(404)
  })

  it('执行 → Finding → 反馈：非法 kind 400，非法流转 409，合法 200', async () => {
    const [nick] = (await req<TestCase[]>('GET', '/api/cases?projectId=demo')).body.filter((c) => c.title.includes('昵称'))
    const plan = await req<StepPlan>('POST', `/api/cases/${nick!.id}/compile`, {})
    await req('POST', `/api/plans/${plan.body.id}/approve`, {})
    const runs = await req<{ id: string }[]>('POST', '/api/runs', { caseIds: [nick!.id] })
    expect(runs.body).toHaveLength(1)
    const finding = await until(() => req<Finding[]>('GET', '/api/findings?projectId=demo').then((r) => r.body), (list) => list.length > 0).then((list) => list[0]!)
    expect((await req('POST', `/api/findings/${finding.id}/feedback`, { kind: 'bogus' })).status).toBe(400)
    expect((await req('POST', `/api/findings/${finding.id}/feedback`, { kind: 'not-a-defect', content: '「x」' })).status).toBe(409)
    expect((await req('POST', `/api/findings/${finding.id}/feedback`, { kind: 'dismiss' })).status).toBe(200)
    expect((await req<{ status: string }[]>('GET', `/api/runs?caseId=${nick!.id}`)).body[0]?.status).toBe('failed')
  })
})

describe('上传与报告', () => {
  it('上传：文件名只保留 basename 并清理特殊字符，写入 data/uploads', async () => {
    const uploaded = await req<{ path: string }>('POST', '/api/uploads', { filename: '../../evil name$.txt', base64: Buffer.from('内容').toString('base64') })
    expect(uploaded.body.path.startsWith(join(h.dataRoot, 'uploads'))).toBe(true)
    expect(uploaded.body.path).toMatch(/evil_name_\.txt$/)
    expect(await readFile(uploaded.body.path, 'utf8')).toBe('内容')
    expect((await req('POST', '/api/uploads', { filename: 'a.txt' })).status).toBe(400)
  })

  it('生成报告并能通过 /files 访问；未知项目 409', async () => {
    const report = await req<{ html: string, status: string }>('POST', '/api/reports', { projectId: 'demo' })
    expect(report.status).toBe(200)
    const html = await app.inject({ method: 'GET', url: `/files/${report.body.html}` })
    expect(html.statusCode).toBe(200)
    expect(html.body).toContain('UI 测试报告')
    expect((await req<unknown[]>('GET', '/api/reports?projectId=demo')).body.length).toBeGreaterThan(0)
    expect((await req('POST', '/api/reports', { projectId: 'ghost' })).status).toBe(409)
  })
})

describe('静态资源', () => {
  it('/demo/ 默认页是登录页；/files 不能穿越出数据目录', async () => {
    const demo = await app.inject({ method: 'GET', url: '/demo/' })
    expect(demo.statusCode).toBe(200)
    expect(demo.body).toContain('登录')
    for (const url of ['/files/../package.json', '/files/%2e%2e/package.json', '/files/..%2fpackage.json']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode, url).not.toBe(200)
    }
  })

  it('没有构建前端时 / 不提供页面', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404)
  })
})

describe('组件与 Agent', () => {
  it('组件列表；起草 → 批准；未知草稿 404；未知 MCP 500 以内错误', async () => {
    const components = await req<{ skills: { name: string }[], mcp: unknown[], drafts: unknown[] }>('GET', '/api/components')
    expect(components.body.skills.map((s) => s.name).sort()).toEqual(['case-to-flow', 'case-to-steps', 'component-forge', 'failure-triage', 'molar-platform'])
    const answer = await req<{ text: string }>('POST', '/api/agent/ask', { request: '需要一个校验 PDF 的组件' })
    expect(answer.status).toBe(200)
    const drafts = (await req<{ drafts: { name: string }[] }>('GET', '/api/components')).body.drafts
    expect(drafts).toHaveLength(1)
    expect((await req('POST', `/api/components/drafts/${drafts[0]!.name}/approve`, {})).status).toBe(200)
    expect((await req('POST', '/api/components/drafts/no-such-draft/approve', {})).status).toBe(404)
    expect((await req('POST', '/api/components/drafts/no-such-draft/reject', {})).status).toBe(200)
    expect((await req('POST', '/api/agent/ask', { request: '' })).status).toBe(400)
    expect((await req('POST', '/api/components/mcp/ghost', { enabled: true })).status).toBe(500)
    expect((await req('POST', '/api/components/mcp/ghost', {})).status).toBe(400)
  })
})

describe('清单导入', () => {
  it('列出 / 读取 / 导入 / 去重；未配置导入的项目 409；非法文件名 400', async () => {
    expect((await req<unknown[]>('GET', '/api/importers/fixture/checklists')).body).toEqual([{ file: '01-import.md', count: 1 }, { file: '02-workflow.md', count: 3 }])
    expect((await req<unknown[]>('GET', '/api/importers/fixture/checklists/02-workflow.md')).body).toHaveLength(3)
    const first = await req<{ created: number, skipped: number }>('POST', '/api/importers/fixture/checklists', { file: '02-workflow.md', keys: ['02-A1', '02-D1'] })
    expect(first.body).toEqual({ created: 2, skipped: 0 })
    const again = await req<{ created: number, skipped: number }>('POST', '/api/importers/fixture/checklists', { file: '02-workflow.md', keys: ['02-A1', '02-A2'] })
    expect(again.body).toEqual({ created: 1, skipped: 1 })
    const imported = (await req<TestCase[]>('GET', '/api/cases?projectId=fixture')).body.find((c) => c.source === 'molardata:02-A1')
    expect(imported).toMatchObject({ module: 'A. 节点类型与内置节点', steps: [expect.stringContaining('原始数据')] })
    expect((await req('GET', '/api/importers/demo/checklists')).status).toBe(409)
    expect((await req('GET', '/api/importers/fixture/checklists/..%2F..%2Fx.md')).status).toBe(400)
    expect((await req('POST', '/api/importers/fixture/checklists', { file: '02-workflow.md', keys: [] })).status).toBe(400)
  })
})

describe('数据隔离', () => {
  it('所有写入都在临时数据目录', () => {
    expect(existsSync(join(h.dataRoot, 'cases'))).toBe(true)
    expect(h.dataRoot.startsWith(h.root)).toBe(true)
  })
})
