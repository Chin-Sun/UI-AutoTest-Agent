/** 端到端测试用的 HTTP 客户端、轮询等待、WebSocket 事件收集 */
import type { Finding, Report, Run, StepPlan, TestCase } from '@uta/core'

export interface Reply<T> { status: number, body: T }

export function client(base: () => string) {
  const send = async <T>(method: string, path: string, body?: unknown): Promise<Reply<T>> => {
    const response = await fetch(`${base()}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // 非 JSON（静态文件）保持文本
    }
    return { status: response.status, body: parsed as T }
  }
  /** 期望 2xx，否则抛出带服务端错误信息的异常 */
  const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const reply = await send<T & { error?: string }>(method, path, body)
    if (reply.status >= 300) throw new Error(`${method} ${path} → ${reply.status} ${JSON.stringify(reply.body)}`)
    return reply.body
  }
  return {
    send,
    get: <T>(path: string) => ok<T>('GET', path),
    post: <T>(path: string, body: unknown = {}) => ok<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => ok<T>('PUT', path, body),
    cases: (projectId = 'demo') => ok<TestCase[]>('GET', `/api/cases?projectId=${projectId}`),
    runs: (query = 'projectId=demo') => ok<Run[]>('GET', `/api/runs?${query}`),
    findings: (projectId = 'demo') => ok<Finding[]>('GET', `/api/findings?projectId=${projectId}`),
    plans: (caseId: string) => ok<StepPlan[]>('GET', `/api/cases/${caseId}/plans`),
    report: (projectId = 'demo') => ok<Report>('POST', '/api/reports', { projectId }),
    /** 编译并批准，返回已批准计划 */
    async prepare(caseId: string): Promise<StepPlan> {
      const plan = await ok<StepPlan>('POST', `/api/cases/${caseId}/compile`, {})
      return ok<StepPlan>('POST', `/api/plans/${plan.id}/approve`, {})
    },
  }
}

export async function until<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 90_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${JSON.stringify(value).slice(0, 800)}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export const terminal = (run: Run) => run.status === 'passed' || run.status === 'failed' || run.status === 'cancelled'

export interface EventLog {
  events: { type: string, [key: string]: unknown }[]
  frames: Map<string, number>
  logs(scopePrefix?: string): string[]
  close(): void
}

/** 订阅 /ws：帧只计数（避免占内存），其余事件原样保存 */
export async function collectEvents(port: number): Promise<EventLog> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const log: EventLog = {
    events: [],
    frames: new Map(),
    logs: (prefix = '') => log.events.flatMap((event) => (event.type === 'log' && String(event['scope']).startsWith(prefix) ? [String(event['message'])] : [])),
    close: () => socket.close(),
  }
  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as { type: string, runId?: string }
    if (event.type === 'frame') log.frames.set(event.runId!, (log.frames.get(event.runId!) ?? 0) + 1)
    else log.events.push(event)
  }
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  return log
}
