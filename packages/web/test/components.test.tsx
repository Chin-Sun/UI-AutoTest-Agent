/** 共用组件：异步按钮、步骤表格编辑、定位编辑器、实时日志、弹窗 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataBinding, Project, Step, Target } from '@uta/core'
import type { BusEvent, UsageRecord } from '../src/api'

// 实时日志依赖 WebSocket：替换 useBus，由测试直接投递事件
let deliver: ((event: BusEvent) => void) | undefined
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  useBus: (listener: (event: BusEvent) => void) => { deliver = listener },
}))

const { AsyncButton, LiveLog, LOG_LIMIT, Modal, Pill, StepTable, TargetEditor, TokenUsage } = await import('../src/components')
const { PlanData, PlanDecisions } = await import('../src/pages/Plans')
const { LoginStatus } = await import('../src/pages/Components')

afterEach(cleanup)

const steps: Step[] = [
  { id: 's1', action: 'goto', value: 'login.html', caseRef: 0 },
  { id: 's2', action: 'fill', target: { label: '用户名' }, value: 'alice', caseRef: 1 },
  { id: 's3', action: 'assertVisible', target: { text: '欢迎' }, caseRef: 2 },
]
const rows = () => screen.getAllByRole('row').slice(1)

describe('Pill / Modal', () => {
  it('Pill 按语气加 class', () => {
    render(<Pill tone="passed">通过</Pill>)
    expect(screen.getByText('通过').className).toBe('pill passed')
  })

  it('Modal：点背景关闭，点内容不关闭', () => {
    const onClose = vi.fn()
    render(<Modal onClose={onClose}><p>内容</p></Modal>)
    fireEvent.click(screen.getByText('内容'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('内容').parentElement!.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('AsyncButton', () => {
  it('执行期间禁用并显示“处理中…”；失败后显示错误并恢复', async () => {
    let reject!: (error: Error) => void
    render(<AsyncButton onClick={() => new Promise((_, r) => { reject = r })}>保存</AsyncButton>)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '处理中…' })).toHaveProperty('disabled', true)
    await act(async () => reject(new Error('网络错误')))
    expect(screen.getByText('网络错误')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
  })

  it('再次点击会清掉旧错误；成功不显示错误；disabled 时不可点', async () => {
    const onClick = vi.fn().mockRejectedValueOnce(new Error('第一次失败')).mockResolvedValueOnce(undefined)
    const { rerender } = render(<AsyncButton onClick={onClick}>提交</AsyncButton>)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText('第一次失败')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.queryByText('第一次失败')).toBeNull()
    rerender(<AsyncButton onClick={onClick} disabled>提交</AsyncButton>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(2)
  })
})

describe('StepTable', () => {
  it('只读：中文动作、定位描述、对应用例句子、状态列；点击行回调并高亮选中', () => {
    const onSelect = vi.fn()
    render(
      <StepTable
        steps={steps}
        sentences={['打开登录页', '输入用户名', '看到欢迎']}
        statusOf={(s) => (
          <b>
            {s.id}
            -状态
          </b>
        )}
        onSelect={onSelect}
        selected="s2"
      />,
    )
    const [first, second] = rows()
    expect(within(first!).getByText('打开')).toBeTruthy()
    expect(within(second!).getByText('标签「用户名」')).toBeTruthy()
    expect(within(second!).getByText('输入用户名')).toBeTruthy()
    expect(within(second!).getByText('s2-状态')).toBeTruthy()
    expect(second!.className).toBe('selected')
    fireEvent.click(first!)
    expect(onSelect).toHaveBeenCalledWith(steps[0])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('编辑：改动作、清空取值变 undefined、改期望', () => {
    const onChange = vi.fn<(steps: Step[]) => void>()
    render(<StepTable steps={steps} editable onChange={onChange} />)
    fireEvent.change(within(rows()[0]!).getAllByRole('combobox')[0]!, { target: { value: 'hover' } })
    expect(onChange.mock.lastCall![0][0]).toEqual({ ...steps[0], action: 'hover' })
    fireEvent.change(within(rows()[1]!).getByDisplayValue('alice'), { target: { value: '' } })
    expect(onChange.mock.lastCall![0][1]!.value).toBeUndefined()
    const expectInput = within(rows()[2]!).getAllByRole('textbox').at(-1)!
    fireEvent.change(expectInput, { target: { value: '欢迎回来' } })
    expect(onChange.mock.lastCall![0][2]!.expect).toBe('欢迎回来')
  })

  it('编辑：上移交换顺序（首行不可上移）、删除行', () => {
    const onChange = vi.fn<(steps: Step[]) => void>()
    render(<StepTable steps={steps} editable onChange={onChange} />)
    expect(within(rows()[0]!).getByTitle('上移')).toHaveProperty('disabled', true)
    fireEvent.click(within(rows()[2]!).getByTitle('上移'))
    expect(onChange.mock.lastCall![0].map((s: Step) => s.id)).toEqual(['s1', 's3', 's2'])
    fireEvent.click(within(rows()[0]!).getByTitle('删除'))
    expect(onChange.mock.lastCall![0].map((s: Step) => s.id)).toEqual(['s2', 's3'])
  })

  it('阶段列：只读显示中文阶段、阶段切换处加分隔、额外高亮多行；编辑态可改阶段或清空', () => {
    const staged: Step[] = [{ ...steps[0]!, stage: 'setup' }, { ...steps[1]!, stage: 'setup' }, { ...steps[2]!, stage: 'verify' }]
    const { unmount } = render(<StepTable steps={staged} showStage highlighted={['s1', 's3']} />)
    expect(screen.getByRole('columnheader', { name: '阶段' })).toBeTruthy()
    expect(within(rows()[0]!).getByText('准备').className).toBe('pill stage-setup')
    expect(rows().map((row) => row.className)).toEqual(['selected', '', 'selected stage-start'])
    unmount()

    const onChange = vi.fn<(steps: Step[]) => void>()
    render(<StepTable steps={staged} showStage editable onChange={onChange} />)
    fireEvent.change(within(rows()[2]!).getByRole('combobox', { name: '阶段' }), { target: { value: 'cleanup' } })
    expect(onChange.mock.lastCall![0][2]!.stage).toBe('cleanup')
    fireEvent.change(within(rows()[0]!).getByRole('combobox', { name: '阶段' }), { target: { value: '' } })
    expect(onChange.mock.lastCall![0][0]!.stage).toBeUndefined()
  })

  it('积木步骤：显示积木 id 与参数；参数失焦后解析，非法 JSON 保留原值；可改积木 id', () => {
    const useStep: Step = { id: 's1', action: 'use', flow: 'molar.ensureTask', params: { tool: 'IAT' } }
    const { unmount } = render(<StepTable steps={[useStep]} />)
    expect(within(rows()[0]!).getByText('积木')).toBeTruthy()
    expect(within(rows()[0]!).getByText('molar.ensureTask')).toBeTruthy()
    expect(within(rows()[0]!).getByText('{"tool":"IAT"}')).toBeTruthy()
    unmount()

    const onChange = vi.fn<(steps: Step[]) => void>()
    render(<StepTable steps={[useStep]} editable onChange={onChange} />)
    fireEvent.blur(screen.getByRole('textbox', { name: '积木参数' }), { target: { value: '{"tool":"PCAT"}' } })
    expect(onChange.mock.lastCall![0][0]!.params).toEqual({ tool: 'PCAT' })
    onChange.mockClear()
    fireEvent.blur(screen.getByRole('textbox', { name: '积木参数' }), { target: { value: '{坏' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '积木' }), { target: { value: 'molar.openTaskPage' } })
    expect(onChange.mock.lastCall![0][0]!.flow).toBe('molar.openTaskPage')
  })

  it('不传 showStage 时没有阶段列', () => {
    render(<StepTable steps={steps} />)
    expect(screen.queryByRole('columnheader', { name: '阶段' })).toBeNull()
  })
})

describe('TokenUsage', () => {
  afterEach(() => vi.unstubAllGlobals())
  const record = (patch: Partial<UsageRecord>): UsageRecord => ({
    id: 'u1', scope: 'compile:c1', role: 'compiler', model: 'ppapi/gpt-5.5', projectId: 'demo', input: 1000, output: 200, calls: 2, createdAt: 0, ...patch,
  })
  const respond = (body: unknown) => vi.fn(async (_url: string) => new Response(JSON.stringify(body)))
  const llm = (scope: string, input: number, output: number): BusEvent => ({ type: 'agent', scope, event: { type: 'llm', text: '', toolCalls: [], model: 'm', usage: { input, output } } })

  it('先显示已落盘累计；进行中的调用实时累加；该 scope 的记录到达后不重复计算', async () => {
    const fetch = respond({ total: { input: 1000, output: 200, calls: 2 }, records: [record({})] })
    vi.stubGlobal('fetch', fetch)
    render(<TokenUsage scopes={['compile:c1']} />)
    const badge = screen.getByLabelText('Token 用量')
    await waitFor(() => expect(badge.textContent).toBe('🔢 输入 1k · 输出 200 · 2 次调用'))
    expect(fetch.mock.calls[0]![0]).toBe('/api/usage?scope=compile%3Ac1')
    expect(badge.title).toContain('compiler · ppapi/gpt-5.5：输入 1000 / 输出 200（2 次调用）')

    act(() => deliver!(llm('compile:c1', 500, 50)))
    act(() => deliver!(llm('compile:other', 9, 9)))
    expect(badge.textContent).toBe('🔢 输入 1.5k · 输出 250 · 3 次调用')
    expect(badge.className).toBe('tokens live')

    act(() => deliver!({ type: 'usage', record: record({ id: 'u2', input: 500, output: 50, calls: 1, createdAt: 1 }) }))
    expect(badge.textContent).toBe('🔢 输入 1.5k · 输出 250 · 3 次调用')
    expect(badge.className).toBe('tokens')
  })

  it('没有调用时显示 0；按项目过滤落盘记录；只计次数（mock）时注明', async () => {
    const fetch = respond({ total: { input: 0, output: 0, calls: 0 }, records: [] })
    vi.stubGlobal('fetch', fetch)
    render(<TokenUsage scopes={[]} projectId="demo" label="本项目" />)
    const badge = screen.getByLabelText('Token 用量')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/usage?projectId=demo', expect.anything()))
    expect(badge.textContent).toBe('🔢 本项目 0')
    expect(badge.title).toBe('暂无 AI 调用记录')
    act(() => deliver!(llm('compile:c1', 500, 50)))
    act(() => deliver!({ type: 'usage', record: record({ projectId: 'other' }) }))
    expect(badge.textContent).toBe('🔢 本项目 0')
    act(() => deliver!({ type: 'usage', record: record({ input: 0, output: 0, calls: 3 }) }))
    expect(badge.textContent).toBe('🔢 本项目 输入 0 · 输出 0 · 3 次调用（mock 不计 token）')
  })

  it('实时日志的模型行附带本轮用量', () => {
    render(<LiveLog scopes={['compile:']} />)
    act(() => deliver!(llm('compile:c1', 1234, 56)))
    expect(screen.getByText('🤖 m： ↑1.2k ↓56')).toBeTruthy()
  })
})

describe('LoginStatus', () => {
  const base: Project = { id: 'p', name: 'P', baseURL: 'http://x', authRoles: {}, slowMo: 0, viewport: { width: 1, height: 1 }, knowledgeSkills: [], importers: {}, testData: [] }
  const login = (accounts: NonNullable<Project['login']>['accounts']): Project['login'] => ({
    url: '/login', accounts, fields: {}, beforeSubmit: [], afterSubmit: [], success: {}, failures: [], check: { url: '/' },
  })

  it('未配置登录 / 没有账号 / 已配置 / 缺变量', () => {
    const { rerender } = render(<LoginStatus project={base} />)
    expect(screen.getByText(/未配置/)).toBeTruthy()
    rerender(<LoginStatus project={{ ...base, login: login({}) }} />)
    expect(screen.getByText('没有配置账号')).toBeTruthy()
    rerender(<LoginStatus project={{ ...base, login: login({ admin: { configured: true }, viewer: { configured: false, usernameVar: 'V_USER', passwordVar: 'V_PASS' }, guest: { configured: false } }) }} />)
    expect(screen.getByText('已配置')).toBeTruthy()
    expect(screen.getByText('在 .env 填写 V_USER、V_PASS')).toBeTruthy()
    expect(screen.getByText('缺少账号')).toBeTruthy()
    expect(screen.getByText('/login')).toBeTruthy()
  })
})

describe('计划数据 / 决策点', () => {
  const data = [
    { key: 'taskId', source: 'catalog' as const, ref: 'task.iat', reason: '有数据' },
    { key: 'node', source: 'human' as const, reason: 'Canvas 造不出' },
    { key: 'name', source: 'generated' as const, value: 'uta-{{ts}}' },
  ]

  it('数据表：目录引用、来源标签；待补充且无值的标红，用例数据已补的不标红并提示；编辑态可填值', () => {
    const onChange = vi.fn<(data: DataBinding[]) => void>()
    const { rerender } = render(<PlanData data={data} caseData={{}} editable onChange={onChange} />)
    expect(within(rows()[0]!).getByText('目录 task.iat')).toBeTruthy()
    expect(within(rows()[0]!).getByText('数据目录').className).toBe('pill source-catalog')
    expect(rows().map((row) => row.className)).toEqual(['', 'missing', ''])
    fireEvent.change(screen.getByRole('textbox', { name: 'node 的值' }), { target: { value: '审核1' } })
    expect(onChange.mock.lastCall![0][1]).toEqual({ ...data[1], value: '审核1' })
    fireEvent.change(screen.getByRole('textbox', { name: 'name 的值' }), { target: { value: '' } })
    expect(onChange.mock.lastCall![0][2]!.value).toBeUndefined()

    rerender(<PlanData data={data} caseData={{ node: '人补的' }} editable={false} onChange={onChange} />)
    expect(rows()[1]!.className).toBe('')
    expect(screen.getByText('用例数据：人补的（优先使用）')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('用例数据覆盖了计划里的值：给出警告并可一键清除用例数据；值相同时不警告', async () => {
    const onClear = vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(undefined)
    const { rerender } = render(<PlanData data={data} caseData={{ name: '人填的' }} editable={false} onChange={vi.fn()} onClearCaseData={onClear} />)
    expect(screen.getByText(/执行时用的是用例数据「人填的」/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '清除用例数据' })) })
    expect(onClear).toHaveBeenCalledWith('name')

    rerender(<PlanData data={data} caseData={{ name: 'uta-{{ts}}' }} editable={false} onChange={vi.fn()} onClearCaseData={onClear} />)
    expect(screen.queryByText(/不会生效/)).toBeNull()
  })

  it('没有数据或决策点时不渲染', () => {
    const { container } = render(<><PlanData data={[]} caseData={{}} editable onChange={vi.fn()} /><PlanDecisions decisions={[]} highlighted={[]} onSelect={vi.fn()} /></>)
    expect(container.innerHTML).toBe('')
  })

  it('决策点：显示选中项与被放弃的候选；点击高亮关联步骤，再点取消', () => {
    const decision = { id: 'd1', question: '转移到哪个节点？', options: ['合格数据', '标注'], chosen: '合格数据', reason: '避开 C6', stepIds: ['s8', 's9'] }
    const onSelect = vi.fn()
    const { rerender } = render(<PlanDecisions decisions={[decision]} highlighted={[]} onSelect={onSelect} />)
    expect(screen.getByText('合格数据').className).toBe('pill approved')
    expect(screen.getByText('标注').className).toBe('option-rejected')
    expect(screen.getByText('避开 C6 · 关联步骤 s8、s9')).toBeTruthy()
    fireEvent.click(screen.getByText('转移到哪个节点？'))
    expect(onSelect).toHaveBeenLastCalledWith(['s8', 's9'])
    rerender(<PlanDecisions decisions={[decision]} highlighted={['s8', 's9']} onSelect={onSelect} />)
    expect(screen.getByRole('listitem').className).toBe('active')
    fireEvent.click(screen.getByText('转移到哪个节点？'))
    expect(onSelect).toHaveBeenLastCalledWith([])
  })
})

describe('TargetEditor', () => {
  function Harness({ initial }: { initial: Target | undefined }) {
    const [target, setTarget] = useState(initial)
    return (
      <>
        <TargetEditor value={target} onChange={setTarget} />
        <output>{JSON.stringify(target) ?? 'none'}</output>
      </>
    )
  }
  const output = (): unknown => JSON.parse(screen.getByRole('status').textContent === 'none' ? 'null' : screen.getByRole('status').textContent)
  const kind = () => screen.getByLabelText('定位方式')

  it('切换定位方式时保留要找的文字（回归：曾把文字填进 role）', () => {
    render(<Harness initial={{ text: '欢迎' }} />)
    fireEvent.change(kind(), { target: { value: 'role' } })
    expect(output()).toEqual({ role: 'button', name: '欢迎' })
    fireEvent.change(kind(), { target: { value: 'label' } })
    expect(output()).toEqual({ label: '欢迎' })
    fireEvent.change(kind(), { target: { value: '' } })
    expect(output()).toBeNull()
  })

  it('编辑 role 与名称；编辑普通值', () => {
    render(<Harness initial={{ role: 'button', name: '提交' }} />)
    const [roleInput, nameInput] = screen.getAllByRole('textbox')
    fireEvent.change(nameInput!, { target: { value: '保存' } })
    expect(output()).toEqual({ role: 'button', name: '保存' })
    fireEvent.change(roleInput!, { target: { value: 'link' } })
    expect(output()).toEqual({ role: 'link', name: '保存' })
    fireEvent.change(nameInput!, { target: { value: '' } })
    expect(output()).toEqual({ role: 'link' })
    cleanup()
    render(<Harness initial={{ css: '#a' }} />)
    fireEvent.change(screen.getByDisplayValue('#a'), { target: { value: '#b' } })
    expect(output()).toEqual({ css: '#b' })
  })
})

describe('LiveLog', () => {
  const send = (event: BusEvent) => act(() => deliver!(event))

  it('只显示匹配 scope 前缀的日志、Agent 回复与工具调用', () => {
    render(<LiveLog scopes={['run:r1', 'repair:']} title="执行日志" />)
    expect(screen.getByText('（暂无）')).toBeTruthy()
    send({ type: 'log', scope: 'run:r1', message: '开始执行', ts: 1 })
    send({ type: 'log', scope: 'run:r2', message: '别的 run', ts: 1 })
    send({ type: 'agent', scope: 'repair:f1', event: { type: 'llm', text: '思考中', model: 'mock/rules', toolCalls: [{ name: 'load_skill' }] } })
    send({ type: 'agent', scope: 'repair:f1', event: { type: 'tool', name: 'propose_plan', isError: true, output: '计划未通过校验\n细节' } })
    send({ type: 'agent', scope: 'run:r1', event: { type: 'tool', name: 'load_skill', isError: false, output: '正文' } })
    send({ type: 'agent', scope: 'run:r1', event: { type: 'error', message: '模型拒绝' } })
    send({ type: 'frame', runId: 'r1', data: 'x' })
    expect(screen.queryByText('（暂无）')).toBeNull()
    expect(screen.getByText('开始执行')).toBeTruthy()
    expect(screen.queryByText('别的 run')).toBeNull()
    expect(screen.getByText('🤖 mock/rules：思考中 → 调用 load_skill')).toBeTruthy()
    expect(screen.getByText('🔧 propose_plan ✗ 计划未通过校验').className).toBe('bad')
    expect(screen.getByText('🔧 load_skill ✓ 正文').className).toBe('tool')
    expect(screen.getByText('⚠ 模型拒绝')).toBeTruthy()
  })

  it(`最多保留 ${LOG_LIMIT} 行，丢弃最旧的（回归：曾保留 201 行）`, () => {
    const { container } = render(<LiveLog scopes={['s']} />)
    for (let i = 0; i < LOG_LIMIT + 50; i += 1) send({ type: 'log', scope: 's', message: `第${i}行`, ts: i })
    const lines = container.querySelectorAll('.log > div:not(.log-title)')
    expect(lines).toHaveLength(LOG_LIMIT)
    expect(lines[0]!.textContent).toBe('第50行')
  })
})
