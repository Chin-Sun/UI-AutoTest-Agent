/** 与供应商无关的对话格式，适配器负责与各家 SDK 互转 */

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema（type: object） */
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
}

export type ChatMessage
  = | { role: 'user', content: string, images?: ImageInput[] }
    | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      /** 供应商原始内容（例如 Anthropic 的 thinking 块），同供应商续聊时原样回传 */
      raw?: unknown
      provider?: string
    }
    | { role: 'tool', results: { toolCallId: string, content: string, isError?: boolean }[] }

export interface ChatRequest {
  /** 当前角色，mock 适配器据此选择规则 */
  role: string
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
}

export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal'
  raw?: unknown
  usage?: { input: number, output: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  chat(request: ChatRequest): Promise<ChatResponse>
}
