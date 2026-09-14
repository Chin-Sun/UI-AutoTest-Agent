/** 文件存储：往返、校验、并发串行、原子写、attempt 令牌、路径安全 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, GateError, newId, NotFoundError, withLock, type Run, type Store, type TestCase } from '../src'

let root: string
let store: Store

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uta-store-'))
  store = createStore(root)
})
afterEach(async () => rm(root, { recursive: true, force: true }))

const now = Date.now()
const testCase = (id: string, projectId = 'demo'): TestCase => ({ id, projectId, title: id, preconditions: [], steps: ['s'], expected: [], data: {}, notes: [], version: 1, createdAt: now, updatedAt: now })
const run = (attemptId: string, status: Run['status'] = 'running'): Run => ({
  id: 'run_1', caseId: 'c', projectId: 'p', planId: 'pl', planVersion: 1, round: 1, attempt: 1, attemptId,
  trigger: 'manual', status, stepResults: [], evidence: {}, options: { headed: false, obs: false }, createdAt: 1,
})

describe('Collection', () => {
  it('put / get / list 往返，list 按文件名排序并支持过滤', async () => {
    await store.cases.put(testCase('case_b', 'x'))
    await store.cases.put(testCase('case_a'))
    expect((await store.cases.get('case_a'))?.title).toBe('case_a')
    expect((await store.cases.list()).map((c) => c.id)).toEqual(['case_a', 'case_b'])
    expect((await store.cases.list((c) => c.projectId === 'x')).map((c) => c.id)).toEqual(['case_b'])
  })

  it('集合目录不存在时 list 为空、get 为 undefined、require 抛 NotFoundError', async () => {
    expect(await store.plans.list()).toEqual([])
    expect(await store.plans.get('nope')).toBeUndefined()
    await expect(store.plans.require('nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('写入前做 schema 校验，非法对象不落盘', async () => {
    await expect(store.cases.put({ id: 'bad' } as never)).rejects.toThrow()
    expect(await store.cases.list()).toEqual([])
  })

  it('读到损坏的 JSON 时报错而不是静默返回', async () => {
    await store.cases.put(testCase('case_a'))
    await writeFile(join(root, 'cases', 'case_a.json'), '{broken')
    await expect(store.cases.get('case_a')).rejects.toThrow()
  })

  it('update：回调可原地修改或返回新对象；回调抛错则不写', async () => {
    await store.cases.put(testCase('case_a'))
    await store.cases.update('case_a', (doc) => { doc.title = '改1' })
    await store.cases.update('case_a', (doc) => ({ ...doc, title: '改2' }))
    await expect(store.cases.update('case_a', () => { throw new Error('中止') })).rejects.toThrow('中止')
    expect((await store.cases.require('case_a')).title).toBe('改2')
    await expect(store.cases.update('case_a', (doc) => ({ ...doc, title: '' }))).rejects.toThrow()
    expect((await store.cases.require('case_a')).title).toBe('改2')
  })

  it('并发 update 串行执行，不丢写；原子写不留临时文件', async () => {
    await store.runs.put(run('a1'))
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.runs.update('run_1', (r) => {
      r.stepResults.push({ stepId: `s${i}`, status: 'passed', durationMs: 0 })
    })))
    expect((await store.runs.require('run_1')).stepResults).toHaveLength(30)
    expect(await readdir(join(root, 'runs'))).toEqual(['run_1.json'])
    expect((JSON.parse(await readFile(join(root, 'runs', 'run_1.json'), 'utf8')) as { id: string }).id).toBe('run_1')
  })

  it('非法 id 不能穿越目录', async () => {
    for (const id of ['../x', 'a/b', '', 'a b']) await expect(store.cases.get(id)).rejects.toThrow(/非法/)
  })
})

describe('updateRunAttempt', () => {
  it('当前 attempt 可写', async () => {
    await store.runs.put(run('a2'))
    const updated = await store.updateRunAttempt('run_1', 'a2', (r) => { r.status = 'passed' })
    expect(updated.status).toBe('passed')
  })

  it('旧 attempt 或终态 run 的写入被拒绝且不落盘', async () => {
    await store.runs.put(run('a2'))
    await expect(store.updateRunAttempt('run_1', 'a1', (r) => { r.status = 'passed' })).rejects.toBeInstanceOf(GateError)
    expect((await store.runs.require('run_1')).status).toBe('running')
    await store.runs.put(run('a2', 'cancelled'))
    await expect(store.updateRunAttempt('run_1', 'a2', (r) => { r.status = 'passed' })).rejects.toThrow(/只读/)
  })
})

describe('withLock / newId', () => {
  it('同 key 串行；前一个失败不阻塞后一个', async () => {
    const order: number[] = []
    const slow = withLock('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(1)
      throw new Error('boom')
    })
    const fast = withLock('k', async () => { order.push(2) })
    await expect(slow).rejects.toThrow('boom')
    await fast
    expect(order).toEqual([1, 2])
  })

  it('不同 key 互不阻塞', async () => {
    const order: string[] = []
    await Promise.all([
      withLock('a', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') }),
      withLock('b', async () => { order.push('b') }),
    ])
    expect(order).toEqual(['b', 'a'])
  })

  it('id 带前缀且唯一', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('case')))
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(id).toMatch(/^case_[a-z0-9]+$/)
  })
})
