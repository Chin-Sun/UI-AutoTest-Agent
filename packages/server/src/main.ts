import { startServer } from './server'

const server = await startServer()
const routes = server.llm.describe()
console.log(`UI Test Agent 已启动：http://127.0.0.1:${server.port}`)
console.log(`  数据目录：${server.dataRoot}`)
console.log(`  LLM 路由：${Object.entries(routes).map(([role, provider]) => `${role}=${provider}`).join('  ')}`)
console.log(`  组件：${server.registry.skills.size} 个 skill，MCP ${[...server.registry.mcp.values()].map((s) => `${s.name}(${s.status})`).join(' ') || '无'}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
