/**
 * 前后端事件契约：服务端 Bus 发出的每种事件都必须能被前端 BusEvent 类型接收。
 * 这是编译期检查——服务端改了事件结构而前端没跟上时，`pnpm typecheck` 会失败。
 */
import { describe, expect, it } from 'vitest'
import type { BusEvent as ServerEvent } from '../src/bus'
import type { BusEvent as WebEvent } from '../../web/src/api'

// 若类型不兼容，这一行编译失败
const toWeb = (event: ServerEvent): WebEvent => event

describe('前后端事件契约', () => {
  it('服务端事件可直接作为前端事件使用', () => {
    const event: ServerEvent = { type: 'log', scope: 'run:r1', message: 'm', ts: 1 }
    expect(toWeb(event)).toBe(event)
  })
})
