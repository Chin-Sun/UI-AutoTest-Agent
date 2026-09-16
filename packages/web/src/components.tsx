/** 页面共用的小组件 */
import { useEffect, useState, type ReactNode } from 'react'
import { FLOW_STAGES, formatParams, parseParams, STEP_ACTIONS } from './steps'
import { api, useBus, type BusEvent, type Step, type Target, type UsageRecord } from './api'
import { addTokens, EMPTY_TOKENS, formatTokens, type TokenTotals } from './format'
import { ACTION_LABEL, STAGE_LABEL, targetLabel, time } from './labels'

export function Pill({ tone, children }: { tone: string, children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function ErrorLine({ error }: { error: string | undefined }) {
  return error ? <p className="error">{error}</p> : null
}

/** 异步按钮：执行期间禁用，并把错误显示在旁边 */
export function AsyncButton({ onClick, children, kind = 'primary', disabled }: { onClick: () => Promise<unknown>, children: ReactNode, kind?: string, disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <span className="async">
      <button
        className={kind}
        disabled={busy || disabled}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          onClick().catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
        }}
      >
        {busy ? '处理中…' : children}
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  )
}

export const LOG_LIMIT = 200

function describeEvent(event: BusEvent): { text: string, tone: string } | undefined {
  if (event.type === 'log') return { text: event.message, tone: '' }
  if (event.type !== 'agent') return undefined
  const agent = event.event
  if (agent.type === 'llm') {
    const calls = agent.toolCalls.length > 0 ? ` → 调用 ${agent.toolCalls.map((c) => c.name).join(', ')}` : ''
    const tokens = agent.usage === undefined ? '' : ` ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}`
    return { text: `🤖 ${agent.model}：${agent.text}${calls}${tokens}`, tone: 'agent' }
  }
  if (agent.type === 'tool') {
    return { text: `🔧 ${agent.name} ${agent.isError ? '✗' : '✓'} ${agent.output.split('\n')[0]!.slice(0, 160)}`, tone: agent.isError ? 'bad' : 'tool' }
  }
  return { text: `⚠ ${agent.message}`, tone: '' }
}

/** 按 scope 前缀显示实时 Agent / 执行日志（最多保留 LOG_LIMIT 行） */
export function LiveLog({ scopes, title = '实时日志' }: { scopes: string[], title?: string }) {
  const [lines, setLines] = useState<{ text: string, tone: string }[]>([])
  useBus((event) => {
    if (event.type !== 'log' && event.type !== 'agent') return
    if (!scopes.some((scope) => event.scope.startsWith(scope))) return
    const line = describeEvent(event)
    if (line !== undefined) setLines((current) => [...current.slice(-(LOG_LIMIT - 1)), line])
  })
  return (
    <div className="log">
      <div className="log-title">{title}</div>
      {lines.length === 0 ? <div className="muted">（暂无）</div> : lines.map((line, index) => <div key={index} className={line.tone}>{line.text}</div>)}
    </div>
  )
}

/**
 * 一组 scope 的 Token 用量 = 已落盘记录 + 进行中的实时累加。
 * 进行中的调用按 scope 暂存，该 scope 的用量记录到达后清掉，避免重复计算。
 * scopes 为空时不按 scope 过滤，只随落盘记录更新（实时事件不带项目，无法归属）。
 */
export function TokenUsage({ scopes, projectId, label }: { scopes: string[], projectId?: string, label?: string }) {
  const key = scopes.join(',')
  const [saved, setSaved] = useState<{ total: TokenTotals, recent: UsageRecord[] }>({ total: EMPTY_TOKENS, recent: [] })
  const [live, setLive] = useState<Record<string, TokenTotals>>({})

  useEffect(() => {
    const query = new URLSearchParams()
    if (key !== '') query.set('scope', key)
    if (projectId !== undefined) query.set('projectId', projectId)
    void api<{ total: TokenTotals, records: UsageRecord[] }>(`/api/usage?${query.toString()}`)
      .then((body) => setSaved({ total: body.total, recent: body.records.slice(0, 5) }), () => undefined)
  }, [key, projectId])

  const matches = (scope: string) => scopes.some((prefix) => scope.startsWith(prefix))
  useBus((event) => {
    if (event.type === 'agent' && event.event.type === 'llm' && matches(event.scope)) {
      const { scope } = event
      const turn = { input: event.event.usage?.input ?? 0, output: event.event.usage?.output ?? 0, calls: 1 }
      setLive((current) => ({ ...current, [scope]: addTokens(current[scope] ?? EMPTY_TOKENS, turn) }))
    }
    if (event.type === 'usage' && (projectId === undefined || event.record.projectId === projectId) && (scopes.length === 0 || matches(event.record.scope))) {
      const { record } = event
      setSaved((current) => ({ total: addTokens(current.total, record), recent: [record, ...current.recent].slice(0, 5) }))
      setLive((current) => Object.fromEntries(Object.entries(current).filter(([scope]) => scope !== record.scope)))
    }
  })

  const total = Object.values(live).reduce(addTokens, saved.total)
  const running = Object.keys(live).length > 0
  const title = saved.recent.length === 0
    ? '暂无 AI 调用记录'
    : saved.recent.map((record) => `${time(record.createdAt)} ${record.role} · ${record.model}：输入 ${record.input} / 输出 ${record.output}（${record.calls} 次调用）`).join('\n')
  return (
    <span className={running ? 'tokens live' : 'tokens'} title={title} aria-label="Token 用量">
      🔢 {label === undefined ? '' : `${label} `}
      {total.calls === 0 ? '0' : `输入 ${formatTokens(total.input)} · 输出 ${formatTokens(total.output)} · ${total.calls} 次调用`}
      {total.calls > 0 && total.input + total.output === 0 && '（mock 不计 token）'}
    </span>
  )
}

const TARGET_KINDS = ['role', 'testId', 'label', 'placeholder', 'text', 'css'] as const
type TargetKind = (typeof TARGET_KINDS)[number]

function kindOf(target: Target | undefined): TargetKind | '' {
  if (target === undefined) return ''
  return TARGET_KINDS.find((kind) => kind in target) ?? ''
}

export function TargetEditor({ value, onChange }: { value: Target | undefined, onChange: (target: Target | undefined) => void }) {
  const kind = kindOf(value)
  const raw = value === undefined ? undefined : (value as Record<string, unknown>)[kind === '' ? 'css' : kind]
  const main = typeof raw === 'string' ? raw : ''
  const set = (next: TargetKind | '', text: string, name?: string) => {
    if (next === '') onChange(undefined)
    else if (next === 'role') onChange({ role: text || 'button', ...(name === undefined || name === '' ? {} : { name }) })
    else onChange({ [next]: text } as Target)
  }
  /** 切换定位方式时保留“要找的文字”：role 的 name ⇄ 其他方式的值 */
  const switchKind = (next: TargetKind | '') => {
    const carry = value !== undefined && 'role' in value ? value.name ?? '' : main
    if (next === 'role') set('role', 'button', carry)
    else set(next, carry)
  }
  return (
    <div className="target">
      <select value={kind} onChange={(e) => switchKind(e.target.value as TargetKind | '')} aria-label="定位方式">
        <option value="">（无）</option>
        {TARGET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {kind !== '' && <input value={main} onChange={(e) => set(kind, e.target.value, value && 'name' in value ? value.name : undefined)} placeholder={kind === 'role' ? 'button / link / tab…' : ''} />}
      {kind === 'role' && <input value={value && 'name' in value ? value.name ?? '' : ''} onChange={(e) => set('role', main, e.target.value)} placeholder="名称" />}
    </div>
  )
}

function moveUp(steps: Step[], index: number): Step[] {
  const next = [...steps]
  const previous = next[index - 1]!
  next[index - 1] = next[index]!
  next[index] = previous
  return next
}

export function StepTable({ steps, sentences, editable, onChange, statusOf, onSelect, selected, showStage, highlighted }: {
  steps: Step[]
  sentences?: string[]
  editable?: boolean
  onChange?: (steps: Step[]) => void
  statusOf?: (step: Step) => ReactNode
  onSelect?: (step: Step) => void
  selected?: string
  /** 显示流程阶段列，阶段切换处加分隔线 */
  showStage?: boolean
  /** 额外高亮的步骤（如某个决策点关联的步骤） */
  highlighted?: string[]
}) {
  const patch = (index: number, change: Partial<Step>) => onChange?.(steps.map((step, i) => (i === index ? { ...step, ...change } : step)))
  const clean = (text: string) => (text === '' ? undefined : text)
  const rowClass = (step: Step, index: number) => [
    selected === step.id || highlighted?.includes(step.id) ? 'selected' : '',
    showStage && index > 0 && steps[index - 1]!.stage !== step.stage ? 'stage-start' : '',
  ].filter(Boolean).join(' ')
  return (
    <table className="steps">
      <thead>
        <tr>
          <th>#</th>
          {showStage && <th>阶段</th>}
          <th>动作</th>
          <th>目标</th>
          <th>值</th>
          <th>期望</th>
          {sentences && <th>对应用例</th>}
          {statusOf && <th>状态</th>}
          {editable && <th />}
        </tr>
      </thead>
      <tbody>
        {steps.map((step, index) => (
          <tr key={step.id + index} className={rowClass(step, index)} onClick={() => onSelect?.(step)}>
            <td className="mono">{step.id}</td>
            {showStage && (
              <td>
                {editable
                  ? (
                      <select value={step.stage ?? ''} aria-label="阶段" onChange={(e) => patch(index, { stage: e.target.value === '' ? undefined : e.target.value as Step['stage'] })}>
                        <option value="">（无）</option>
                        {FLOW_STAGES.map((stage) => <option key={stage} value={stage}>{STAGE_LABEL[stage]}</option>)}
                      </select>
                    )
                  : step.stage && <Pill tone={`stage-${step.stage}`}>{STAGE_LABEL[step.stage]}</Pill>}
              </td>
            )}
            <td>
              {editable
                ? <select value={step.action} onChange={(e) => patch(index, { action: e.target.value as Step['action'] })}>{STEP_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select>
                : ACTION_LABEL[step.action]}
            </td>
            {step.action === 'use'
              ? (
                  <>
                    <td>{editable ? <input value={step.flow ?? ''} placeholder="积木 id" aria-label="积木" onChange={(e) => patch(index, { flow: clean(e.target.value) })} /> : <span className="mono">{step.flow}</span>}</td>
                    <td>
                      {editable
                        ? (
                            <input
                              key={formatParams(step.params)}
                              defaultValue={formatParams(step.params)}
                              placeholder='{"key":"value"}'
                              aria-label="积木参数"
                              onBlur={(e) => {
                                const params = parseParams(e.target.value)
                                if (params !== undefined) patch(index, { params })
                              }}
                            />
                          )
                        : <span className="mono">{formatParams(step.params)}</span>}
                    </td>
                  </>
                )
              : (
                  <>
                    <td>{editable ? <TargetEditor value={step.target} onChange={(target) => patch(index, { target })} /> : targetLabel(step.target)}</td>
                    <td>{editable ? <input value={step.value ?? ''} onChange={(e) => patch(index, { value: clean(e.target.value) })} /> : <span className="mono">{step.value}</span>}</td>
                  </>
                )}
            <td>{editable ? <input value={step.expect ?? ''} onChange={(e) => patch(index, { expect: clean(e.target.value) })} /> : step.expect}</td>
            {sentences && <td className="muted small">{step.caseRef === undefined ? '' : sentences[step.caseRef]}</td>}
            {statusOf && <td>{statusOf(step)}</td>}
            {editable && (
              <td className="row-actions">
                <button className="ghost" title="上移" disabled={index === 0} onClick={() => onChange?.(moveUp(steps, index))}>↑</button>
                <button className="ghost" title="删除" onClick={() => onChange?.(steps.filter((_, i) => i !== index))}>✕</button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Modal({ onClose, children }: { onClose: () => void, children: ReactNode }) {
  return <div className="modal" onClick={onClose}><div onClick={(e) => e.stopPropagation()}>{children}</div></div>
}
