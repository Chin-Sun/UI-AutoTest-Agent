/** 页面共用的小组件 */
import { useState, type ReactNode } from 'react'
import { STEP_ACTIONS } from './steps'
import type { BusEvent } from './api'
import { useBus, type Step, type Target } from './api'
import { ACTION_LABEL, targetLabel } from './labels'

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function ErrorLine({ error }: { error: string | undefined }) {
  return error ? <p className="error">{error}</p> : null
}

/** 异步按钮：执行期间禁用，并把错误显示在旁边 */
export function AsyncButton({ onClick, children, kind = 'primary', disabled }: { onClick: () => Promise<unknown>; children: ReactNode; kind?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <span className="async">
      <button className={kind} disabled={busy || disabled} onClick={() => {
        setBusy(true)
        setError(undefined)
        onClick().catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
      }}>{busy ? '处理中…' : children}</button>
      {error && <span className="error">{error}</span>}
    </span>
  )
}

/** 按 scope 前缀显示实时 Agent / 执行日志 */
export function LiveLog({ scopes, title = '实时日志' }: { scopes: string[]; title?: string }) {
  const [lines, setLines] = useState<{ ts: number; text: string; tone: string }[]>([])
  useBus((event: BusEvent) => {
    if (!scopes.some((scope) => String(event['scope'] ?? '').startsWith(scope))) return
    let text: string
    let tone = ''
    if (event.type === 'log') text = String(event['message'])
    else if (event.type === 'agent') {
      const agent = event['event'] as { type: string; text?: string; name?: string; input?: unknown; output?: string; isError?: boolean; model?: string; message?: string; toolCalls?: { name: string }[] }
      if (agent.type === 'llm') {
        text = `🤖 ${agent.model}：${agent.text || ''}${agent.toolCalls?.length ? ` → 调用 ${agent.toolCalls.map((c) => c.name).join(', ')}` : ''}`
        tone = 'agent'
      } else if (agent.type === 'tool') {
        text = `🔧 ${agent.name} ${agent.isError ? '✗' : '✓'} ${String(agent.output ?? '').split('\n')[0]!.slice(0, 160)}`
        tone = agent.isError ? 'bad' : 'tool'
      } else text = `⚠ ${agent.message}`
    } else return
    setLines((current) => [...current.slice(-200), { ts: Date.now(), text, tone }])
  })
  return (
    <div className="log">
      <div className="log-title">{title}</div>
      {lines.length === 0 ? <div className="muted">（暂无）</div> : lines.map((line, index) => <div key={index} className={line.tone}>{line.text}</div>)}
    </div>
  )
}

const TARGET_KINDS = ['role', 'testId', 'label', 'placeholder', 'text', 'css'] as const
type TargetKind = (typeof TARGET_KINDS)[number]

function kindOf(target: Target | undefined): TargetKind | '' {
  if (target === undefined) return ''
  return TARGET_KINDS.find((kind) => kind in target) ?? ''
}

export function TargetEditor({ value, onChange }: { value: Target | undefined; onChange: (target: Target | undefined) => void }) {
  const kind = kindOf(value)
  const main = value === undefined ? '' : String((value as Record<string, unknown>)[kind === '' ? 'css' : kind] ?? '')
  const set = (next: TargetKind | '', text: string, name?: string) => {
    if (next === '') onChange(undefined)
    else if (next === 'role') onChange({ role: text || 'button', ...(name === undefined || name === '' ? {} : { name }) })
    else onChange({ [next]: text } as Target)
  }
  return (
    <div className="target">
      <select value={kind} onChange={(e) => set(e.target.value as TargetKind | '', kind === 'role' ? 'button' : main)}>
        <option value="">（无）</option>
        {TARGET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {kind !== '' && <input value={main} onChange={(e) => set(kind, e.target.value, value && 'name' in value ? value.name : undefined)} placeholder={kind === 'role' ? 'button / link / tab…' : ''} />}
      {kind === 'role' && <input value={value && 'name' in value ? value.name ?? '' : ''} onChange={(e) => set('role', main, e.target.value)} placeholder="名称" />}
    </div>
  )
}

export function StepTable({ steps, sentences, editable, onChange, statusOf, onSelect, selected }: {
  steps: Step[]
  sentences?: string[]
  editable?: boolean
  onChange?: (steps: Step[]) => void
  statusOf?: (step: Step) => ReactNode
  onSelect?: (step: Step) => void
  selected?: string
}) {
  const patch = (index: number, change: Partial<Step>) => onChange?.(steps.map((step, i) => (i === index ? { ...step, ...change } : step)))
  const clean = (text: string) => (text === '' ? undefined : text)
  return (
    <table className="steps">
      <thead><tr><th>#</th><th>动作</th><th>目标</th><th>值</th><th>期望</th>{sentences && <th>对应用例</th>}{statusOf && <th>状态</th>}{editable && <th />}</tr></thead>
      <tbody>
        {steps.map((step, index) => (
          <tr key={step.id + index} className={selected === step.id ? 'selected' : ''} onClick={() => onSelect?.(step)}>
            <td className="mono">{step.id}</td>
            <td>{editable
              ? <select value={step.action} onChange={(e) => patch(index, { action: e.target.value as Step['action'] })}>{STEP_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select>
              : ACTION_LABEL[step.action]}</td>
            <td>{editable ? <TargetEditor value={step.target} onChange={(target) => patch(index, { target })} /> : targetLabel(step.target)}</td>
            <td>{editable ? <input value={step.value ?? ''} onChange={(e) => patch(index, { value: clean(e.target.value) })} /> : <span className="mono">{step.value}</span>}</td>
            <td>{editable ? <input value={step.expect ?? ''} onChange={(e) => patch(index, { expect: clean(e.target.value) })} /> : step.expect}</td>
            {sentences && <td className="muted small">{step.caseRef === undefined ? '' : sentences[step.caseRef]}</td>}
            {statusOf && <td>{statusOf(step)}</td>}
            {editable && <td className="row-actions">
              <button className="ghost" title="上移" disabled={index === 0} onClick={() => { const next = [...steps]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange?.(next) }}>↑</button>
              <button className="ghost" title="删除" onClick={() => onChange?.(steps.filter((_, i) => i !== index))}>✕</button>
            </td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return <div className="modal" onClick={onClose}><div onClick={(e) => e.stopPropagation()}>{children}</div></div>
}
