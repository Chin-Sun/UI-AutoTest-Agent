/** runner 的纯函数：错误分类、URL 匹配、target → locator 映射（不启动浏览器） */
import { errors, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { Step } from '@uta/core'
import { classifyError, locate, matchesUrl } from '../src'

const click: Step = { id: 's1', action: 'click', target: { text: 'x' } }
const assertion: Step = { id: 's2', action: 'assertVisible', target: { text: 'x' } }

describe('classifyError', () => {
  it.each([
    [click, new errors.TimeoutError('locator.click: Timeout 8000ms exceeded'), 'locator'],
    [assertion, new errors.TimeoutError('Timeout'), 'assertion'],
    [click, new Error('strict mode violation: getByRole resolved to 2 elements'), 'locator'],
    [click, new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x'), 'navigation'],
    [click, new Error('NS_ERROR_CONNECTION_REFUSED'), 'navigation'],
    [click, new Error('Target page, context or browser has been closed'), 'other'],
    [click, '字符串错误', 'other'],
  ] as [Step, unknown, string][])('%#: → %s', (step, error, kind) => {
    expect(classifyError(step, error).kind).toBe(kind)
  })

  it('错误信息最多保留 6 行', () => {
    const message = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    expect(classifyError(click, new Error(message)).message.split('\n')).toHaveLength(6)
  })
})

describe('matchesUrl', () => {
  it.each([
    ['http://x/a/todos', '/todos', true],
    ['http://x/a/todos', '/done', false],
    ['http://x/a.html#done', '/#done$/', true],
    ['http://x/A', '/a$/i', true],
    ['http://x/A', '/a$/', false],
  ])('%s ~ %s → %s', (url, expected, ok) => {
    expect(matchesUrl(url, expected)).toBe(ok)
  })
})

describe('locate', () => {
  // 假 Page：记录调用了哪个定位方法和参数
  const calls: unknown[][] = []
  const page = new Proxy({}, {
    get: (_, method: string) => (...args: unknown[]) => {
      calls.push([method, ...args])
      return method
    },
  }) as unknown as Page

  it.each([
    [{ testId: 'w' }, ['getByTestId', 'w']],
    [{ role: 'button', name: '登录' }, ['getByRole', 'button', { name: '登录' }]],
    [{ role: 'link', name: 'a', exact: true }, ['getByRole', 'link', { name: 'a', exact: true }]],
    [{ role: 'list' }, ['getByRole', 'list', {}]],
    [{ label: '用户名' }, ['getByLabel', '用户名']],
    [{ placeholder: '搜索' }, ['getByPlaceholder', '搜索']],
    [{ text: '欢迎' }, ['getByText', '欢迎', {}]],
    [{ text: '欢迎', exact: true }, ['getByText', '欢迎', { exact: true }]],
    [{ css: '#a' }, ['locator', '#a']],
    [{ label: '${data.field}' }, ['getByLabel', '邮箱']],
  ] as const)('%j', (target, expected) => {
    calls.length = 0
    locate(page, target, { field: '邮箱' })
    expect(calls).toEqual([expected])
  })

  it('target 引用缺失数据时报错', () => {
    expect(() => locate(page, { text: '${data.none}' }, {})).toThrow(/缺少测试数据/)
  })
})
