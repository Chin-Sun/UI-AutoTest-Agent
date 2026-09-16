/** 积木 SDK：定义校验、JSON Schema、参数与输出检查、项目积木加载、持久状态 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defineFlow, fileState, loadProjectFlows, memoryState, runFlow, toFlowSpec, z, type FlowContext } from '../src'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const ctx = { log: () => undefined } as unknown as FlowContext
const find = defineFlow({
  id: 'demo.findOrder',
  description: '找订单',
  params: z.object({ id: z.string() }),
  outputs: ['orderId'],
  run: async (_ctx, { id }) => ({ orderId: `o-${id}`, extra: 'dropped' }),
})

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('defineFlow / toFlowSpec / runFlow', () => {
  it('id 必须形如 <项目>.<动作>', () => {
    expect(() => defineFlow({ ...find, id: 'findOrder' })).toThrow(/<项目>\.<动作>/)
  })

  it('spec：参数 JSON Schema 与校验函数', () => {
    const spec = toFlowSpec(find)
    expect(spec).toMatchObject({ id: 'demo.findOrder', description: '找订单', outputs: ['orderId'] })
    expect(spec.paramsSchema).toMatchObject({ type: 'object', properties: { id: { type: 'string' } } })
    expect(spec.paramsSchema).not.toHaveProperty('$schema')
    expect(spec.validate({ id: '1' })).toEqual([])
    expect(spec.validate({})).toHaveLength(1)
  })

  it('runFlow：只保留声明的输出；参数不合法或缺输出报 step', async () => {
    expect(await runFlow(find, ctx, { id: '1' })).toEqual({ orderId: 'o-1' })
    await expect(runFlow(find, ctx, {})).rejects.toMatchObject({ kind: 'step' })
    const silent = defineFlow({ ...find, run: async () => undefined })
    await expect(runFlow(silent, ctx, { id: '1' })).rejects.toThrow('积木 demo.findOrder 没有产出 orderId')
  })
})

describe('loadProjectFlows', () => {
  it('没有 flows 目录返回空；默认导出数组；id 重复或导出不是数组时报错', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uta-flows-sdk-'))
    expect(await loadProjectFlows(dir)).toEqual([])
    const write = async (name: string, source: string) => {
      await mkdir(join(dir!, name, 'flows'), { recursive: true })
      await writeFile(join(dir!, name, 'flows', 'index.js'), source)
    }
    await write('ok', 'export default [{ id: "demo.a", description: "a", outputs: [], run: async () => ({}) }]')
    await write('dup', 'const f = { id: "demo.a", description: "a", outputs: [], run: async () => ({}) }; export default [f, f]')
    await write('bad', 'export default {}')
    expect((await loadProjectFlows(join(dir, 'ok'))).map((flow) => flow.id)).toEqual(['demo.a'])
    await expect(loadProjectFlows(join(dir, 'dup'))).rejects.toThrow('积木 id 重复：demo.a')
    await expect(loadProjectFlows(join(dir, 'bad'))).rejects.toThrow('必须默认导出积木数组')
  })

  it('仓库自带的 MolarData 积木可加载', async () => {
    const flows = await loadProjectFlows(join(repo, 'projects/molardata'))
    expect(flows.map((flow) => flow.id)).toEqual(['molar.ensureTask', 'molar.openTaskPage'])
    expect(await loadProjectFlows(join(repo, 'projects/demo'))).toEqual([])
  })
})

describe('状态', () => {
  it('fileState：读写删除都落盘，另一个实例能读到', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uta-flows-state-'))
    const file = join(dir, 'state', 'shop.json')
    const state = fileState(file)
    expect(await state.get('task.IAT')).toBeUndefined()
    await Promise.all([state.set('task.IAT', { taskId: '1' }), state.set('task.PCAT', { taskId: '2' })])
    expect(await fileState(file).get('task.IAT')).toEqual({ taskId: '1' })
    await state.delete('task.IAT')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'task.PCAT': { taskId: '2' } })
  })

  it('memoryState 不落盘', async () => {
    const state = memoryState()
    await state.set('a', 1)
    expect(await state.get('a')).toBe(1)
    await state.delete('a')
    expect(await state.get('a')).toBeUndefined()
  })
})
