/** 前端不引入 @uta/core 的运行时代码（含 node 依赖），这里镜像动作列表与流程阶段 */
import type { FlowStage, Step } from '@uta/core'

export const STEP_ACTIONS: Step['action'][] = [
  'goto', 'click', 'fill', 'select', 'check', 'uncheck', 'upload', 'press', 'hover', 'waitFor',
  'assertVisible', 'assertHidden', 'assertText', 'assertValue', 'assertUrl', 'assertCount', 'screenshot',
]

export const FLOW_STAGES: FlowStage[] = ['setup', 'action', 'decision', 'verify', 'cleanup']

export function nextStepId(steps: Step[]): string {
  const max = steps.reduce((m, step) => Math.max(m, Number(/^s(\d+)$/.exec(step.id)?.[1] ?? 0)), 0)
  return `s${max + 1}`
}
