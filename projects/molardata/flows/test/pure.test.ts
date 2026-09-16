/** MolarData 积木的纯函数：路由、工具映射、接口包装解析（不访问被测环境） */
import { describe, expect, it } from 'vitest'
import { toFlowSpec } from '@uta/flows'
import flows from '../index'
import { looksLikeTaskId, TASK_PAGE_IDS, taskUrl } from '../routes'
import { businessData, taskRecords } from '../task'
import { autoTaskName, defaultTaskRef, EXPECTED_IMPORT_CARDS, TOOL_CARD_NAME, TOOLS } from '../tools'

const response = (body: unknown) => ({ json: async () => body }) as unknown as Parameters<typeof businessData>[0]

describe('路由', () => {
  it('taskId 走 query 参数', () => {
    expect(taskUrl('io', '6a86b1b41b09b17c662ce1e2')).toBe('/task-v2/io?taskId=6a86b1b41b09b17c662ce1e2')
    expect(TASK_PAGE_IDS).toEqual(['io', 'workflow', 'dataItem', 'setting', 'member', 'statistics'])
  })

  it('目录值是 taskId 还是任务名', () => {
    expect(looksLikeTaskId('6a86b1b41b09b17c662ce1e2')).toBe(true)
    expect(looksLikeTaskId('uta-auto-IAT')).toBe(false)
  })
})

describe('工具', () => {
  it('每种工具都有创建弹窗卡片名；IAT 导入弹窗 9 类', () => {
    for (const tool of TOOLS) expect(TOOL_CARD_NAME[tool]).toBeTruthy()
    expect(EXPECTED_IMPORT_CARDS.IAT).toHaveLength(9)
    expect(autoTaskName('IAT')).toBe('uta-auto-IAT')
    expect(defaultTaskRef('IAT')).toBe('task.iat')
    expect(defaultTaskRef('PCAT_4D')).toBe('task.pcat_4d')
  })
})

describe('接口解析', () => {
  it('业务 code 200 / 0 取 data，其他 code 视为失败，旧格式原样返回', async () => {
    expect(await businessData(response({ code: 200, data: { name: 'a' } }))).toEqual({ name: 'a' })
    expect(await businessData(response({ code: 0, data: 'id1' }))).toBe('id1')
    expect(await businessData(response({ code: 4001, message: '无权限' }))).toBeUndefined()
    expect(await businessData(response([{ _id: 'x' }]))).toEqual([{ _id: 'x' }])
  })

  it('任务列表兼容数组与分页结构', () => {
    expect(taskRecords([{ _id: 'a' }])).toEqual([{ _id: 'a' }])
    expect(taskRecords({ data: [{ _id: 'b' }], total: 1 })).toEqual([{ _id: 'b' }])
    expect(taskRecords({ list: [{ _id: 'c' }] })).toEqual([{ _id: 'c' }])
    expect(taskRecords(null)).toEqual([])
  })
})

describe('积木清单', () => {
  it('导出 ensureTask 与 openTaskPage，参数校验可用', () => {
    const specs = flows.map((flow) => toFlowSpec(flow))
    expect(specs.map((spec) => spec.id)).toEqual(['molar.ensureTask', 'molar.openTaskPage'])
    expect(specs[0]!.outputs).toEqual(['taskId', 'taskName'])
    expect(specs[0]!.validate({ tool: 'IAT', ref: 'task.iat' })).toEqual([])
    expect(specs[0]!.validate({ tool: 'NOPE' })).not.toEqual([])
    expect(specs[1]!.validate({ taskId: '${data.taskId}', page: 'io' })).toEqual([])
    expect(specs[1]!.validate({ taskId: 'x', page: 'detail' })).not.toEqual([])
  })
})
