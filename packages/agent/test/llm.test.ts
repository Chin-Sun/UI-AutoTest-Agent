/** LLM 适配层：消息互转、请求构造、响应解析、配置与路由（不联网，用假 fetch） */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AnthropicAdapter, createAdapter, createLlmRouter, loadLlmConfig, MockAdapter, OpenAICompatibleAdapter,
  type ChatMessage, type ChatRequest,
} from '../src'
import { toAnthropicMessages } from '../src/llm/anthropic'
import { parseArguments, toOpenAIMessages } from '../src/llm/openai-compatible'

interface Captured { url: string, headers: Record<string, string>, body: Record<string, unknown> }

function fakeFetch(response: unknown, captured: Captured[]): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    const url = input instanceof Request ? input.url : input.toString()
    captured.push({ url, headers, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const history: ChatMessage[] = [
  { role: 'user', content: '看图', images: [{ mediaType: 'image/png', base64: 'AAA' }] },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'load_skill', input: { name: 'x' } }] },
  { role: 'tool', results: [{ toolCallId: 't1', content: '正文' }, { toolCallId: 't2', content: '错', isError: true }] },
]
const request: ChatRequest = { role: 'compiler', system: 'SYS', messages: history, tools: [{ name: 'load_skill', description: '读', inputSchema: { type: 'object', properties: {} } }] }

describe('Anthropic 适配器', () => {
  it('消息互转：图片在文字前、空文本省略、工具结果带 is_error', () => {
    expect(toAnthropicMessages(history)).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: '看图' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'load_skill', input: { name: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '正文', is_error: false }, { type: 'tool_result', tool_use_id: 't2', content: '错', is_error: true }] },
    ])
  })

  it('同供应商续聊时原样回传原始内容块（含 thinking）', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hi' }]
    expect(toAnthropicMessages([{ role: 'assistant', content: 'hi', raw, provider: 'anthropic' }])[0]).toEqual({ role: 'assistant', content: raw })
    expect(toAnthropicMessages([{ role: 'assistant', content: 'hi', raw, provider: 'mock' }])[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
  })

  it('请求带模型、工具 schema、effort 与服务端拒答回退；响应解析文本、工具调用与用量', async () => {
    const captured: Captured[] = []
    const adapter = new AnthropicAdapter({
      model: 'claude-opus-5', apiKey: 'test-key', effort: 'high', refusalFallback: true,
      fetch: fakeFetch({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', stop_sequence: null,
        content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'tu_1', name: 'load_skill', input: { name: 'case-to-steps' } }],
        usage: { input_tokens: 11, output_tokens: 7 },
      }, captured),
    })
    const response = await adapter.chat(request)
    expect(response).toMatchObject({ text: '好的', stop: 'tool_use', toolCalls: [{ id: 'tu_1', name: 'load_skill', input: { name: 'case-to-steps' } }], usage: { input: 11, output: 7 } })
    const sent = captured[0]!
    expect(sent.url).toContain('/v1/messages')
    expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(sent.body).toMatchObject({ model: 'claude-opus-5', system: 'SYS', fallbacks: 'default', output_config: { effort: 'high' }, tools: [{ name: 'load_skill', input_schema: { type: 'object' } }] })
    expect(sent.body['max_tokens']).toBe(16_000)
  })

  it.each([['refusal', 'refusal'], ['max_tokens', 'max_tokens'], ['end_turn', 'end']])('stop_reason=%s → %s；无工具时不发送 tools，未开启回退时不发送 fallbacks', async (reason, stop) => {
    const captured: Captured[] = []
    const adapter = new AnthropicAdapter({
      model: 'm', apiKey: 'k',
      fetch: fakeFetch({ id: 'x', type: 'message', role: 'assistant', model: 'm', stop_reason: reason, stop_sequence: null, content: [], usage: { input_tokens: 1, output_tokens: 1 } }, captured),
    })
    expect((await adapter.chat({ ...request, tools: [] })).stop).toBe(stop)
    expect(captured[0]!.body).not.toHaveProperty('tools')
    expect(captured[0]!.body).not.toHaveProperty('fallbacks')
  })
})

describe('OpenAI 兼容适配器', () => {
  it('消息互转：system 置顶、tool 结果拆成多条、vision 开关控制图片', () => {
    const plain = toOpenAIMessages('SYS', history)
    expect(plain).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '看图' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"x"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '正文' },
      { role: 'tool', tool_call_id: 't2', content: '错' },
    ])
    expect(toOpenAIMessages('SYS', history, true)[1]).toEqual({ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] })
  })

  it('工具参数：非法 JSON 保留原文，数组视为空对象', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseArguments('{oops')).toEqual({ __invalid_json__: '{oops' })
    expect(parseArguments('[1]')).toEqual({})
  })

  it('请求使用 function 工具；响应解析 tool_calls 与用量', async () => {
    const captured: Captured[] = []
    const adapter = new OpenAICompatibleAdapter({
      model: 'deepseek-chat', baseURL: 'https://api.example.test/v1', apiKey: 'k',
      fetch: fakeFetch({
        id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"a"}' } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }, captured),
    })
    const response = await adapter.chat(request)
    expect(response).toEqual({ text: '', stop: 'tool_use', toolCalls: [{ id: 'call_1', name: 'load_skill', input: { name: 'a' } }], usage: { input: 5, output: 3 } })
    expect(captured[0]!.url).toBe('https://api.example.test/v1/chat/completions')
    expect(captured[0]!.headers['authorization']).toBe('Bearer k')
    expect(captured[0]!.body).toMatchObject({ model: 'deepseek-chat', tools: [{ type: 'function', function: { name: 'load_skill', parameters: { type: 'object' } } }] })
  })

  it.each([['length', 'max_tokens'], ['content_filter', 'refusal'], ['stop', 'end']])('finish_reason=%s → %s', async (reason, stop) => {
    const adapter = new OpenAICompatibleAdapter({
      model: 'm', apiKey: 'k',
      fetch: fakeFetch({ id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: '文本' } }] }, []),
    })
    expect(await adapter.chat({ ...request, tools: [] })).toMatchObject({ text: '文本', stop })
  })
})

describe('配置与路由', () => {
  let dir: string | undefined
  const saved = process.env['LLM_PROVIDER']
  afterEach(async () => {
    if (saved === undefined) delete process.env['LLM_PROVIDER']
    else process.env['LLM_PROVIDER'] = saved
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function configFile(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'uta-llm-'))
    await writeFile(join(dir, 'llm.yaml'), yaml)
    return join(dir, 'llm.yaml')
  }

  it('读取 yaml；LLM_PROVIDER 覆盖 default；总是补上 mock', async () => {
    const file = await configFile('default: claude\nproviders:\n  claude: { type: anthropic, model: claude-opus-5 }\n')
    delete process.env['LLM_PROVIDER']
    expect(loadLlmConfig(file).default).toBe('claude')
    process.env['LLM_PROVIDER'] = 'mock'
    const config = loadLlmConfig(file)
    expect(config.default).toBe('mock')
    expect(config.providers['mock']).toEqual({ type: 'mock' })
  })

  it('仓库自带的 config/llm.yaml 可以解析', () => {
    delete process.env['LLM_PROVIDER']
    const config = loadLlmConfig(join(import.meta.dirname, '../../../config/llm.yaml'))
    expect(Object.keys(config.providers)).toEqual(expect.arrayContaining(['mock', 'claude', 'deepseek']))
    expect(config.providers['claude']?.model).toBe('claude-opus-5')
  })

  it('createAdapter 按类型构造；openai-compatible 缺 model 报错；apiKeyEnv 读取环境变量', () => {
    expect(createAdapter({ type: 'mock' })).toBeInstanceOf(MockAdapter)
    expect(createAdapter({ type: 'anthropic', apiKeyEnv: 'UTA_TEST_NO_SUCH_KEY' }).model).toBe('claude-opus-5')
    expect(createAdapter({ type: 'openai-compatible', model: 'qwen-plus' }).provider).toBe('openai-compatible')
    expect(() => createAdapter({ type: 'openai-compatible' })).toThrow(/需要 model/)
  })

  it('按角色路由并缓存实例；未知 provider 报错；describe 输出全部角色', () => {
    const router = createLlmRouter({ default: 'mock', providers: { mock: { type: 'mock' }, ds: { type: 'openai-compatible', model: 'deepseek-chat' } }, roles: { triager: 'ds', repairer: 'ghost' } })
    expect(router.forRole('compiler')).toBe(router.forRole('orchestrator'))
    expect(router.forRole('triager').model).toBe('deepseek-chat')
    expect(() => router.forRole('repairer')).toThrow(/没有 provider「ghost」/)
    expect(router.describe()).toEqual({ orchestrator: 'mock', compiler: 'mock', triager: 'ds · deepseek-chat', repairer: 'ghost', reporter: 'mock' })
  })
})
