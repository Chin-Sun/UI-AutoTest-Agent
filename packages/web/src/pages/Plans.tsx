import { useCallback, useEffect, useState } from 'react'
import { api, useReload, type DataBinding, type Decision, type Step, type StepPlan, type TestCase } from '../api'
import { AsyncButton, LiveLog, Pill, StepTable, TokenUsage } from '../components'
import { DATA_SOURCE_LABEL, PLAN_STATUS_LABEL } from '../labels'
import { nextStepId } from '../steps'
import type { Go } from '../App'

/** 选中哪个版本：优先草稿，其次已批准；当前选中项仍有效且没有更新的草稿时保持不变 */
function pickPlan(list: StepPlan[], current: string | undefined): string | undefined {
  const preferred = list.find((p) => p.status === 'draft') ?? list.find((p) => p.status === 'approved')
  const keep = current !== undefined
    && list.some((p) => p.id === current && p.status !== 'discarded')
    && !list.some((p) => p.status === 'draft' && p.id !== current)
  return keep ? current : preferred?.id
}

/** 计划声明的测试数据：值 + 来源 + 理由；待人补充且还没有值的标红，草稿态可直接填写 */
export function PlanData({ data, caseData, editable, onChange, onClearCaseData }: {
  data: DataBinding[]
  caseData: Record<string, string>
  editable: boolean
  onChange: (data: DataBinding[]) => void
  /** 清除用例上同名的数据，让计划里的值生效 */
  onClearCaseData?: (key: string) => Promise<unknown>
}) {
  if (data.length === 0) return null
  const setValue = (index: number, value: string) => onChange(data.map((binding, i) => (i === index ? { ...binding, value: value === '' ? undefined : value } : binding)))
  return (
    <div className="plan-section">
      <h3>测试数据</h3>
      <table className="data-bindings">
        <thead>
          <tr>
            <th>数据</th>
            <th>值</th>
            <th>来源</th>
            <th>理由</th>
          </tr>
        </thead>
        <tbody>
          {data.map((binding, index) => {
            const supplied = caseData[binding.key]
            const missing = binding.source === 'human' && !binding.value && !supplied
            return (
              <tr key={binding.key} className={missing ? 'missing' : ''}>
                <td className="mono">{binding.key}</td>
                <td>
                  {binding.source === 'catalog'
                    ? <span className="mono">目录 {binding.ref ?? binding.key}</span>
                    : editable
                      ? <input value={binding.value ?? ''} placeholder={missing ? '待补充' : ''} aria-label={`${binding.key} 的值`} onChange={(e) => setValue(index, e.target.value)} />
                      : <span className="mono">{binding.value ?? '（待补充）'}</span>}
                  {supplied !== undefined && <div className="muted small">用例数据：{supplied}（优先使用）</div>}
                  {supplied !== undefined && binding.value !== undefined && binding.value !== supplied && (
                    <div className="warn small">
                      ⚠ 执行时用的是用例数据「{supplied}」，这里的「{binding.value}」不会生效
                      {onClearCaseData && <AsyncButton kind="linklike" onClick={() => onClearCaseData(binding.key)}>清除用例数据</AsyncButton>}
                    </div>
                  )}
                </td>
                <td><Pill tone={`source-${binding.source}`}>{DATA_SOURCE_LABEL[binding.source]}</Pill></td>
                <td className="muted small">{binding.reason}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Agent 在流程中做出的选择：点击后高亮关联步骤 */
export function PlanDecisions({ decisions, highlighted, onSelect }: { decisions: Decision[], highlighted: string[], onSelect: (stepIds: string[]) => void }) {
  if (decisions.length === 0) return null
  const isActive = (decision: Decision) => decision.stepIds.length > 0 && decision.stepIds.every((id) => highlighted.includes(id))
  return (
    <div className="plan-section">
      <h3>决策点</h3>
      <ul className="decisions">
        {decisions.map((decision) => (
          <li key={decision.id} className={isActive(decision) ? 'active' : ''} onClick={() => onSelect(isActive(decision) ? [] : decision.stepIds)}>
            <div>
              <b>{decision.question}</b>
              {' → '}
              <Pill tone="approved">{decision.chosen}</Pill>
              {decision.options.filter((option) => option !== decision.chosen).map((option) => <span key={option} className="option-rejected">{option}</span>)}
            </div>
            <div className="muted small">
              {decision.reason}
              {decision.stepIds.length > 0 && ` · 关联步骤 ${decision.stepIds.join('、')}`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** App 以 caseId 作为 key 渲染本页：切换用例时所有状态自然重置 */
export function PlansPage({ projectId, caseId, go }: { projectId: string, caseId?: string, go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  const [plans, setPlans] = useState<StepPlan[]>([])
  const [planId, setPlanId] = useState<string>()
  const [edited, setEdited] = useState<Step[]>()
  const [editedData, setEditedData] = useState<DataBinding[]>()
  const [highlighted, setHighlighted] = useState<string[]>([])

  const loadCases = useCallback(() => {
    void api<TestCase[]>(`/api/cases?projectId=${projectId}`).then(setCases)
  }, [projectId])
  useEffect(loadCases, [loadCases])
  useReload(['case'], loadCases)
  const testCase = cases.find((c) => c.id === caseId)

  // 加载只取数据；状态在异步回调里设置（effect 内不同步 setState）
  const fetchPlans = useCallback(async () => (caseId === undefined ? [] : api<StepPlan[]>(`/api/cases/${caseId}/plans`)), [caseId])
  const applyPlans = useCallback((list: StepPlan[]) => {
    setPlans(list)
    setPlanId((current) => pickPlan(list, current))
  }, [])
  useEffect(() => {
    void fetchPlans().then(applyPlans)
  }, [fetchPlans, applyPlans])
  useReload(['plan'], () => void fetchPlans().then(applyPlans))

  const plan = plans.find((p) => p.id === planId)
  const steps = edited ?? plan?.steps ?? []
  const data = editedData ?? plan?.data ?? []
  const dirty = edited !== undefined || editedData !== undefined
  const sentences = testCase === undefined ? [] : [...testCase.steps, ...testCase.expected]
  const editable = plan?.status === 'draft'
  const resetEdits = () => {
    setEdited(undefined)
    setEditedData(undefined)
    setHighlighted([])
  }

  const compile = async () => {
    resetEdits()
    const compiled = await api<StepPlan>(`/api/cases/${testCase!.id}/compile`, { body: {} })
    setPlanId(compiled.id)
  }

  return (
    <div className="page">
      <header>
        <h1>步骤编译与审批</h1>
        <p>编译 Agent 理解用例、挑选测试数据，生成「准备 → 操作 → 决策 → 验证 → 清理」的分阶段流程。草稿可以直接修改；批准后才能执行，已批准的计划不可变。</p>
      </header>
      <div className="split">
        <section className="card narrow">
          <h2>用例</h2>
          <ul className="list">
            {cases.map((c) => (
              <li key={c.id} className={c.id === caseId ? 'active' : ''} onClick={() => go('plans', c.id)}>
                {c.title}
                <div className="muted small">{c.module}</div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card grow">
          {testCase === undefined
            ? <p className="muted">← 选择一个用例</p>
            : (
                <>
                  <div className="case-head">
                    <div>
                      <h2>{testCase.title}</h2>
                      <ol className="sentences">{sentences.map((s, i) => <li key={i} className={i >= testCase.steps.length ? 'expect' : ''}>{s}</li>)}</ol>
                    </div>
                    <div className="actions column">
                      <AsyncButton onClick={compile}>🤖 {plans.length === 0 ? '编译' : '重新编译'}</AsyncButton>
                      <TokenUsage scopes={[`compile:${testCase.id}`]} />
                      <select
                        value={planId ?? ''}
                        aria-label="计划版本"
                        onChange={(e) => {
                          resetEdits()
                          setPlanId(e.target.value)
                        }}
                      >
                        {plans.map((p) => <option key={p.id} value={p.id}>v{p.version} · {PLAN_STATUS_LABEL[p.status]}{p.derivedFrom ? ' · 门禁修正' : ''}</option>)}
                      </select>
                    </div>
                  </div>
                  {plan && (
                    <>
                      <div className="plan-meta">
                        <Pill tone={plan.status}>v{plan.version} {PLAN_STATUS_LABEL[plan.status]}</Pill>
                        {plan.derivedFrom && <Pill tone="gate">门禁修正</Pill>}
                        {plan.derivedFrom && <TokenUsage scopes={[`repair:${plan.derivedFrom.findingId}`]} label="修正" />}
                        <span className="muted small">{plan.createdBy === 'human' ? '人工修改' : 'Agent 生成'} · {plan.rationale}</span>
                      </div>
                      <StepTable steps={steps} sentences={sentences} editable={editable} onChange={setEdited} showStage highlighted={highlighted} />
                      <PlanDecisions decisions={plan.decisions ?? []} highlighted={highlighted} onSelect={setHighlighted} />
                      <PlanData
                        data={data}
                        caseData={testCase.data}
                        editable={editable}
                        onChange={setEditedData}
                        onClearCaseData={async (key) => {
                          const { [key]: _removed, ...rest } = testCase.data
                          await api(`/api/cases/${testCase.id}`, { method: 'PUT', body: { data: rest } })
                          loadCases()
                        }}
                      />
                      {editable && (
                        <div className="actions">
                          <button className="ghost" onClick={() => setEdited([...steps, { id: nextStepId(steps), action: 'click' }])}>＋ 添加步骤</button>
                          {dirty && (
                            <AsyncButton
                              kind="secondary"
                              onClick={async () => {
                                await api(`/api/plans/${plan.id}`, { method: 'PUT', body: { steps, ...(editedData === undefined ? {} : { data: editedData }) } })
                                resetEdits()
                              }}
                            >
                              保存修改
                            </AsyncButton>
                          )}
                          <AsyncButton disabled={dirty} onClick={() => api(`/api/plans/${plan.id}/approve`, { body: {} })}>✓ 批准</AsyncButton>
                          <AsyncButton kind="danger" onClick={() => api(`/api/plans/${plan.id}/discard`, { body: {} })}>丢弃</AsyncButton>
                          {dirty && <span className="muted small">有未保存的修改，保存后才能批准</span>}
                        </div>
                      )}
                      {plan.status === 'approved' && <div className="actions"><button onClick={() => go('run')}>去执行 →</button></div>}
                    </>
                  )}
                  <LiveLog scopes={[`compile:${testCase.id}`, 'repair:']} title="Agent 过程" />
                </>
              )}
        </section>
      </div>
    </div>
  )
}
