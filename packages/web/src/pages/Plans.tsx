import { useCallback, useEffect, useState } from 'react'
import { api, useReload, type Step, type StepPlan, type TestCase } from '../api'
import { AsyncButton, LiveLog, Pill, StepTable } from '../components'
import { PLAN_STATUS_LABEL } from '../labels'
import { nextStepId } from '../steps'
import type { Go } from '../App'

export function PlansPage({ projectId, caseId, go }: { projectId: string; caseId?: string; go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  const [plans, setPlans] = useState<StepPlan[]>([])
  const [planId, setPlanId] = useState<string>()
  const [edited, setEdited] = useState<Step[]>()

  useEffect(() => { void api<TestCase[]>(`/api/cases?projectId=${projectId}`).then(setCases) }, [projectId])
  const testCase = cases.find((c) => c.id === caseId)

  const loadPlans = useCallback(async () => {
    if (caseId === undefined) return
    const list = await api<StepPlan[]>(`/api/cases/${caseId}/plans`)
    setPlans(list)
    setPlanId((current) => {
      const preferred = list.find((p) => p.status === 'draft') ?? list.find((p) => p.status === 'approved')
      return current !== undefined && list.some((p) => p.id === current && p.status !== 'discarded') && !list.some((p) => p.status === 'draft' && p.id !== current) ? current : preferred?.id
    })
  }, [caseId])
  useEffect(() => { setEdited(undefined); void loadPlans() }, [loadPlans])
  useReload(['plan'], () => void loadPlans())

  const plan = plans.find((p) => p.id === planId)
  const steps = edited ?? plan?.steps ?? []
  const sentences = testCase === undefined ? [] : [...testCase.steps, ...testCase.expected]
  const editable = plan?.status === 'draft'

  return (
    <div className="page">
      <header><h1>步骤编译与审批</h1><p>编译 Agent 把用例转成 Playwright 可执行步骤。草稿可以直接修改；批准后才能执行，已批准的计划不可变。</p></header>
      <div className="split">
        <section className="card narrow">
          <h2>用例</h2>
          <ul className="list">
            {cases.map((c) => <li key={c.id} className={c.id === caseId ? 'active' : ''} onClick={() => go('plans', c.id)}>{c.title}<div className="muted small">{c.module}</div></li>)}
          </ul>
        </section>
        <section className="card grow">
          {testCase === undefined ? <p className="muted">← 选择一个用例</p> : <>
            <div className="case-head">
              <div>
                <h2>{testCase.title}</h2>
                <ol className="sentences">{sentences.map((s, i) => <li key={i} className={i >= testCase.steps.length ? 'expect' : ''}>{s}</li>)}</ol>
              </div>
              <div className="actions column">
                <AsyncButton onClick={async () => { setEdited(undefined); const p = await api<StepPlan>(`/api/cases/${testCase.id}/compile`, { body: {} }); setPlanId(p.id) }}>🤖 {plans.length === 0 ? '编译' : '重新编译'}</AsyncButton>
                <select value={planId ?? ''} onChange={(e) => { setEdited(undefined); setPlanId(e.target.value) }}>
                  {plans.map((p) => <option key={p.id} value={p.id}>v{p.version} · {PLAN_STATUS_LABEL[p.status]}{p.derivedFrom ? ' · 门禁修正' : ''}</option>)}
                </select>
              </div>
            </div>
            {plan && <>
              <div className="plan-meta">
                <Pill tone={plan.status}>v{plan.version} {PLAN_STATUS_LABEL[plan.status]}</Pill>
                {plan.derivedFrom && <Pill tone="gate">门禁修正</Pill>}
                <span className="muted small">{plan.createdBy === 'human' ? '人工修改' : 'Agent 生成'} · {plan.rationale}</span>
              </div>
              <StepTable steps={steps} sentences={sentences} editable={editable} onChange={setEdited} />
              {editable && <div className="actions">
                <button className="ghost" onClick={() => setEdited([...steps, { id: nextStepId(steps), action: 'click' }])}>＋ 添加步骤</button>
                {edited && <AsyncButton kind="secondary" onClick={async () => { await api(`/api/plans/${plan.id}`, { method: 'PUT', body: { steps: edited } }); setEdited(undefined) }}>保存修改</AsyncButton>}
                <AsyncButton disabled={edited !== undefined} onClick={async () => { await api(`/api/plans/${plan.id}/approve`, { body: {} }) }}>✓ 批准</AsyncButton>
                <AsyncButton kind="danger" onClick={async () => { await api(`/api/plans/${plan.id}/discard`, { body: {} }) }}>丢弃</AsyncButton>
                {edited && <span className="muted small">有未保存的修改，保存后才能批准</span>}
              </div>}
              {plan.status === 'approved' && <div className="actions"><button onClick={() => go('run')}>去执行 →</button></div>}
            </>}
            <LiveLog scopes={[`compile:${testCase.id}`, 'repair:']} title="Agent 过程" />
          </>}
        </section>
      </div>
    </div>
  )
}
