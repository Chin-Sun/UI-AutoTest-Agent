import { useEffect, useLayoutEffect, useRef } from 'react'
import type { DataBinding, Decision, Finding, Project, Report, Run, Step, StepPlan, StepResult, Target, TestCase, UsageRecord } from '@uta/core'

export type { DataBinding, Decision, Finding, Project, Report, Run, Step, StepPlan, StepResult, Target, TestCase, UsageRecord }

export async function api<T>(path: string, options: { method?: string, body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    ...(options.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error ?? response.statusText)
  return data as T
}

// ---------- 实时事件 ----------

/** Agent 过程事件中前端展示需要的字段（服务端 AgentEvent 的子集） */
export type AgentEventView
  = | { type: 'llm', text: string, toolCalls: { name: string }[], model: string, usage?: { input: number, output: number } }
    | { type: 'tool', name: string, output: string, isError: boolean }
    | { type: 'error', message: string }

/**
 * 服务端事件总线推送的事件。
 * 与 packages/server/src/bus.ts 的契约由 packages/server/test/contract.test.ts 在编译期校验。
 */
export type BusEvent
  = | { type: 'frame', runId: string, data: string }
    | { type: 'step', runId: string, index: number, stepId: string, phase: 'start' | 'end', result?: StepResult }
    | { type: 'run', run: Run }
    | { type: 'plan', plan: StepPlan }
    | { type: 'case', testCase: TestCase }
    | { type: 'finding', finding: Finding }
    | { type: 'report', report: Report }
    | { type: 'agent', scope: string, event: AgentEventView }
    | { type: 'usage', record: UsageRecord }
    | { type: 'log', scope: string, message: string, ts: number }

const listeners = new Set<(event: BusEvent) => void>()
let socket: WebSocket | undefined

function connect(): void {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  socket.onmessage = (message: MessageEvent<string>) => {
    const event = JSON.parse(message.data) as BusEvent
    for (const listener of listeners) listener(event)
  }
  socket.onclose = () => setTimeout(connect, 1000)
}

export function subscribe(listener: (event: BusEvent) => void): () => void {
  if (socket === undefined) connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 订阅事件；回调总是使用最新一次渲染的闭包，且不重复建立订阅 */
export function useBus(listener: (event: BusEvent) => void): void {
  const ref = useRef(listener)
  useLayoutEffect(() => {
    ref.current = listener
  })
  useEffect(() => subscribe((event) => ref.current(event)), [])
}

/** 收到指定类型事件后（去抖）重新加载 */
export function useReload(types: BusEvent['type'][], reload: () => void): void {
  const timer = useRef<number | undefined>(undefined)
  useBus((event) => {
    if (!types.includes(event.type)) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(reload, 150)
  })
}

export function fileUrl(path: string | undefined): string | undefined {
  return path === undefined ? undefined : `/files/${path}`
}
