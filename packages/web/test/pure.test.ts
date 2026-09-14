/** 前端纯函数：表单文本转换、标签字典与核心枚举保持同步、步骤 id */
import { describe, expect, it } from 'vitest'
import { DATA_SOURCES, FINDING_STATUSES, FLOW_STAGES as CORE_STAGES, RUN_STATUSES, STEP_ACTIONS as CORE_ACTIONS, VERDICTS, PLAN_STATUSES } from '@uta/core'
import { addTokens, EMPTY_TOKENS, formatDataLines, formatTokens, lines, parseDataLines } from '../src/format'
import {
  ACTION_LABEL, DATA_SOURCE_LABEL, FINDING_STATUS_LABEL, PLAN_STATUS_LABEL, RUN_STATUS_LABEL, STAGE_LABEL, targetLabel, time, TRIGGER_LABEL,
  VERDICT_LABEL,
} from '../src/labels'
import { FLOW_STAGES, nextStepId, STEP_ACTIONS } from '../src/steps'

describe('format', () => {
  it('lines 去掉空行与首尾空白', () => {
    expect(lines('  a \n\n b\n   ')).toEqual(['a', 'b'])
  })

  it('parseDataLines：忽略没有 = 或 key 为空的行；value 允许再含 =（回归：曾把整行当 key）', () => {
    expect(parseDataLines('k=v\n  code = VIP=2026 \n没有等号\n=无key\nempty=')).toEqual({ k: 'v', code: 'VIP=2026', empty: '' })
  })

  it.each([
    [0, '0'], [999, '999'], [1000, '1k'], [1500, '1.5k'], [12_345, '12.3k'], [999_949, '999.9k'], [999_950, '1M'], [1_234_567, '1.2M'],
  ])('formatTokens(%d) → %s', (count, text) => {
    expect(formatTokens(count)).toBe(text)
  })

  it('addTokens 逐项相加，不修改入参', () => {
    expect(addTokens(EMPTY_TOKENS, { input: 3, output: 2, calls: 1 })).toEqual({ input: 3, output: 2, calls: 1 })
    expect(EMPTY_TOKENS).toEqual({ input: 0, output: 0, calls: 0 })
  })

  it('formatDataLines 与 parseDataLines 往返一致', () => {
    const data = { a: '1', b: 'x=y' }
    expect(parseDataLines(formatDataLines(data))).toEqual(data)
    expect(formatDataLines({})).toBe('')
  })
})

describe('labels 与核心枚举同步（核心新增取值时这里会失败，提醒补中文标签）', () => {
  it.each([
    ['ACTION_LABEL', ACTION_LABEL, CORE_ACTIONS],
    ['VERDICT_LABEL', VERDICT_LABEL, VERDICTS],
    ['FINDING_STATUS_LABEL', FINDING_STATUS_LABEL, FINDING_STATUSES],
    ['RUN_STATUS_LABEL', RUN_STATUS_LABEL, RUN_STATUSES],
    ['PLAN_STATUS_LABEL', PLAN_STATUS_LABEL, PLAN_STATUSES],
    ['TRIGGER_LABEL', TRIGGER_LABEL, ['manual', 'gate-rerun', 'flaky-retry']],
    ['STAGE_LABEL', STAGE_LABEL, CORE_STAGES],
    ['DATA_SOURCE_LABEL', DATA_SOURCE_LABEL, DATA_SOURCES],
  ] as [string, Record<string, string>, readonly string[]][])('%s', (_, labels, values) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort())
    for (const value of values) expect(labels[value]).toBeTruthy()
  })

  it('前端镜像的动作列表、流程阶段与核心一致', () => {
    expect(STEP_ACTIONS).toEqual([...CORE_ACTIONS])
    expect(FLOW_STAGES).toEqual([...CORE_STAGES])
  })
})

describe('targetLabel / time / nextStepId', () => {
  it.each([
    [{ role: 'button', name: '登录' }, 'button「登录」'],
    [{ role: 'list' }, 'list「」'],
    [{ testId: 'w' }, 'testId=w'],
    [{ label: '用户名' }, '标签「用户名」'],
    [{ placeholder: '搜索' }, '占位「搜索」'],
    [{ text: '欢迎' }, '文本「欢迎」'],
    [{ css: '#a' }, 'css #a'],
    [undefined, ''],
  ] as const)('%j → %s', (target, label) => {
    expect(targetLabel(target)).toBe(label)
  })

  it('time 对 undefined 返回空串', () => {
    expect(time(undefined)).toBe('')
    expect(time(0)).toMatch(/1970/)
  })

  it('nextStepId 取 sN 最大值 +1，忽略非 sN 的 id', () => {
    expect(nextStepId([])).toBe('s1')
    expect(nextStepId([{ id: 's2', action: 'click' }, { id: 'custom', action: 'click' }, { id: 's10', action: 'click' }])).toBe('s11')
  })
})
