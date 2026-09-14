/** Token 用量：汇总与记录 schema */
import { describe, expect, it } from 'vitest'
import { sumUsage, UsageRecordSchema } from '../src'

describe('Token 用量', () => {
  it('sumUsage 累加输入、输出与调用次数；空列表为 0', () => {
    expect(sumUsage([])).toEqual({ input: 0, output: 0, calls: 0 })
    expect(sumUsage([{ input: 100, output: 20, calls: 2 }, { input: 5, output: 0, calls: 1 }])).toEqual({ input: 105, output: 20, calls: 3 })
  })

  it('记录 schema：projectId 可省略；拒绝负数与小数', () => {
    const base = { id: 'usage_1', scope: 'ask', role: 'orchestrator', model: 'mock/rules', input: 0, output: 0, calls: 1, createdAt: 0 }
    expect(UsageRecordSchema.parse(base)).toEqual(base)
    expect(UsageRecordSchema.safeParse({ ...base, input: -1 }).success).toBe(false)
    expect(UsageRecordSchema.safeParse({ ...base, output: 1.5 }).success).toBe(false)
  })
})
