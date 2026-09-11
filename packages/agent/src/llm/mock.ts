/**
 * mock 适配器：不联网，按角色用规则引擎产出工具调用。
 * 它走和真实模型完全相同的 Agent Loop（先 load_skill，再调用终结工具），
 * 所以离线也能验证组件注册、工具白名单、校验失败重试等链路。
 */
import { heuristicCompile, heuristicRepair, heuristicTriage } from '../heuristics'
import { ROLES, type RoleName } from '../roles'
import type { ChatMessage, ChatRequest, ChatResponse, LlmAdapter, ToolCall } from './types'

let seq = 0
const call = (name: string, input: Record<string, unknown>): ChatResponse => ({
  text: '',
  toolCalls: [{ id: `mock_${++seq}`, name, input }],
  stop: 'tool_use',
})
const say = (text: string): ChatResponse => ({ text, toolCalls: [], stop: 'end' })

export function extractPayload(messages: readonly ChatMessage[]): Record<string, unknown> {
  const first = messages.find((message) => message.role === 'user')
  const match = first?.role === 'user' ? /```json\n([\s\S]*?)\n```/.exec(first.content) : null
  return match === null ? {} : JSON.parse(match[1]!) as Record<string, unknown>
}

function previousCalls(messages: readonly ChatMessage[]): { call: ToolCall; isError: boolean }[] {
  const results = new Map<string, boolean>()
  for (const message of messages) {
    if (message.role === 'tool') for (const result of message.results) results.set(result.toolCallId, result.isError === true)
  }
  return messages.flatMap((message) => (message.role === 'assistant' ? message.toolCalls ?? [] : []))
    .map((item) => ({ call: item, isError: results.get(item.id) ?? false }))
}

export class MockAdapter implements LlmAdapter {
  readonly provider = 'mock'
  readonly model = 'rules'

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const role = request.role as RoleName
    const def = ROLES[role]
    const payload = extractPayload(request.messages)
    const calls = previousCalls(request.messages)
    const last = request.messages.at(-1)
    if (last?.role === 'tool' && last.results.some((result) => result.isError)) {
      return say(`规则引擎无法完成：${last.results.find((result) => result.isError)!.content}`)
    }
    if (def.terminalTool !== undefined && calls.some((item) => item.call.name === def.terminalTool && !item.isError)) {
      return say('完成')
    }
    const offered = new Set(request.tools.map((tool) => tool.name))
    const pendingSkill = def.requiredSkills.find((name) => !calls.some((item) => item.call.name === 'load_skill' && item.call.input['name'] === name))
    if (pendingSkill !== undefined && offered.has('load_skill')) return call('load_skill', { name: pendingSkill })

    switch (role) {
      case 'compiler': {
        const compiled = heuristicCompile(payload['case'] as { steps: string[]; expected: string[] })
        if (compiled.steps.length === 0) return say(compiled.rationale)
        return call('propose_plan', { steps: compiled.steps, rationale: compiled.rationale })
      }
      case 'triager':
        return call('record_verdict', { ...heuristicTriage(payload as never) })
      case 'repairer': {
        try {
          return call('propose_plan', { ...heuristicRepair(payload as never) })
        } catch (error) {
          return say(error instanceof Error ? error.message : String(error))
        }
      }
      case 'reporter': {
        const summary = payload['summary'] as Record<string, number> | undefined
        return say(summary === undefined ? '（无数据）' : `共 ${summary['cases']} 条用例：通过 ${summary['passed']}，未通过 ${summary['failed']}，已确认缺陷 ${summary['defects']}，待处理门禁 ${summary['open']}。`)
      }
      case 'orchestrator': {
        const text = String(payload['request'] ?? '')
        if (/组件|能力|skill|mcp/i.test(text) && !calls.some((item) => item.call.name === 'draft_component')) {
          return call('draft_component', {
            kind: 'skill',
            name: `draft-${Date.now().toString(36)}`,
            description: text.slice(0, 80),
            roles: ['compiler'],
            content: `# ${text}\n\n（mock 模式生成的占位草稿。配置真实 LLM 后，orchestrator 会按 component-forge 写出完整内容。）\n`,
          })
        }
        if (!calls.some((item) => item.call.name === 'list_components')) return call('list_components', {})
        const listed = request.messages.flatMap((message) => (message.role === 'tool' ? message.results.map((result) => result.content) : [])).join('\n')
        return say(`（mock）当前可用组件：\n${listed}`)
      }
    }
  }
}
