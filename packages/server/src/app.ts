import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z, ZodError } from 'zod'
import { GateError, NotFoundError, newId, sumUsage, type Project, type Store } from '@uta/core'
import { AgentFailure, type AgentServices, type ComponentRegistry } from '@uta/agent'
import type { Bus } from './bus'
import { listChecklists, readChecklist } from './importers'
import { CaseInputSchema, FeedbackInputSchema, type Pipeline } from './pipeline'

export interface AppContext {
  repoRoot: string
  projectsDir: string
  dataRoot: string
  webDist: string
  store: Store
  pipeline: Pipeline
  agents: AgentServices
  registry: ComponentRegistry
  projects: Map<string, Project>
  bus: Bus
  llm: { describe(): Record<string, string> }
}

type Params = Record<string, string>
type Query = Record<string, string | undefined>

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { store, pipeline, registry } = ctx
  const app = Fastify({ bodyLimit: 60 * 1024 * 1024 })

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error instanceof GateError
      ? 409
      : error instanceof NotFoundError
        ? 404
        : error instanceof ZodError
          ? 400
          : error instanceof AgentFailure
            ? 422
            : error.statusCode ?? 500
    void reply.status(status).send({ error: error instanceof ZodError ? z.prettifyError(error) : error.message })
  })

  await app.register(websocket)
  await mkdir(ctx.dataRoot, { recursive: true })
  await app.register(fastifyStatic, { root: join(ctx.projectsDir, 'demo/site'), prefix: '/demo/', index: ['login.html'] })
  await app.register(fastifyStatic, { root: ctx.dataRoot, prefix: '/files/', decorateReply: false })
  if (existsSync(ctx.webDist)) await app.register(fastifyStatic, { root: ctx.webDist, prefix: '/', decorateReply: false })

  // 实时通道：所有总线事件广播给前端，客户端按 runId/scope 过滤
  await app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (socket) => {
      const off = ctx.bus.on((event) => {
        if (socket.readyState !== 1) return
        if (event.type === 'frame' && socket.bufferedAmount > 4_000_000) return // 背压：丢帧不丢状态
        socket.send(JSON.stringify(event))
      })
      socket.on('close', off)
    })
  })

  const byNewest = <T extends { createdAt: number }>(items: T[]) => items.sort((a, b) => b.createdAt - a.createdAt)

  app.get('/api/health', async () => ({
    ok: true,
    llm: ctx.llm.describe(),
    projects: [...ctx.projects.values()].map((project) => ({ id: project.id, name: project.name })),
    queue: pipeline.queueState(),
  }))
  app.get('/api/projects', async () => [...ctx.projects.values()])
  app.get('/api/projects/:id/flows', async (request) => {
    const id = (request.params as Params)['id']!
    pipeline.project(id)
    return pipeline.flowSpecs(id).map(({ validate: _validate, ...spec }) => spec)
  })

  // ---------- 用例 ----------
  app.get('/api/cases', async (request) => {
    const { projectId } = request.query as Query
    return byNewest(await store.cases.list((doc) => projectId === undefined || doc.projectId === projectId))
  })
  app.post('/api/cases', async (request) => pipeline.createCase(CaseInputSchema.parse(request.body)))
  app.put('/api/cases/:id', async (request) => pipeline.updateCase((request.params as Params)['id']!, request.body as never))
  app.get('/api/cases/:id/plans', async (request) => pipeline.plansOf((request.params as Params)['id']!))
  app.post('/api/cases/:id/compile', async (request) => pipeline.compile((request.params as Params)['id']!))

  // ---------- 计划 ----------
  app.get('/api/plans/:id', async (request) => store.plans.require((request.params as Params)['id']!))
  app.put('/api/plans/:id', async (request) => {
    const body = (request.body ?? {}) as { steps?: unknown, data?: unknown, decisions?: unknown }
    return pipeline.savePlanDraft((request.params as Params)['id']!, body.steps, { data: body.data, decisions: body.decisions })
  })
  app.post('/api/plans/:id/approve', async (request) => pipeline.approvePlan((request.params as Params)['id']!))
  app.post('/api/plans/:id/discard', async (request) => pipeline.discardPlan((request.params as Params)['id']!))

  // ---------- 执行 ----------
  app.get('/api/runs', async (request) => {
    const { projectId, caseId } = request.query as Query
    return byNewest(await store.runs.list((run) => (projectId === undefined || run.projectId === projectId) && (caseId === undefined || run.caseId === caseId))).slice(0, 200)
  })
  app.get('/api/runs/:id', async (request) => store.runs.require((request.params as Params)['id']!))
  app.post('/api/runs', async (request) => {
    const body = z.object({ caseIds: z.array(z.string()).min(1), headed: z.boolean().default(false), obs: z.boolean().default(false) }).parse(request.body)
    return pipeline.enqueue(body.caseIds, { headed: body.headed, obs: body.obs })
  })
  app.post('/api/runs/:id/cancel', async (request) => pipeline.cancel((request.params as Params)['id']!))

  // ---------- 门禁 / 审阅 ----------
  app.get('/api/findings', async (request) => {
    const { projectId } = request.query as Query
    return byNewest(await store.findings.list((finding) => projectId === undefined || finding.projectId === projectId))
  })
  app.post('/api/findings/:id/feedback', async (request) => pipeline.feedback((request.params as Params)['id']!, FeedbackInputSchema.parse(request.body)))
  app.post('/api/uploads', async (request) => {
    const body = z.object({ filename: z.string().min(1), base64: z.string().min(1) }).parse(request.body)
    const dir = join(ctx.dataRoot, 'uploads')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${newId('up')}-${basename(body.filename).replace(/[^\w.\-一-龥]/g, '_')}`)
    await writeFile(path, Buffer.from(body.base64, 'base64'))
    return { path }
  })

  // ---------- 报告 ----------
  app.get('/api/reports', async (request) => {
    const { projectId } = request.query as Query
    return byNewest(await store.reports.list((report) => projectId === undefined || report.projectId === projectId))
  })
  app.post('/api/reports', async (request) => pipeline.report(z.object({ projectId: z.string() }).parse(request.body).projectId))

  // ---------- Token 用量 ----------
  // scope 可传多个前缀（逗号分隔）；total 为全部匹配记录的累计，records 为最近 200 条
  app.get('/api/usage', async (request) => {
    const { projectId, scope } = request.query as Query
    const prefixes = (scope ?? '').split(',').filter((prefix) => prefix !== '')
    const records = byNewest(await store.usage.list((record) => (projectId === undefined || record.projectId === projectId)
      && (prefixes.length === 0 || prefixes.some((prefix) => record.scope.startsWith(prefix)))))
    return { total: sumUsage(records), records: records.slice(0, 200) }
  })

  // ---------- 组件 / Agent ----------
  app.get('/api/components', async () => ({ ...registry.describe(), drafts: await registry.listDrafts() }))
  app.post('/api/components/mcp/:name', async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body)
    const { client: _client, ...state } = await registry.setMcpEnabled((request.params as Params)['name']!, enabled)
    return state
  })
  app.post('/api/components/drafts/:name/approve', async (request) => {
    await registry.approveDraft((request.params as Params)['name']!)
    return { ok: true }
  })
  app.post('/api/components/drafts/:name/reject', async (request) => {
    await registry.rejectDraft((request.params as Params)['name']!)
    return { ok: true }
  })
  app.post('/api/agent/ask', async (request) => {
    const { request: text } = z.object({ request: z.string().min(1) }).parse(request.body)
    return ctx.agents.ask(text)
  })

  // ---------- 导入（molardata 功能点清单）----------
  const checklistDir = (projectId: string) => {
    const dir = ctx.projects.get(projectId)?.importers['checklistDir']
    if (dir === undefined) throw new GateError(`项目 ${projectId} 没有配置清单导入`)
    return dir
  }
  app.get('/api/importers/:projectId/checklists', async (request) => listChecklists(checklistDir((request.params as Params)['projectId']!)))
  app.get('/api/importers/:projectId/checklists/:file', async (request) => {
    const params = request.params as Params
    return readChecklist(checklistDir(params['projectId']!), params['file']!)
  })
  app.post('/api/importers/:projectId/checklists', async (request) => {
    const projectId = (request.params as Params)['projectId']!
    const body = z.object({ file: z.string(), keys: z.array(z.string()).min(1) }).parse(request.body)
    const items = (await readChecklist(checklistDir(projectId), body.file)).filter((item) => body.keys.includes(item.key))
    const existing = new Set((await store.cases.list((doc) => doc.projectId === projectId)).map((doc) => doc.source))
    let created = 0
    for (const item of items) {
      if (existing.has(`molardata:${item.key}`)) continue
      await pipeline.createCase({
        projectId,
        title: `${item.key} ${item.title.slice(0, 60)}`,
        module: item.section,
        steps: [item.title],
        expected: [item.title],
        source: `molardata:${item.key}`,
        notes: ['来自功能点清单：需要编译 Agent 结合 molar-platform 知识展开成具体步骤'],
      })
      created += 1
    }
    return { created, skipped: items.length - created }
  })

  return app
}
