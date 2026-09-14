/** 组件注册表：Skill 加载、按角色可见、真实 MCP 连接与调用、草稿审批 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComponentRegistry, type McpServerConfig } from '../src'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const echoServer = fileURLToPath(new URL('./fixtures/echo-mcp.ts', import.meta.url))
let dir: string
let registry: ComponentRegistry

async function skill(name: string, frontmatter: string, body = '# 正文') {
  await mkdir(join(dir, 'skills', name), { recursive: true })
  await writeFile(join(dir, 'skills', name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
}
async function readConfig(): Promise<{ servers: Record<string, McpServerConfig> }> {
  return JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')) as { servers: Record<string, McpServerConfig> }
}
async function mcpConfig(servers: Record<string, unknown>) {
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ servers }, null, 2))
}
const echo = (enabled: boolean, extra: Record<string, unknown> = {}) => ({
  description: '回显', enabled, command: process.execPath, args: ['--import', 'tsx', echoServer], roles: ['compiler'], ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uta-registry-'))
  registry = new ComponentRegistry(dir, repo)
})
afterEach(async () => {
  await registry.close()
  await rm(dir, { recursive: true, force: true })
})

describe('Skill', () => {
  beforeEach(async () => {
    await skill('a', 'name: alpha\ndescription: 编译知识\nroles: [compiler]', '# Alpha\n规则一')
    await skill('b', 'description: 通用')
    await mkdir(join(dir, 'skills', 'empty'), { recursive: true })
    await writeFile(join(dir, 'skills', 'README.md'), 'not a skill')
    await registry.load()
  })

  it('frontmatter 的 name 优先，缺省用目录名；没有 SKILL.md 的目录与散文件被忽略', () => {
    expect([...registry.skills.keys()].sort()).toEqual(['alpha', 'b'])
    expect(registry.skills.get('b')).toMatchObject({ description: '通用', roles: [] })
  })

  it('目录按角色过滤：roles 为空的 skill 对所有角色可见', () => {
    expect(registry.catalogFor('compiler')).toContain('alpha：编译知识')
    expect(registry.catalogFor('triager')).not.toContain('alpha')
    expect(registry.catalogFor('triager')).toContain('b：通用')
    expect(registry.catalogFor('triager')).toContain('可用 MCP：\n- (无)')
  })

  it('读取正文时去掉 frontmatter；未知 skill 报错并列出可用项', async () => {
    expect(await registry.loadSkillBody('alpha')).toBe('# Alpha\n规则一')
    await expect(registry.loadSkillBody('nope')).rejects.toThrow(/可用：alpha, b|可用：b, alpha/)
  })

  it('仓库内置的 5 个 skill 都能加载且描述非空', async () => {
    const real = new ComponentRegistry(join(repo, 'components'), repo)
    await real.loadSkills()
    expect([...real.skills.keys()].sort()).toEqual(['case-to-flow', 'case-to-steps', 'component-forge', 'failure-triage', 'molar-platform'])
    for (const info of real.skills.values()) expect(info.description.length).toBeGreaterThan(5)
  })
})

describe('MCP', () => {
  it('没有 mcp.json 时为空；停用的组件不连接', async () => {
    await registry.load()
    expect(registry.mcp.size).toBe(0)
    await mcpConfig({ echo: echo(false) })
    await registry.load()
    expect(registry.mcp.get('echo')?.status).toBe('disabled')
    expect(registry.mcpToolsFor('compiler')).toEqual([])
  })

  it('启用后真实连接 stdio server：按角色暴露带命名空间的工具，并可调用', async () => {
    await mcpConfig({ echo: echo(true) })
    await registry.load()
    const state = registry.mcp.get('echo')!
    expect(state.status, state.error).toBe('ready')
    expect(state.tools.map((t) => t.name).sort()).toEqual(['echo', 'fail'])
    expect(registry.isMcpReady('echo')).toBe(true)

    const tools = registry.mcpToolsFor('compiler')
    expect(tools.map((t) => t.spec.name).sort()).toEqual(['mcp__echo__echo', 'mcp__echo__fail'])
    expect(tools[0]!.spec.description).toMatch(/^\[echo\]/)
    expect(registry.mcpToolsFor('triager')).toEqual([])
    expect(registry.catalogFor('compiler')).toContain('echo：回显（2 个工具）')

    const echoTool = tools.find((t) => t.spec.name === 'mcp__echo__echo')!
    expect(await echoTool.run({ text: '你好' })).toBe('echo:你好')
    await expect(registry.callMcp('echo', 'fail', {})).rejects.toThrow('坏了')
    expect(JSON.stringify(registry.describe())).not.toContain('"client"')
  }, 60_000)

  it('启停写回 mcp.json；未知组件与未就绪组件报错', async () => {
    await mcpConfig({ echo: echo(false) })
    await registry.load()
    await expect(registry.callMcp('echo', 'echo', {})).rejects.toThrow(/未就绪/)
    expect((await registry.setMcpEnabled('echo', true)).status).toBe('ready')
    expect((await readConfig()).servers['echo']?.enabled).toBe(true)
    expect((await registry.setMcpEnabled('echo', false)).status).toBe('disabled')
    await expect(registry.setMcpEnabled('nope', true)).rejects.toThrow(/没有名为 nope/)
  }, 60_000)

  it('命令不存在时状态为 error 并记录原因，不影响其他组件', async () => {
    await mcpConfig({ broken: { enabled: true, command: join(dir, 'no-such-binary'), roles: ['compiler'] }, echo: echo(false) })
    await registry.load()
    expect(registry.mcp.get('broken')).toMatchObject({ status: 'error' })
    expect(registry.mcp.get('broken')?.error).toBeTruthy()
    expect(registry.mcp.get('echo')?.status).toBe('disabled')
  })
})

describe('草稿', () => {
  beforeEach(async () => {
    await skill('exists', 'description: 已有')
    await registry.load()
  })

  it('校验名称：非 kebab-case、与已有组件重名、重复草稿都拒绝', async () => {
    const draft = { kind: 'skill' as const, description: 'd', roles: [], content: 'x' }
    await expect(registry.writeDraft({ ...draft, name: 'Bad Name' })).rejects.toThrow(/kebab-case/)
    await expect(registry.writeDraft({ ...draft, name: 'exists' })).rejects.toThrow(/已存在/)
    await registry.writeDraft({ ...draft, name: 'new-one' })
    await expect(registry.writeDraft({ ...draft, name: 'new-one' })).rejects.toThrow(/已存在/)
  })

  it('skill 草稿：列出预览 → 批准后移入 skills/ 并热加载', async () => {
    await registry.writeDraft({ kind: 'skill', name: 'pdf-check', description: '校验 PDF', roles: ['compiler'], content: '# PDF\n步骤' })
    const [draft] = await registry.listDrafts()
    expect(draft).toMatchObject({ name: 'pdf-check', kind: 'skill', description: '校验 PDF' })
    expect(draft!.preview).toContain('name: pdf-check')
    await registry.approveDraft('pdf-check')
    expect(registry.skills.get('pdf-check')?.roles).toEqual(['compiler'])
    expect(await registry.loadSkillBody('pdf-check')).toBe('# PDF\n步骤')
    expect(await registry.listDrafts()).toEqual([])
    expect(existsSync(join(dir, 'skills', 'pdf-check', 'draft.json'))).toBe(false)
  })

  it('mcp 草稿：批准后移入 mcp/ 并以停用状态登记', async () => {
    await registry.writeDraft({ kind: 'mcp', name: 'file-check', description: '校验文件', roles: ['orchestrator'], content: 'export {}\n' })
    await registry.approveDraft('file-check')
    expect(existsSync(join(dir, 'mcp', 'file-check', 'server.ts'))).toBe(true)
    const config = await readConfig()
    expect(config.servers['file-check']).toMatchObject({ enabled: false, args: ['tsx', 'components/mcp/file-check/server.ts'], roles: ['orchestrator'] })
    expect(registry.mcp.get('file-check')?.status).toBe('disabled')
  })

  it('拒绝草稿会删除目录；非法名称拒绝', async () => {
    await registry.writeDraft({ kind: 'skill', name: 'tmp-skill', description: 'd', roles: [], content: 'x' })
    await registry.rejectDraft('tmp-skill')
    expect(await registry.listDrafts()).toEqual([])
    await expect(registry.rejectDraft('../skills')).rejects.toThrow(/非法/)
  })
})
