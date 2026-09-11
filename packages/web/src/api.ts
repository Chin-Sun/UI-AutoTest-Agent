import { useEffect, useRef } from 'react'
import type { Finding, Project, Report, Run, Step, StepPlan, Target, TestCase } from '@uta/core'

export type { Finding, Project, Report, Run, Step, StepPlan, Target, TestCase }

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    ...(options.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error ?? response.statusText)
  return data as T
}

// ---------- 实时事件 ----------

export interface BusEvent {
  type: 'frame' | 'step' | 'run' | 'plan' | 'case' | 'finding' | 'report' | 'agent' | 'log'
  [key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

const listeners = new Set<(event: BusEvent) => void>()
let socket: WebSocket | undefined

function connect(): void {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as BusEvent
    for (const listener of listeners) listener(event)
  }
  socket.onclose = () => setTimeout(connect, 1000)
}

export function subscribe(listener: (event: BusEvent) => void): () => void {
  if (socket === undefined) connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBus(listener: (event: BusEvent) => void): void {
  const ref = useRef(listener)
  ref.current = listener
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
