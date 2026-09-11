/**
 * 组件注册表：平台能力 = 已注册组件的叠加。
 * - Skill：components/skills/<name>/SKILL.md，frontmatter 给机器，正文按需加载（渐进披露）
 * - MCP：components/mcp.json 声明的 stdio server，工具以 mcp__<server>__<tool> 暴露给对应角色
 * - 草稿：components/_drafts/<name>/，只有人批准后才进入正式目录并热加载
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import matter from 'gray-matter'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentTool } from './loop'
import type { ToolSpec } from './llm/types'

export interface SkillInfo {
  name: string
  description: string
  roles: string[]
  path: string
}

export interface McpServerConfig {
  description?: string
  enabled: boolean
  command: string
  args?: string[]
  env?: Record<string, string>
  roles?: string[]
}

export interface McpServerState {
  name: string
  config: McpServerConfig
  status: 'disabled' | 'connecting' | 'ready' | 'error'
  error?: string
  tools: ToolSpec[]
  client?: Client
}

export interface DraftInfo {
  name: string
  kind: 'skill' | 'mcp'
  description: string
  roles: string[]
  createdAt: number
}

export interface DraftInput {
  kind: 'skill' | 'mcp'
  name: string
  description: string
  roles: string[]
  content: string
}

const NAME = /^[a-z0-9][a-z0-9-]{1,48}$/

export class ComponentRegistry {
  readonly skills = new Map<string, SkillInfo>()
  readonly mcp = new Map<string, McpServerState>()

  /**
   * @param dir components 目录
   * @param cwd MCP 子进程的工作目录（仓库根）
   */
  constructor(readonly dir: string, private readonly cwd: string = resolve(dir, '..')) {}

  async load(): Promise<void> {
    await this.loadSkills()
    const config = await this.readMcpConfig()
    await Promise.all(Object.entries(config.servers).map(([name, server]) => this.connect(name, server)))
  }

  async loadSkills(): Promise<void> {
    this.skills.clear()
    const skillsDir = join(this.dir, 'skills')
    if (!existsSync(skillsDir)) return
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(skillsDir, entry.name, 'SKILL.md')
      if (!existsSync(path)) continue
      const { data } = matter(await readFile(path, 'utf8'))
      const name = typeof data['name'] === 'string' ? data['name'] : entry.name
      this.skills.set(name, {
        name,
        description: String(data['description'] ?? ''),
        roles: Array.isArray(data['roles']) ? data['roles'].map(String) : [],
        path,
      })
    }
  }

  async loadSkillBody(name: string): Promise<string> {
    const skill = this.skills.get(name)
    if (skill === undefined) throw new Error(`没有名为 ${name} 的 skill，可用：${[...this.skills.keys()].join(', ')}`)
    return matter(await readFile(skill.path, 'utf8')).content.trim()
  }

  // ---------- MCP ----------

  private get mcpConfigPath(): string {
    return join(this.dir, 'mcp.json')
  }

  async readMcpConfig(): Promise<{ servers: Record<string, McpServerConfig> }> {
    if (!existsSync(this.mcpConfigPath)) return { servers: {} }
    return JSON.parse(await readFile(this.mcpConfigPath, 'utf8')) as { servers: Record<string, McpServerConfig> }
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    const state: McpServerState = { name, config, status: config.enabled ? 'connecting' : 'disabled', tools: [] }
    this.mcp.set(name, state)
    if (!config.enabled) return
    try {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries({ ...process.env, ...config.env })) if (value !== undefined) env[key] = value
      const transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env, cwd: this.cwd, stderr: 'ignore' })
      const client = new Client({ name: 'ui-test-agent', version: '0.1.0' })
      await withTimeout(client.connect(transport), 60_000, `连接 MCP ${name} 超时`)
      const listed = await client.listTools()
      state.client = client
      state.tools = listed.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown> }))
      state.status = 'ready'
    } catch (error) {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    }
  }

  async setMcpEnabled(name: string, enabled: boolean): Promise<McpServerState> {
    const config = await this.readMcpConfig()
    const server = config.servers[name]
    if (server === undefined) throw new Error(`没有名为 ${name} 的 MCP 组件`)
    server.enabled = enabled
    await writeFile(this.mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`)
    await this.mcp.get(name)?.client?.close().catch(() => undefined)
    await this.connect(name, server)
    return this.mcp.get(name)!
  }

  async callMcp(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const state = this.mcp.get(server)
    if (state?.client === undefined || state.status !== 'ready') throw new Error(`MCP ${server} 未就绪（${state?.status ?? '未注册'}）`)
    const result = await state.client.callTool({ name: tool, arguments: args })
    const content = Array.isArray(result.content) ? result.content : []
    const text = content.map((item: { type: string; text?: string }) => (item.type === 'text' ? item.text ?? '' : `[${item.type}]`)).join('\n')
    if (result.isError === true) throw new Error(text || `${server}.${tool} 执行失败`)
    return text
  }

  isMcpReady(server: string): boolean {
    return this.mcp.get(server)?.status === 'ready'
  }

  /** 按角色暴露 MCP 工具（server.roles 包含该角色） */
  mcpToolsFor(role: string): AgentTool[] {
    const tools: AgentTool[] = []
    for (const state of this.mcp.values()) {
      if (state.status !== 'ready' || !(state.config.roles ?? []).includes(role)) continue
      for (const tool of state.tools) {
        tools.push({
          spec: { ...tool, name: `mcp__${state.name}__${tool.name}`.slice(0, 64), description: `[${state.name}] ${tool.description}` },
          run: (input) => this.callMcp(state.name, tool.name, input),
        })
      }
    }
    return tools
  }

  /** 注入系统提示的组件目录：只放描述，正文由 load_skill 按需加载 */
  catalogFor(role: string): string {
    const skills = [...this.skills.values()].filter((skill) => skill.roles.length === 0 || skill.roles.includes(role))
    const servers = [...this.mcp.values()].filter((state) => state.status === 'ready' && (state.config.roles ?? []).includes(role))
    return [
      '可用 Skill（用 load_skill 读取正文）：',
      ...(skills.length === 0 ? ['- (无)'] : skills.map((skill) => `- ${skill.name}：${skill.description}`)),
      '可用 MCP：',
      ...(servers.length === 0 ? ['- (无)'] : servers.map((state) => `- ${state.name}：${state.config.description ?? ''}（${state.tools.length} 个工具）`)),
    ].join('\n')
  }

  describe(): { skills: SkillInfo[]; mcp: Omit<McpServerState, 'client'>[] } {
    return {
      skills: [...this.skills.values()],
      mcp: [...this.mcp.values()].map(({ client: _client, ...rest }) => rest),
    }
  }

  // ---------- 草稿 ----------

  private get draftsDir(): string {
    return join(this.dir, '_drafts')
  }

  async writeDraft(input: DraftInput): Promise<DraftInfo> {
    if (!NAME.test(input.name)) throw new Error('组件名必须是 kebab-case（小写字母、数字、连字符，2-49 位）')
    if (this.skills.has(input.name) || this.mcp.has(input.name)) throw new Error(`组件 ${input.name} 已存在，请改进它而不是新建`)
    const dir = join(this.draftsDir, input.name)
    await mkdir(dir, { recursive: true })
    const info: DraftInfo = { name: input.name, kind: input.kind, description: input.description, roles: input.roles, createdAt: Date.now() }
    await writeFile(join(dir, 'draft.json'), `${JSON.stringify(info, null, 2)}\n`)
    if (input.kind === 'skill') {
      await writeFile(join(dir, 'SKILL.md'), matter.stringify(`${input.content.trim()}\n`, { name: input.name, description: input.description, roles: input.roles }))
    } else {
      await writeFile(join(dir, 'server.ts'), input.content)
    }
    return info
  }

  async listDrafts(): Promise<(DraftInfo & { preview: string })[]> {
    if (!existsSync(this.draftsDir)) return []
    const drafts: (DraftInfo & { preview: string })[] = []
    for (const entry of await readdir(this.draftsDir, { withFileTypes: true })) {
      const meta = join(this.draftsDir, entry.name, 'draft.json')
      if (!entry.isDirectory() || !existsSync(meta)) continue
      const info = JSON.parse(await readFile(meta, 'utf8')) as DraftInfo
      const body = join(this.draftsDir, entry.name, info.kind === 'skill' ? 'SKILL.md' : 'server.ts')
      drafts.push({ ...info, preview: existsSync(body) ? (await readFile(body, 'utf8')).slice(0, 4_000) : '' })
    }
    return drafts
  }

  /** 人批准：skill 移入 skills/ 并热加载；mcp 移入 mcp/ 并以 disabled 登记，需人再手动启用 */
  async approveDraft(name: string): Promise<void> {
    const dir = join(this.draftsDir, name)
    const info = JSON.parse(await readFile(join(dir, 'draft.json'), 'utf8')) as DraftInfo
    await rm(join(dir, 'draft.json'))
    await mkdir(join(this.dir, info.kind === 'skill' ? 'skills' : 'mcp'), { recursive: true })
    if (info.kind === 'skill') {
      await rename(dir, join(this.dir, 'skills', name))
      await this.loadSkills()
      return
    }
    await rename(dir, join(this.dir, 'mcp', name))
    const config = await this.readMcpConfig()
    config.servers[name] = { description: info.description, enabled: false, command: 'npx', args: ['tsx', `components/mcp/${name}/server.ts`], roles: info.roles }
    await writeFile(this.mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`)
    await this.connect(name, config.servers[name]!)
  }

  async rejectDraft(name: string): Promise<void> {
    if (!NAME.test(name)) throw new Error('非法组件名')
    await rm(join(this.draftsDir, name), { recursive: true, force: true })
  }

  async close(): Promise<void> {
    await Promise.all([...this.mcp.values()].map((state) => state.client?.close().catch(() => undefined)))
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}
