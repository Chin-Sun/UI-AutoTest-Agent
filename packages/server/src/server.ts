/** 组装：存储 + 组件注册表 + LLM 路由 + Agent 服务 + Pipeline + HTTP/WS */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '@uta/core'
import { AgentServices, ComponentRegistry, createLlmRouter, loadLlmConfig } from '@uta/agent'
import { buildApp } from './app'
import { Bus } from './bus'
import { Pipeline } from './pipeline'
import { loadProjects } from './projects'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface ServerOptions {
  port?: number
  host?: string
  dataRoot?: string
}

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env['UTA_PORT'] ?? 4600)
  // 项目配置里的 ${UTA_PORT} 依赖它（demo 站点由本服务托管）
  process.env['UTA_PORT'] = String(port)
  const dataRoot = resolve(options.dataRoot ?? process.env['UTA_DATA'] ?? join(REPO_ROOT, 'data'))

  const bus = new Bus()
  const store = createStore(dataRoot)
  const llm = createLlmRouter(loadLlmConfig(join(REPO_ROOT, 'config/llm.yaml')))
  const registry = new ComponentRegistry(join(REPO_ROOT, 'components'), REPO_ROOT)
  await registry.load()
  const agents = new AgentServices({
    registry,
    llmFor: (role) => llm.forRole(role),
    onEvent: (scope, event) => bus.emit({ type: 'agent', scope, event }),
  })
  const projects = await loadProjects(join(REPO_ROOT, 'projects'), REPO_ROOT)
  const pipeline = new Pipeline({ store, agents, registry, projects, bus, dataRoot })
  await pipeline.seed('demo', join(REPO_ROOT, 'projects/demo/cases.json'))

  const app = await buildApp({ repoRoot: REPO_ROOT, dataRoot, webDist: join(REPO_ROOT, 'packages/web/dist'), store, pipeline, agents, registry, projects, bus, llm })
  await app.listen({ port, host: options.host ?? '127.0.0.1' })
  return {
    app, pipeline, store, registry, bus, port, dataRoot, llm,
    async close() {
      await app.close()
      await registry.close()
    },
  }
}
