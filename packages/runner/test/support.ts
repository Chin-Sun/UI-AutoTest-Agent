/** runner 测试共用：静态服务（demo 站点 + 夹具页）与临时证据目录 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const roots = [
  fileURLToPath(new URL('./fixtures/', import.meta.url)),
  fileURLToPath(new URL('../../../projects/demo/site/', import.meta.url)),
]

export interface StaticSite {
  baseURL: string
  evidence: string
  close(): Promise<void>
}

export async function startSite(): Promise<StaticSite> {
  const serve = async (url: string | undefined, res: ServerResponse) => {
    const name = (url ?? '/').split(/[?#]/)[0]!.replace(/^\/+/, '') || 'login.html'
    for (const root of roots) {
      try {
        const body = await readFile(join(root, name))
        res.writeHead(200, { 'content-type': extname(name) === '.css' ? 'text/css' : 'text/html; charset=utf-8' })
        res.end(body)
        return
      } catch {
        // 试下一个根目录
      }
    }
    res.writeHead(404).end()
  }
  const server: Server = createServer((req, res) => {
    void serve(req.url, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const evidence = await mkdtemp(join(tmpdir(), 'uta-runner-'))
  return {
    baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    evidence,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await rm(evidence, { recursive: true, force: true })
    },
  }
}
