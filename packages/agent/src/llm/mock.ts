/**
 * mock 适配器：不联网，按角色用规则引擎产出工具调用。
 * 它走和真实模型完全相同的 Agent Loop（先 load_skill，再调用终结工具），
 * 所以离线也能验证组件注册、工具白名单、校验失败重试等链路。
 */
import { declareMissingBindings, isAssertion, type DataBinding, type Step } from '@uta/core'
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

function previousCalls(messages: readonly ChatMessage[]): { call: ToolCall, isError: boolean }[] {
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
        const compiled = heuristicCompile(payload['case'] as { steps: string[], expected: string[] })
        if (compiled.unparsed.length > 0 && compiled.steps.length === 0) return say(compiled.rationale)
        // 规则引擎不会推断流程与数据来源：断言归入验证阶段、其余归入操作阶段；引用的数据交给人补
        const steps = compiled.steps.map((step): Step => ({ ...step, stage: isAssertion(step.action) ? 'verify' : 'action' }))
        const dataKeys = (payload['case'] as { dataKeys?: string[] }).dataKeys ?? []
        return call('propose_plan', { steps, data: declareMissingBindings(steps, [], dataKeys), rationale: compiled.rationale })
      }
      case 'triager':
        return call('record_verdict', { ...heuristicTriage(payload as never) })
      case 'repairer': {
        try {
          const repaired = heuristicRepair(payload as never)
          const dataKeys = (payload['case'] as { dataKeys?: string[] } | undefined)?.dataKeys ?? []
          const data = declareMissingBindings(repaired.steps, (payload['data'] as DataBinding[] | undefined) ?? [], dataKeys)
          return call('propose_plan', { ...repaired, data })
        } catch (error) {
          return say(error instanceof Error ? error.message : String(error))
        }
      }
      case 'reporter': {
        const summary = payload['summary'] as Record<string, number> | undefined
        return say(summary === undefined ? '（无数据）' : `共 ${summary['cases']} 条用例：通过 ${summary['passed']}，未通过 ${summary['failed']}，已确认缺陷 ${summary['defects']}，待处理门禁 ${summary['open']}。`)
      }
      case 'orchestrator': {
        const text = typeof payload['request'] === 'string' ? payload['request'] : ''
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
