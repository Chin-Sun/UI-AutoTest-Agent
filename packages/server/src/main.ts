import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, startServer } from './server'

// 本地密钥放在仓库根目录的 .env（已 gitignore）；已存在的环境变量不会被覆盖
const envFile = join(REPO_ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

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
