/**
 * Agent Loop：典型的 tool-use 循环。
 * - 工具白名单外的调用直接返回错误（不执行）
 * - 工具输入校验失败以 is_error 回传，让模型自行修正
 * - 终结工具调用成功即结束，结果交给调用方落盘
 */
import type { ChatMessage, ImageInput, LlmAdapter, ToolSpec } from './llm/types'

export interface AgentTool {
  spec: ToolSpec
  /** 返回给模型的文本；抛错表示调用失败（is_error） */
  run(input: Record<string, unknown>): Promise<string>
  terminal?: boolean
}

export interface TokenCount {
  input: number
  output: number
}

export type AgentEvent
  = | { type: 'llm', text: string, toolCalls: { name: string, input: unknown }[], model: string, usage?: TokenCount }
    | { type: 'tool', name: string, input: unknown, output: string, isError: boolean }
    | { type: 'error', message: string }

export interface AgentRunOptions {
  role: string
  system: string
  userText: string
  images?: ImageInput[]
  tools: AgentTool[]
  llm: LlmAdapter
  maxTurns?: number
  onEvent?(event: AgentEvent): void
}

export interface AgentRunResult {
  text: string
  terminal?: { name: string, input: Record<string, unknown> }
  transcript: AgentEvent[]
  model: string
  /** 本次运行累计：适配器未返回用量的轮次按 0 计，calls 仍 +1 */
  usage: TokenCount & { calls: number }
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const transcript: AgentEvent[] = []
  const emit = (event: AgentEvent) => {
    transcript.push(event)
    options.onEvent?.(event)
  }
  const tools = new Map(options.tools.map((tool) => [tool.spec.name, tool]))
  const messages: ChatMessage[] = [{ role: 'user', content: options.userText, ...(options.images === undefined ? {} : { images: options.images }) }]
  const model = `${options.llm.provider}/${options.llm.model}`
  let text = ''
  let terminal: AgentRunResult['terminal']
  const usage = { input: 0, output: 0, calls: 0 }

  for (let turn = 0; turn < (options.maxTurns ?? 10); turn += 1) {
    const response = await options.llm.chat({ role: options.role, system: options.system, messages, tools: options.tools.map((tool) => tool.spec) })
    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls, raw: response.raw, provider: options.llm.provider })
    usage.calls += 1
    usage.input += response.usage?.input ?? 0
    usage.output += response.usage?.output ?? 0
    emit({
      type: 'llm',
      text: response.text,
      toolCalls: response.toolCalls.map((item) => ({ name: item.name, input: item.input })),
      model,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    })
    if (response.text !== '') text = response.text
    if (response.stop === 'refusal') {
      emit({ type: 'error', message: '模型拒绝了该请求' })
      break
    }
    if (response.toolCalls.length === 0) break

    const results: { toolCallId: string, content: string, isError: boolean }[] = []
    for (const toolCall of response.toolCalls) {
      const tool = tools.get(toolCall.name)
      let output: string
      let isError = false
      if (tool === undefined) {
        output = `工具 ${toolCall.name} 不在当前角色的白名单内`
        isError = true
      } else {
        try {
          output = await tool.run(toolCall.input)
          if (tool.terminal === true) terminal = { name: toolCall.name, input: toolCall.input }
        } catch (error) {
          output = error instanceof Error ? error.message : String(error)
          isError = true
        }
      }
      emit({ type: 'tool', name: toolCall.name, input: toolCall.input, output, isError })
      results.push({ toolCallId: toolCall.id, content: output, isError })
    }
    // 并行工具调用的结果必须在同一条消息里回传
    messages.push({ role: 'tool', results })
    if (terminal !== undefined) break
  }
  return { text, ...(terminal === undefined ? {} : { terminal }), transcript, model, usage }
}
