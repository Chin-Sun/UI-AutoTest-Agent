/**
 * 真实浏览器集成测试：用本地 demo 站点跑四类结果（通过 / 定位失败 / 断言失败 / 缺数据）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@uta/core'
import { runPlan } from '../src'

const site = fileURLToPath(new URL('../../../projects/demo/site/', import.meta.url))
let server: Server
let baseURL: string
let evidence: string

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      const body = await readFile(join(site, (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'login.html'))
      res.writeHead(200, { 'content-type': extname(req.url ?? '') === '.css' ? 'text/css' : 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  evidence = await mkdtemp(join(tmpdir(), 'uta-runner-'))
})
afterAll(async () => {
  server.close()
  await rm(evidence, { recursive: true, force: true })
})

const run = (name: string, steps: Step[], data: Record<string, string> = {}) => runPlan({
  steps, data, baseURL, evidenceDir: join(evidence, name), evidenceRel: `evidence/${name}`,
  actionTimeoutMs: 1_500, assertTimeoutMs: 1_500,
})

describe('runPlan', () => {
  it('登录通过，并产出截图/录像/trace', async () => {
    const frames: string[] = []
    const result = await runPlan({
      baseURL, evidenceDir: join(evidence, 'login'), evidenceRel: 'evidence/login', data: { user: 'alice' },
      hooks: { onFrame: (frame) => frames.push(frame) },
      steps: [
        { id: 's1', action: 'goto', value: 'login.html' },
        { id: 's2', action: 'fill', target: { label: '用户名' }, value: '${data.user}' },
        { id: 's3', action: 'fill', target: { label: '密码' }, value: 'secret' },
        { id: 's4', action: 'click', target: { role: 'button', name: '登录' } },
        { id: 's5', action: 'assertText', target: { testId: 'welcome' }, expect: '欢迎，alice' },
      ],
    })
    expect(result.status).toBe('passed')
    expect(result.stepResults.every((r) => r.status === 'passed')).toBe(true)
    expect(frames.length).toBeGreaterThan(0)
    expect((await stat(join(evidence, 'login', 'video.webm'))).size).toBeGreaterThan(0)
    expect((await stat(join(evidence, 'login', 'trace.zip'))).size).toBeGreaterThan(0)
  }, 30_000)

  it('按钮名写错 → locator 失败，后续步骤 skipped', async () => {
    const result = await run('profile', [
      { id: 's1', action: 'goto', value: 'profile.html' },
      { id: 's2', action: 'click', target: { role: 'button', name: '提交' } },
      { id: 's3', action: 'assertVisible', target: { text: '已保存' } },
    ])
    expect(result.status).toBe('failed')
    expect(result.stepResults[1]?.error?.kind).toBe('locator')
    expect(result.stepResults[1]?.ariaSnapshot).toContain('保存')
    expect(result.stepResults[2]?.status).toBe('skipped')
  }, 30_000)

  it('埋点缺陷 → assertion 失败并记录实际值', async () => {
    const result = await run('todos', [
      { id: 's1', action: 'goto', value: 'todos.html' },
      { id: 's2', action: 'fill', target: { placeholder: '新待办' }, value: '买牛奶' },
      { id: 's3', action: 'click', target: { role: 'button', name: '添加' } },
      { id: 's4', action: 'fill', target: { placeholder: '新待办' }, value: '写周报' },
      { id: 's5', action: 'click', target: { role: 'button', name: '添加' } },
      { id: 's6', action: 'assertText', target: { testId: 'todo-count' }, expect: '共 2 项' },
    ])
    expect(result.stepResults[5]?.error?.kind).toBe('assertion')
    expect(result.stepResults[5]?.actual).toBe('共 1 项')
  }, 30_000)

  it('缺数据在执行前判定，不启动浏览器', async () => {
    const result = await run('redeem', [
      { id: 's1', action: 'goto', value: 'redeem.html' },
      { id: 's2', action: 'fill', target: { label: '兑换码' }, value: '${data.vipCode}' },
      { id: 's3', action: 'assertVisible', target: { text: '兑换成功' } },
    ])
    expect(result.stepResults).toEqual([expect.objectContaining({ stepId: 's2', error: { kind: 'missing-data', message: '缺少测试数据：vipCode' } })])
  })
})
