/** 组装：存储 + 组件注册表 + LLM 路由 + Agent 服务 + Pipeline + HTTP/WS */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '@uta/core'
import { AgentServices, ComponentRegistry, createLlmRouter, loadLlmConfig } from '@uta/agent'
import type { runPlan } from '@uta/runner'
import { buildApp } from './app'
import { Bus } from './bus'
import { Pipeline } from './pipeline'
import { loadProjectFlows } from '@uta/flows'
import { loadProjects, projectDir } from './projects'
import { usageRecorder } from './usage'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface ServerOptions {
  port?: number
  host?: string
  dataRoot?: string
  /** 以下目录默认指向仓库；测试传入临时副本，避免污染仓库 */
  componentsDir?: string
  projectsDir?: string
  llmConfigPath?: string
  webDist?: string
  /** 首次启动导入演示用例（默认 true） */
  seed?: boolean
  /** 注入执行器（测试用） */
  runPlan?: typeof runPlan
  /** 强制所有角色使用该 provider（忽略配置文件与 LLM_PROVIDER）；测试用它锁定 mock，避免误调付费接口 */
  llmProvider?: string
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env['UTA_PORT'] ?? 4600)
  const dataRoot = resolve(options.dataRoot ?? process.env['UTA_DATA'] ?? join(REPO_ROOT, 'data'))
  const projectsDir = options.projectsDir ?? join(REPO_ROOT, 'projects')

  const bus = new Bus()
  const store = createStore(dataRoot)
  const llmConfig = loadLlmConfig(options.llmConfigPath ?? join(REPO_ROOT, 'config/llm.yaml'))
  if (options.llmProvider !== undefined) {
    llmConfig.default = options.llmProvider
    llmConfig.roles = {}
  }
  const llm = createLlmRouter(llmConfig)
  const registry = new ComponentRegistry(options.componentsDir ?? join(REPO_ROOT, 'components'), REPO_ROOT)
  await registry.load()
  const agents = new AgentServices({
    registry,
    llmFor: (role) => llm.forRole(role),
    onEvent: (scope, event) => bus.emit({ type: 'agent', scope, event }),
    onUsage: usageRecorder(store, bus),
  })
  // 项目配置里的 ${UTA_PORT} 指向本服务（demo 站点由本服务托管）
  const projects = await loadProjects(projectsDir, REPO_ROOT, { ...process.env, UTA_PORT: String(port) })
  // 项目积木：projects/<目录>/flows/index.ts（没有则为空）
  const flows = new Map(await Promise.all([...projects.values()].map(async (project) => {
    const dir = projectDir(project)
    return [project.id, dir === undefined ? [] : await loadProjectFlows(dir)] as const
  })))
  const pipeline = new Pipeline({ store, agents, registry, projects, bus, dataRoot, flows, ...(options.runPlan === undefined ? {} : { runPlan: options.runPlan }) })
  if (options.seed ?? true) await pipeline.seed('demo', join(projectsDir, 'demo/cases.json'))

  const app = await buildApp({
    repoRoot: REPO_ROOT, projectsDir, dataRoot, webDist: options.webDist ?? join(REPO_ROOT, 'packages/web/dist'),
    store, pipeline, agents, registry, projects, bus, llm,
  })
  await app.listen({ port, host: options.host ?? '127.0.0.1' })
  return {
    app, pipeline, store, registry, bus, port, dataRoot, llm,
    async close() {
      await app.close()
      await registry.close()
    },
  }
}
