/** Agent Loop：白名单、终结工具、错误回传、并行调用、轮数上限、拒答 */
import { describe, expect, it, vi } from 'vitest'
import { runAgent, type AgentTool, type ChatRequest, type ChatResponse, type LlmAdapter } from '../src'

function scripted(responses: ChatResponse[]): LlmAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    provider: 'fake', model: 'script', requests,
    async chat(request) {
      requests.push(structuredClone(request))
      return responses[Math.min(requests.length - 1, responses.length - 1)]!
    },
  }
}
const call = (id: string, name: string, input: Record<string, unknown> = {}): ChatResponse => ({ text: '', stop: 'tool_use', toolCalls: [{ id, name, input }] })
const tool = (name: string, run: AgentTool['run'], terminal = false): AgentTool => ({ terminal, spec: { name, description: name, inputSchema: { type: 'object' } }, run })

describe('runAgent', () => {
  it('白名单外的工具不执行；终结工具失败可重试，成功即结束', async () => {
    const llm = scripted([
      { text: '', stop: 'tool_use', toolCalls: [{ id: '1', name: 'rm_rf', input: {} }, { id: '2', name: 'submit', input: { ok: false } }] },
      call('3', 'submit', { ok: true }),
      { text: 'unreachable', stop: 'end', toolCalls: [] },
    ])
    const submit = tool('submit', async (input) => {
      if (input['ok'] !== true) throw new Error('not ok')
      return 'ok'
    }, true)
    const result = await runAgent({ role: 'compiler', system: 'sys', userText: 'go', llm, tools: [submit] })
    const events = result.transcript.filter((event) => event.type === 'tool')
    expect(events.map((event) => [event.name, event.isError, event.output])).toEqual([['rm_rf', true, '工具 rm_rf 不在当前角色的白名单内'], ['submit', true, 'not ok'], ['submit', false, 'ok']])
    expect(result.terminal).toEqual({ name: 'submit', input: { ok: true } })
    expect(llm.requests).toHaveLength(2)
    expect(result.model).toBe('fake/script')
  })

  it('同一轮的多个工具结果放在同一条 tool 消息里回传', async () => {
    const llm = scripted([
      { text: '先查两个', stop: 'tool_use', toolCalls: [{ id: 'a', name: 'echo', input: { v: 1 } }, { id: 'b', name: 'echo', input: { v: 2 } }] },
      { text: '完成', stop: 'end', toolCalls: [] },
    ])
    const result = await runAgent({ role: 'r', system: 's', userText: 'u', llm, tools: [tool('echo', async (input) => `v=${String(input['v'])}`)] })
    const second = llm.requests[1]!.messages
    expect(second.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(second[2]).toEqual({ role: 'tool', results: [{ toolCallId: 'a', content: 'v=1', isError: false }, { toolCallId: 'b', content: 'v=2', isError: false }] })
    expect(result.text).toBe('完成')
    expect(result.terminal).toBeUndefined()
  })

  it('请求携带系统提示、工具清单、角色和首条用户消息的图片', async () => {
    const llm = scripted([{ text: 'ok', stop: 'end', toolCalls: [] }])
    await runAgent({ role: 'triager', system: 'SYS', userText: 'U', images: [{ mediaType: 'image/png', base64: 'AAA' }], llm, tools: [tool('t', async () => '')] })
    const request = llm.requests[0]!
    expect(request).toMatchObject({ role: 'triager', system: 'SYS', tools: [{ name: 't' }] })
    expect(request.messages[0]).toEqual({ role: 'user', content: 'U', images: [{ mediaType: 'image/png', base64: 'AAA' }] })
  })

  it('达到最大轮数后停止', async () => {
    const llm = scripted([call('x', 'noop')])
    const result = await runAgent({ role: 'r', system: '', userText: '', llm, maxTurns: 3, tools: [tool('noop', async () => '')] })
    expect(llm.requests).toHaveLength(3)
    expect(result.terminal).toBeUndefined()
  })

  it('逐轮透出用量并累计；没有用量的轮次按 0 计，但仍算一次调用', async () => {
    const llm = scripted([{ ...call('1', 'noop'), usage: { input: 10, output: 3 } }, { text: 'done', stop: 'end', toolCalls: [] }])
    const result = await runAgent({ role: 'r', system: '', userText: '', llm, tools: [tool('noop', async () => '')] })
    const turns = result.transcript.filter((event) => event.type === 'llm')
    expect(turns.map((event) => event.usage)).toEqual([{ input: 10, output: 3 }, undefined])
    expect(result.usage).toEqual({ input: 10, output: 3, calls: 2 })
  })

  it('模型拒答时记录错误并停止', async () => {
    const llm = scripted([{ text: '', stop: 'refusal', toolCalls: [] }])
    const result = await runAgent({ role: 'r', system: '', userText: '', llm, tools: [] })
    expect(result.transcript.at(-1)).toEqual({ type: 'error', message: '模型拒绝了该请求' })
  })

  it('工具抛出非 Error 值也能回传；onEvent 与 transcript 一致', async () => {
    const onEvent = vi.fn<(event: unknown) => void>()
    const llm = scripted([call('1', 'weird'), { text: 'bye', stop: 'end', toolCalls: [] }])
    const weird = tool('weird', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 故意抛出非 Error 值，验证 Loop 的兜底
      throw 'raw string'
    })
    const result = await runAgent({ role: 'r', system: '', userText: '', llm, onEvent, tools: [weird] })
    expect(result.transcript.find((event) => event.type === 'tool')).toMatchObject({ isError: true, output: 'raw string' })
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(result.transcript)
  })
})
