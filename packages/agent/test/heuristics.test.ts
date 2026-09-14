/** 规则引擎：逐条句式、归因分支、修正分支 */
import { describe, expect, it } from 'vitest'
import type { Step } from '@uta/core'
import { ariaCandidates, heuristicCompile, heuristicRepair, heuristicTriage } from '../src'

const compileOne = (sentence: string, expected = false) => {
  const out = heuristicCompile(expected ? { steps: [], expected: [sentence] } : { steps: [sentence], expected: [] })
  const { id: _id, caseRef: _ref, ...step } = out.steps[0] ?? { id: '', caseRef: 0 }
  return step
}

describe('heuristicCompile · 操作句式', () => {
  it.each([
    ['打开「login.html」', { action: 'goto', value: 'login.html' }],
    ['访问“/home”', { action: 'goto', value: '/home' }],
    ['进入 "a.html"', { action: 'goto', value: 'a.html' }],
    ['在「用户名」输入「alice」', { action: 'fill', target: { label: '用户名' }, value: 'alice' }],
    ['「密码」框填写「secret」', { action: 'fill', target: { label: '密码' }, value: 'secret' }],
    ['在「兑换码」中填入「${data.vipCode}」', { action: 'fill', target: { label: '兑换码' }, value: '${data.vipCode}' }],
    ['选择「城市」为「上海」', { action: 'select', target: { label: '城市' }, value: '上海' }],
    ['勾选「同意协议」', { action: 'check', target: { label: '同意协议' } }],
    ['取消勾选「记住我」', { action: 'uncheck', target: { label: '记住我' } }],
    ['上传「/tmp/a.png」到「附件」', { action: 'upload', target: { label: '附件' }, value: '/tmp/a.png' }],
    ['点击「登录」按钮', { action: 'click', target: { role: 'button', name: '登录' } }],
    ['点击「登录」', { action: 'click', target: { role: 'button', name: '登录' } }],
    ['单击「帮助」链接', { action: 'click', target: { role: 'link', name: '帮助' } }],
    ['点击「设置」标签页', { action: 'click', target: { role: 'tab', name: '设置' } }],
    ['点击「退出」菜单项', { action: 'click', target: { role: 'menuitem', name: '退出' } }],
    ['点击「全选」复选框', { action: 'click', target: { role: 'checkbox', name: '全选' } }],
    ['按下「Enter」', { action: 'press', value: 'Enter' }],
    ['按回车', { action: 'press', value: 'Enter' }],
    ['按 Escape', { action: 'press', value: 'Escape' }],
    ['等待 2 秒', { action: 'waitFor', value: '2000' }],
    ['等待300ms', { action: 'waitFor', value: '300' }],
  ])('%s', (sentence, step) => {
    expect(compileOne(sentence)).toEqual(step)
  })
})

describe('heuristicCompile · 预期句式', () => {
  it.each([
    ['页面显示「欢迎，alice」', { action: 'assertVisible', target: { text: '欢迎，alice' } }],
    ['出现「保存成功」', { action: 'assertVisible', target: { text: '保存成功' } }],
    ['提示「兑换码无效」', { action: 'assertVisible', target: { text: '兑换码无效' } }],
    ['不再显示「加载中」', { action: 'assertHidden', target: { text: '加载中' } }],
    ['「弹窗」消失', { action: 'assertHidden', target: { text: '弹窗' } }],
    ['URL 包含「/todos」', { action: 'assertUrl', expect: '/todos' }],
    ['地址为「/done」', { action: 'assertUrl', expect: '/done' }],
    ['「昵称」的值为「小明」', { action: 'assertValue', target: { label: '昵称' }, expect: '小明' }],
  ])('%s', (sentence, step) => {
    expect(compileOne(sentence, true)).toEqual(step)
  })

  it('预期列表里的操作句也能编译（回退到操作规则）', () => {
    expect(compileOne('点击「确定」', true)).toEqual({ action: 'click', target: { role: 'button', name: '确定' } })
  })
})

describe('heuristicCompile · 整体', () => {
  it('caseRef 跨步骤与预期连续编号，无法理解的句子跳过并写进 rationale', () => {
    const out = heuristicCompile({ steps: ['打开「a.html」', '随便看看', '点击「b」'], expected: ['页面显示「c」'] })
    expect(out.steps.map((s) => [s.id, s.caseRef])).toEqual([['s1', 0], ['s2', 2], ['s3', 3]])
    expect(out.unparsed).toEqual(['随便看看'])
    expect(out.rationale).toContain('随便看看')
  })

  it('全部可理解时 rationale 不含失败提示', () => {
    const out = heuristicCompile({ steps: ['打开「a.html」'], expected: ['页面显示「x」'] })
    expect(out.unparsed).toEqual([])
    expect(out.rationale).not.toContain('无法理解')
  })
})

describe('ariaCandidates', () => {
  it('按角色提取去重后的可访问名称', () => {
    const aria = '- button "保存"\n- button "取消"\n- link "帮助"\n  - button "保存"'
    expect(ariaCandidates(aria, 'button')).toEqual(['保存', '取消'])
    expect(ariaCandidates(aria, 'link')).toEqual(['帮助'])
    expect(ariaCandidates(undefined, 'button')).toEqual([])
  })
})

describe('heuristicTriage', () => {
  const steps: Step[] = [
    { id: 's1', action: 'goto', value: 'x.html' },
    { id: 's2', action: 'fill', target: { label: '兑换码' }, value: '${data.code}' },
    { id: 's3', action: 'click', target: { role: 'button', name: '提交' } },
    { id: 's4', action: 'assertVisible', target: { text: '共 2 项' } },
    { id: 's5', action: 'assertText', target: { testId: 'n' }, expect: '3' },
  ]
  const base = { caseTitle: '用例', steps }

  it('缺数据：解析出全部 key', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's2', result: { stepId: 's2', status: 'failed', durationMs: 0, error: { kind: 'missing-data', message: '缺少测试数据：code, token' } } })
    expect(out).toMatchObject({ verdict: 'data-missing', missingKeys: ['code', 'token'] })
    expect(out.suggestion).toContain('code=…')
  })

  it('产品缺陷：未出现时从 ARIA 快照找相近内容（去掉角色前缀）', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's4', result: { stepId: 's4', status: 'failed', durationMs: 0, actual: '不可见或不存在', error: { kind: 'assertion', message: '元素不可见' }, ariaSnapshot: '- listitem: 买牛奶\n- paragraph: 共 1 项' } })
    expect(out.verdict).toBe('product-defect')
    expect(out.expected).toBe('共 2 项')
    expect(out.actual).toBe('页面未出现「共 2 项」，相近内容：共 1 项')
    expect(out.summary).toBe('期望「共 2 项」，实际页面未出现「共 2 项」，相近内容：共 1 项')
  })

  it('产品缺陷：有实际值时直接使用', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's5', result: { stepId: 's5', status: 'failed', durationMs: 0, actual: '2', error: { kind: 'assertion', message: 'x' } } })
    expect(out).toMatchObject({ verdict: 'product-defect', expected: '3', actual: '2', summary: '期望「3」，实际为2' })
  })

  it('环境抖动', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's1', result: { stepId: 's1', status: 'failed', durationMs: 0, error: { kind: 'navigation', message: 'net::ERR_CONNECTION_REFUSED' } } })
    expect(out).toMatchObject({ verdict: 'env-flaky', severity: 'low' })
  })

  it('步骤错误：给出页面上同角色控件作为候选', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's3', result: { stepId: 's3', status: 'failed', durationMs: 0, error: { kind: 'locator', message: 'Timeout\n详细' }, ariaSnapshot: '- button "保存"' } })
    expect(out).toMatchObject({ verdict: 'step-defect', summary: 's3 找不到「提交」', actual: 'Timeout' })
    expect(out.suggestion).toContain('「保存」')
  })

  it('步骤错误：没有候选时请人描述', () => {
    const out = heuristicTriage({ ...base, failedStepId: 's3', result: { stepId: 's3', status: 'failed', durationMs: 0, error: { kind: 'locator', message: 'x' } } })
    expect(out.suggestion).toContain('请描述')
  })
})

describe('heuristicRepair', () => {
  const steps: Step[] = [
    { id: 's1', action: 'goto', value: 'a.html' },
    { id: 's2', action: 'click', target: { role: 'button', name: '提交' } },
    { id: 's3', action: 'fill', target: { label: '名字' }, value: 'x' },
    { id: 's4', action: 'fill', target: { placeholder: '搜索' }, value: 'x' },
    { id: 's5', action: 'assertVisible', target: { text: '共 2 项' } },
    { id: 's6', action: 'assertText', target: { testId: 'n' }, expect: '2' },
    { id: 's7', action: 'click', target: { css: '#go' } },
    { id: 's8', action: 'click', target: { testId: 'go' } },
  ]
  const repair = (stepId: string, content: string) => heuristicRepair({ steps, finding: { stepId, verdict: 'step-defect' }, feedback: { kind: 'fix-step', content } })

  it.each([
    ['s1', { id: 's1', action: 'goto', value: 'b.html' }],
    ['s2', { id: 's2', action: 'click', target: { role: 'button', name: 'b.html' } }],
    ['s3', { id: 's3', action: 'fill', target: { label: 'b.html' }, value: 'x' }],
    ['s4', { id: 's4', action: 'fill', target: { placeholder: 'b.html' }, value: 'x' }],
    ['s5', { id: 's5', action: 'assertVisible', target: { text: 'b.html' } }],
    ['s6', { id: 's6', action: 'assertText', target: { testId: 'n' }, expect: 'b.html' }],
    ['s7', { id: 's7', action: 'click', target: { css: 'b.html' } }],
    ['s8', { id: 's8', action: 'click', target: { testId: 'b.html' } }],
  ])('%s 用「」中的第一个值修正', (stepId, patched) => {
    const out = repair(stepId, '应该是「b.html」，不是「x」')
    expect(out.steps.find((s) => s.id === stepId)).toEqual(patched)
    expect(out.steps.filter((s) => s.id !== stepId)).toEqual(steps.filter((s) => s.id !== stepId))
    expect(out.rationale).toContain('「b.html」')
  })

  it('人直接改的步骤优先于文字', () => {
    const out = heuristicRepair({ steps, finding: { stepId: 's2', verdict: 'step-defect' }, feedback: { kind: 'fix-step', content: '「无关」', stepPatches: [{ stepId: 's2', patch: { target: { text: '保存' } } }] } })
    expect(out.steps[1]?.target).toEqual({ text: '保存' })
    expect(out.rationale).toBe('按人工直接修改的步骤更新')
  })

  it('没有「」或找不到步骤时报错', () => {
    expect(() => repair('s2', '按钮叫保存')).toThrow(/「」/)
    expect(() => repair('s99', '「保存」')).toThrow(/找不到/)
    expect(() => heuristicRepair({ steps, finding: { verdict: 'step-defect' }, feedback: { kind: 'fix-step', content: '「保存」' } })).toThrow(/找不到/)
  })

  it('不修改入参', () => {
    const copy = structuredClone(steps)
    repair('s2', '「保存」')
    expect(steps).toEqual(copy)
  })
})
