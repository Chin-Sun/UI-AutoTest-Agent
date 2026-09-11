import { useCallback, useEffect, useRef, useState } from 'react'
import { api, fileUrl, useBus, useReload, type Run, type StepPlan, type TestCase } from '../api'
import { AsyncButton, LiveLog, Modal, Pill, StepTable } from '../components'
import { RUN_STATUS_LABEL, TRIGGER_LABEL, time } from '../labels'
import type { Go } from '../App'

interface Components { mcp: { name: string; status: string }[] }

export function RunPage({ projectId, runId, go }: { projectId: string; runId?: string; go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  const [approved, setApproved] = useState<Record<string, StepPlan | undefined>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [headed, setHeaded] = useState(false)
  const [obs, setObs] = useState(false)
  const [obsReady, setObsReady] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [plan, setPlan] = useState<StepPlan>()
  const [live, setLive] = useState<Record<string, 'running' | 'passed' | 'failed' | 'skipped'>>({})
  const [shot, setShot] = useState<string>()
  const frame = useRef<HTMLImageElement>(null)

  const load = useCallback(async () => {
    const list = await api<TestCase[]>(`/api/cases?projectId=${projectId}`)
    setCases(list)
    const entries = await Promise.all(list.map(async (c) => [c.id, (await api<StepPlan[]>(`/api/cases/${c.id}/plans`)).find((p) => p.status === 'approved')] as const))
    setApproved(Object.fromEntries(entries))
    setRuns(await api<Run[]>(`/api/runs?projectId=${projectId}`))
  }, [projectId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void api<Components>('/api/components').then((c) => setObsReady(c.mcp.some((m) => m.name === 'obs-recorder' && m.status === 'ready'))) }, [])
  useReload(['run', 'plan'], () => void load())

  // 默认跟随正在执行的 run
  const running = runs.find((r) => r.status === 'running')
  const current = runs.find((r) => r.id === runId) ?? running ?? runs[0]
  useEffect(() => {
    if (current === undefined) return
    void api<StepPlan>(`/api/plans/${current.planId}`).then(setPlan)
    setLive(Object.fromEntries(current.stepResults.map((r) => [r.stepId, r.status])))
  }, [current?.id, current?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useBus((event) => {
    if (event.type === 'frame' && frame.current && (current === undefined || event['runId'] === current.id || runId === undefined)) {
      frame.current.src = `data:image/jpeg;base64,${event['data']}`
    }
    if (event.type === 'step' && event['runId'] === current?.id) {
      setLive((state) => ({ ...state, [event['stepId']]: event['phase'] === 'start' ? 'running' : event['result']?.status }))
    }
    if (event.type === 'run' && event['run'].status === 'running' && runId === undefined) {
      setLive({})
      if (frame.current) frame.current.removeAttribute('src')
    }
  })

  const titleOf = (id: string) => cases.find((c) => c.id === id)?.title ?? id
  const result = (stepId: string) => current?.stepResults.find((r) => r.stepId === stepId)
  const finished = current !== undefined && ['passed', 'failed', 'cancelled'].includes(current.status)

  return (
    <div className="page">
      <header><h1>执行直播</h1><p>执行由确定性的 Step 解释器完成（不经过 LLM），画面通过 CDP screencast 实时推送；每步截图，全程录像与 trace。</p></header>
      <section className="card">
        <h2>选择要执行的用例</h2>
        <div className="checklist compact">
          {cases.map((c) => (
            <label key={c.id} className={`check ${approved[c.id] ? '' : 'disabled'}`} title={approved[c.id] ? '' : '需要先批准计划'}>
              <input type="checkbox" disabled={!approved[c.id]} checked={picked.has(c.id)} onChange={(e) => {
                const next = new Set(picked)
                if (e.target.checked) next.add(c.id)
                else next.delete(c.id)
                setPicked(next)
              }} />
              {c.title} {approved[c.id] ? <span className="muted small">v{approved[c.id]!.version}</span> : <span className="muted small">未批准</span>}
            </label>
          ))}
        </div>
        <div className="actions">
          <label className="check"><input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} />同时打开有头浏览器</label>
          <label className={`check ${obsReady ? '' : 'disabled'}`} title={obsReady ? '' : '在组件中心启用 obs-recorder'}><input type="checkbox" disabled={!obsReady} checked={obs} onChange={(e) => setObs(e.target.checked)} />OBS 录制</label>
          <button className="ghost" onClick={() => setPicked(new Set(cases.filter((c) => approved[c.id]).map((c) => c.id)))}>全选可执行</button>
          <AsyncButton disabled={picked.size === 0} onClick={async () => { await api('/api/runs', { body: { caseIds: [...picked], headed, obs } }); go('run') }}>▶ 执行所选（{picked.size}）</AsyncButton>
        </div>
      </section>

      <div className="split">
        <section className="card grow">
          <div className="case-head">
            <h2>{current ? titleOf(current.caseId) : '尚无执行'}</h2>
            {current && <div className="actions">
              <Pill tone={current.status}>{RUN_STATUS_LABEL[current.status]}</Pill>
              <span className="muted small">第 {current.round} 轮 · {TRIGGER_LABEL[current.trigger]} · 计划 v{current.planVersion}</span>
              {(current.status === 'running' || current.status === 'queued') && <AsyncButton kind="danger" onClick={() => api(`/api/runs/${current.id}/cancel`, { body: {} })}>停止</AsyncButton>}
            </div>}
          </div>
          <div className="viewer">
            {finished && current?.evidence.video
              ? <video key={current.id} src={fileUrl(current.evidence.video)} controls autoPlay muted />
              : <img ref={frame} alt="实时画面" />}
            {!finished && current?.status !== 'running' && <div className="viewer-empty">等待执行…</div>}
          </div>
          {finished && current?.evidence.trace && <p className="small muted">trace：<a href={fileUrl(current.evidence.trace)}>下载 trace.zip</a>，用 <code>npx playwright show-trace</code> 打开可逐步回放</p>}
          {plan && <StepTable steps={plan.steps} statusOf={(step) => {
            const status = live[step.id]
            const r = result(step.id)
            return <span className="step-status">
              {status === undefined ? <span className="muted">—</span> : <Pill tone={status}>{status === 'running' ? '执行中' : status === 'passed' ? '✓' : status === 'failed' ? '✗' : '跳过'}</Pill>}
              {r?.durationMs ? <span className="muted small"> {r.durationMs}ms</span> : null}
              {r?.error && <div className="error small">{r.error.message.split('\n')[0]}</div>}
              {r?.screenshot && <a className="small" onClick={() => setShot(fileUrl(r.screenshot))}>截图</a>}
            </span>
          }} />}
          {current && <LiveLog key={current.id} scopes={[`run:${current.id}`]} title="执行日志" />}
        </section>
        <section className="card narrow">
          <h2>执行记录</h2>
          <ul className="list">
            {runs.map((r) => (
              <li key={r.id} className={r.id === current?.id ? 'active' : ''} onClick={() => go('run', r.id)}>
                {titleOf(r.caseId)}
                <div className="small"><Pill tone={r.status}>{RUN_STATUS_LABEL[r.status]}</Pill> <span className="muted">R{r.round} · {TRIGGER_LABEL[r.trigger]} · {time(r.createdAt)}</span></div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {shot && <Modal onClose={() => setShot(undefined)}><img src={shot} alt="步骤截图" /></Modal>}
    </div>
  )
}
