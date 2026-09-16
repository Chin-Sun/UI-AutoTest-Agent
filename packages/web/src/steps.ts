/** 前端不引入 @uta/core 的运行时代码（含 node 依赖），这里镜像动作列表与流程阶段 */
import type { FlowStage, Step } from '@uta/core'

export const STEP_ACTIONS: Step['action'][] = [
  'goto', 'click', 'fill', 'select', 'check', 'uncheck', 'upload', 'press', 'hover', 'waitFor',
  'assertVisible', 'assertHidden', 'assertText', 'assertValue', 'assertUrl', 'assertCount', 'screenshot', 'use',
]

/** 积木参数的展示文本 */
export function formatParams(params: Record<string, unknown> | undefined): string {
  return params === undefined || Object.keys(params).length === 0 ? '' : JSON.stringify(params)
}

/** 解析编辑框里的积木参数；不是 JSON 对象时返回 undefined（保留原值） */
export function parseParams(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export const FLOW_STAGES: FlowStage[] = ['setup', 'action', 'decision', 'verify', 'cleanup']

export function nextStepId(steps: Step[]): string {
  const max = steps.reduce((m, step) => Math.max(m, Number(/^s(\d+)$/.exec(step.id)?.[1] ?? 0)), 0)
  return `s${max + 1}`
}
