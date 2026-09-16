/** flows 测试共用：静态夹具站点（登录页形态各异）+ 临时目录 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtures = fileURLToPath(new URL('./fixtures/site/', import.meta.url))

export interface FixtureSite {
  baseURL: string
  /** 测试可写的临时目录（登录态、状态文件） */
  dir: string
  close(): Promise<void>
}

export async function startSite(): Promise<FixtureSite> {
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? '/').split(/[?#]/)[0]!.replace(/^\/+/, '')
    // 模拟后端：过期 token 的接口要过一会儿才返回 401
    if (name === 'api/slow-user') {
      const expired = (req.headers['access-token'] ?? '') === 'expired'
      setTimeout(() => res.writeHead(expired ? 401 : 200, { 'content-type': 'application/json' }).end(expired ? '{"code":401}' : '{"code":200}'), 2_000)
      return
    }
    readFile(join(fixtures, name)).then(
      (body) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body),
      () => res.writeHead(404).end(),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'uta-flows-'))
  return {
    baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    dir,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    },
  }
}
