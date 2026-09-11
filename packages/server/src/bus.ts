import type { AgentEvent } from '@uta/agent'
import type { Finding, Report, Run, StepPlan, StepResult, TestCase } from '@uta/core'

export type BusEvent =
  | { type: 'frame'; runId: string; data: string }
  | { type: 'step'; runId: string; index: number; stepId: string; phase: 'start' | 'end'; result?: StepResult }
  | { type: 'run'; run: Run }
  | { type: 'plan'; plan: StepPlan }
  | { type: 'case'; testCase: TestCase }
  | { type: 'finding'; finding: Finding }
  | { type: 'report'; report: Report }
  | { type: 'agent'; scope: string; event: AgentEvent }
  | { type: 'log'; scope: string; message: string; ts: number }

/** 进程内事件总线：Pipeline 发，WS 转发给前端 */
export class Bus {
  private readonly listeners = new Set<(event: BusEvent) => void>()

  on(listener: (event: BusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅方出错不影响其他订阅方
      }
    }
  }
}
