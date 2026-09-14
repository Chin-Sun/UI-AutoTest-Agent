/**
 * 端到端测试服务：每个测试文件一个完全隔离的实例。
 * - 数据、组件、项目、模型配置全部是临时副本，测完 close() 整体删除
 * - 强制 mock 模型：即使本机设置了 LLM_PROVIDER 也不会调用付费接口
 * - 额外提供 3 个边界项目：offline（站点不可达）、locked（登录态缺失）、fixture（清单导入）
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '@uta/server'

export const REPO = fileURLToPath(new URL('../../', import.meta.url))

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

export interface TestServer {
  base: string
  port: number
  root: string
  dataRoot: string
  componentsDir: string
  server: Awaited<ReturnType<typeof startServer>>
  /** 用同一份数据重启（新端口），验证磁盘即真相 */
  restart(): Promise<void>
  close(): Promise<void>
}

async function prepare(root: string): Promise<void> {
  const componentsDir = join(root, 'components')
  const projectsDir = join(root, 'projects')
  await cp(join(REPO, 'components/skills'), join(componentsDir, 'skills'), { recursive: true })
  await cp(join(REPO, 'components/mcp.json'), join(componentsDir, 'mcp.json'))
  await cp(join(REPO, 'projects/demo'), join(projectsDir, 'demo'), { recursive: true })
  const demoURL = 'http://127.0.0.1:${UTA_PORT}/demo/'
  const project = async (id: string, lines: string[]) => {
    await mkdir(join(projectsDir, id), { recursive: true })
    await writeFile(join(projectsDir, id, 'project.yaml'), [`id: ${id}`, ...lines, 'slowMo: 0', 'actionTimeoutMs: 2000', 'assertTimeoutMs: 2000', ''].join('\n'))
  }
  await project('demo', ['name: 演示站点（本地）', `baseURL: ${demoURL}`])
  await project('offline', ['name: 离线站点', 'baseURL: http://127.0.0.1:1/'])
  await project('locked', ['name: 缺登录态', `baseURL: ${demoURL}`, 'defaultAuthRole: admin', 'authRoles:', `  admin: ${join(root, 'missing-auth.json')}`])
  await project('fixture', ['name: 清单夹具', `baseURL: ${demoURL}`, 'importers:', `  checklistDir: ${join(REPO, 'packages/server/test/fixtures/checklists')}`])
  await writeFile(join(root, 'llm.yaml'), 'default: mock\nproviders:\n  mock: { type: mock }\n')
}

export async function startTestServer(options: { webDist?: string } = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), 'uta-e2e-'))
  const boot = async () => {
    const port = await freePort()
    return startServer({
      port,
      dataRoot: join(root, 'data'),
      componentsDir: join(root, 'components'),
      projectsDir: join(root, 'projects'),
      llmConfigPath: join(root, 'llm.yaml'),
      llmProvider: 'mock',
      webDist: options.webDist ?? join(root, 'no-web-dist'),
    })
  }
  try {
    await prepare(root)
    const handle: TestServer = {
      base: '', port: 0, root, dataRoot: join(root, 'data'), componentsDir: join(root, 'components'), server: undefined as never,
      async restart() {
        await handle.server.close()
        handle.server = await boot()
        handle.port = handle.server.port
        handle.base = `http://127.0.0.1:${handle.port}`
      },
      async close() {
        await handle.server?.close().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      },
    }
    handle.server = await boot()
    handle.port = handle.server.port
    handle.base = `http://127.0.0.1:${handle.port}`
    return handle
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
