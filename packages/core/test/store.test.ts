import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStore, newId, type Run, type Store } from '../src'

let root: string
let store: Store

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uta-store-'))
  store = createStore(root)
})
afterEach(async () => rm(root, { recursive: true, force: true }))

function run(attemptId: string): Run {
  return {
    id: 'run_1', caseId: 'c', projectId: 'p', planId: 'pl', planVersion: 1, round: 1, attempt: 1, attemptId,
    trigger: 'manual', status: 'running', stepResults: [], evidence: {}, options: { headed: false, obs: false }, createdAt: 1,
  }
}

describe('store', () => {
  it('put/get/list 往返并做 schema 校验', async () => {
    const now = Date.now()
    await store.cases.put({ id: 'case_a', projectId: 'demo', title: 't', preconditions: [], steps: ['s'], expected: [], data: {}, notes: [], version: 1, createdAt: now, updatedAt: now })
    expect((await store.cases.get('case_a'))?.title).toBe('t')
    expect(await store.cases.list()).toHaveLength(1)
    await expect(store.cases.put({ id: 'bad' } as never)).rejects.toThrow()
    expect(await readdir(join(root, 'cases'))).toEqual(['case_a.json'])
  })

  it('并发 update 串行执行，不丢写', async () => {
    await store.runs.put(run('a1'))
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.runs.update('run_1', (r) => {
      r.stepResults.push({ stepId: `s${i}`, status: 'passed', durationMs: 0 })
    })))
    expect((await store.runs.require('run_1')).stepResults).toHaveLength(20)
  })

  it('持有旧 attemptId 的写入被拒绝', async () => {
    await store.runs.put(run('a2'))
    await expect(store.updateRunAttempt('run_1', 'a1', (r) => { r.status = 'passed' })).rejects.toThrow(/过期/)
    expect((await store.runs.require('run_1')).status).toBe('running')
  })

  it('非法 id 不能穿越目录', async () => {
    await expect(store.cases.get('../x')).rejects.toThrow(/非法/)
    expect(newId('case')).toMatch(/^case_[a-z0-9]+$/)
  })
})
