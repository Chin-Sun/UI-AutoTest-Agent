/** 前端 API 客户端与实时事件：fetch 封装、WebSocket 单连接广播、断线重连、去抖刷新 */
import { renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { api, fileUrl, subscribe, useReload } from '../src/api'

class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

beforeAll(() => { vi.stubGlobal('WebSocket', FakeSocket) })
afterAll(() => { vi.unstubAllGlobals() })

describe('api()', () => {
  it('GET 默认方法、无 body；返回 JSON', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await api('/api/x')).toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledWith('/api/x', { method: 'GET' })
  })

  it('有 body 时默认 POST 并带 JSON 头；可指定方法', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await api('/api/x', { body: { a: 1 } })
    await api('/api/y', { method: 'PUT', body: [1] })
    expect(fetch.mock.calls).toEqual([
      ['/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }],
      ['/api/y', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '[1]' }],
    ])
  })

  it('错误响应抛出服务端 error 字段；非 JSON 时用状态文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '计划不可变' }), { status: 409 })))
    await expect(api('/api/x')).rejects.toThrow('计划不可变')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })))
    await expect(api('/api/x')).rejects.toThrow('Internal Server Error')
  })

  it('fileUrl 拼出 /files 路径', () => {
    expect(fileUrl('evidence/r/1.png')).toBe('/files/evidence/r/1.png')
    expect(fileUrl(undefined)).toBeUndefined()
  })
})

describe('实时事件（按顺序执行：共享同一个模块级连接）', () => {
  it('多次订阅只建一个连接，消息广播给所有订阅者，退订后不再收到', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribe(a)
    subscribe(b)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0]!.url).toBe(`ws://${location.host}/ws`)
    FakeSocket.instances[0]!.emit({ type: 'run', run: { id: 'r1' } })
    offA()
    FakeSocket.instances[0]!.emit({ type: 'log' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    expect(a).toHaveBeenCalledWith({ type: 'run', run: { id: 'r1' } })
  })

  it('断线 1 秒后自动重连', () => {
    vi.useFakeTimers()
    FakeSocket.instances[0]!.onclose?.()
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.useRealTimers()
  })

  it('useReload 只对指定类型的事件刷新，并做 150ms 去抖', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const { unmount } = renderHook(() => useReload(['run', 'finding'], reload))
    const socket = FakeSocket.instances.at(-1)!
    socket.emit({ type: 'run' })
    socket.emit({ type: 'finding' })
    socket.emit({ type: 'frame' })
    vi.advanceTimersByTime(149)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
    socket.emit({ type: 'plan' })
    vi.advanceTimersByTime(500)
    expect(reload).toHaveBeenCalledTimes(1)
    unmount()
    vi.useRealTimers()
  })
})
