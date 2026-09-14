import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ChatRequest, ChatResponse, LlmAdapter } from './types'

export interface AnthropicConfig {
  model: string
  apiKey?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 服务端拒答回退：fallbacks: "default" */
  refusalFallback?: boolean
  maxTokens?: number
  /** 测试接缝：替换 SDK 的 HTTP 实现 */
  fetch?: typeof globalThis.fetch
}

type BlockParam = Anthropic.Beta.BetaContentBlockParam

export function toAnthropicMessages(messages: readonly ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((message): Anthropic.Beta.BetaMessageParam => {
    if (message.role === 'user') {
      const blocks: BlockParam[] = (message.images ?? []).map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      }))
      blocks.push({ type: 'text', text: message.content })
      return { role: 'user', content: blocks }
    }
    if (message.role === 'assistant') {
      // 同供应商续聊时原样回传（含 thinking 块），不能改写
      if (message.provider === 'anthropic' && Array.isArray(message.raw)) {
        return { role: 'assistant', content: message.raw as BlockParam[] }
      }
      const blocks: BlockParam[] = []
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      return { role: 'assistant', content: blocks }
    }
    return {
      role: 'user',
      content: message.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        is_error: result.isError ?? false,
      })),
    }
  })
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic'
  readonly model: string
  private readonly client: Anthropic

  constructor(private readonly config: AnthropicConfig) {
    this.model = config.model
    // 未显式给 key 时由 SDK 解析 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` 凭据
    this.client = new Anthropic({
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    })
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.beta.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 16_000,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }),
      ...(this.config.effort === undefined ? {} : { output_config: { effort: this.config.effort } }),
      ...(this.config.refusalFallback === true ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    })
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const toolCalls = response.content.flatMap((block) => (
      block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> }] : []
    ))
    const stop = response.stop_reason === 'tool_use'
      ? 'tool_use'
      : response.stop_reason === 'refusal'
        ? 'refusal'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end'
    return {
      text,
      toolCalls,
      stop,
      raw: response.content,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    }
  }
}
