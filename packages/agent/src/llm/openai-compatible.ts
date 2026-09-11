/** OpenAI 兼容协议（DeepSeek、通义千问、本地 vLLM/Ollama 等） */
import OpenAI from 'openai'
import type { ChatRequest, ChatResponse, LlmAdapter } from './types'

export interface OpenAICompatibleConfig {
  model: string
  baseURL?: string
  apiKey?: string
  /** 模型是否支持图片输入；不支持时截图证据只以文字描述传入 */
  vision?: boolean
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    return { __invalid_json__: raw }
  }
}

export class OpenAICompatibleAdapter implements LlmAdapter {
  readonly provider = 'openai-compatible'
  readonly model: string
  private readonly client: OpenAI

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.model = config.model
    this.client = new OpenAI({
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      apiKey: config.apiKey ?? 'missing-api-key',
    })
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: request.system }]
    for (const message of request.messages) {
      if (message.role === 'user') {
        if (this.config.vision === true && (message.images?.length ?? 0) > 0) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: message.content },
              ...message.images!.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
            ],
          })
        } else {
          messages.push({ role: 'user', content: message.content })
        }
      } else if (message.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: message.content === '' ? null : message.content,
          ...(message.toolCalls === undefined || message.toolCalls.length === 0 ? {} : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }),
        })
      } else {
        for (const result of message.results) messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
      }
    }
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages,
      ...(request.tools.length === 0 ? {} : {
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
      }),
    })
    const choice = response.choices[0]
    const toolCalls = (choice?.message.tool_calls ?? []).flatMap((call) => (
      call.type === 'function' ? [{ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }] : []
    ))
    const reason = choice?.finish_reason
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      stop: reason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use' : reason === 'length' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'end',
      ...(response.usage === undefined ? {} : { usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens } }),
    }
  }
}
