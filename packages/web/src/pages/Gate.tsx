import { useEffect, useState } from 'react'
import { api, fileUrl, type Finding, type Step, type StepPlan, type TestCase } from '../api'
import { AsyncButton, LiveLog, Modal, Pill, StepTable, TokenUsage } from '../components'
import { FINDING_STATUS_LABEL, VERDICT_LABEL } from '../labels'
import type { Go } from '../App'

const GATE_STATUSES = ['awaiting_human', 'escalated', 'repairing', 'rerunning']

export function GatePage({ projectId, findings, go }: { projectId: string, findings: Finding[], go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  useEffect(() => {
    void api<TestCase[]>(`/api/cases?projectId=${projectId}`).then(setCases)
  }, [projectId, findings])
  const open = findings.filter((f) => GATE_STATUSES.includes(f.status))
  const recent = findings.filter((f) => ['resolved', 'dismissed'].includes(f.status) && f.verdict !== 'product-defect').slice(0, 8)

  return (
    <div className="page">
      <header>
        <h1>失败门禁</h1>
        <p>步骤错误与缺少数据会停在这里等人补充。提交后 Agent 修正用例计划（或写入数据）并只重跑该用例；小修自动批准，改结构或预期需要回到②批准。</p>
      </header>
      {open.length === 0 && <section className="card"><p className="muted">当前没有等待处理的门禁。</p></section>}
      {open.map((finding) => <GateCard key={finding.id} finding={finding} testCase={cases.find((c) => c.id === finding.caseId)} go={go} />)}
      {recent.length > 0 && (
        <section className="card">
          <h2>最近关闭</h2>
          <table>
            <tbody>
              {recent.map((f) => (
                <tr key={f.id}>
                  <td>{cases.find((c) => c.id === f.caseId)?.title}</td>
                  <td><Pill tone={f.verdict}>{VERDICT_LABEL[f.verdict]}</Pill></td>
                  <td>{FINDING_STATUS_LABEL[f.status]}</td>
                  <td className="small muted">R{f.round} · {f.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

async function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] ?? '' : '')
    reader.readAsDataURL(file)
  })
}

function GateCard({ finding, testCase, go }: { finding: Finding, testCase?: TestCase, go: Go }) {
  const [plan, setPlan] = useState<StepPlan>()
  const [hint, setHint] = useState('')
  const [patch, setPatch] = useState<Step>()
  const [data, setData] = useState<Record<string, string>>({})
  const [shot, setShot] = useState(false)
  useEffect(() => {
    void api<StepPlan>(`/api/plans/${finding.planId}`).then(setPlan)
  }, [finding.planId])
  const step = plan?.steps.find((s) => s.id === finding.stepId)
  const busy = finding.status === 'repairing' || finding.status === 'rerunning'
  const send = (body: object) => api(`/api/findings/${finding.id}/feedback`, { body })

  const upload = async (key: string, file: File) => {
    const { path } = await api<{ path: string }>('/api/uploads', { body: { filename: file.name, base64: await readAsBase64(file) } })
    setData((d) => ({ ...d, [key]: path }))
  }

  return (
    <section className={`card finding ${finding.status}`}>
      <div className="case-head">
        <div>
          <h2>{testCase?.title ?? finding.caseId}</h2>
          <div className="actions">
            <Pill tone={finding.verdict}>{VERDICT_LABEL[finding.verdict]}</Pill>
            <Pill tone={finding.status}>{FINDING_STATUS_LABEL[finding.status]}</Pill>
            <span className="muted small">第 {finding.round} 轮 · {finding.triagedBy === 'agent' ? 'Agent 归因' : '规则归因'}</span>
            <TokenUsage scopes={[`triage:${finding.runId}`, `repair:${finding.id}`]} />
          </div>
        </div>
        {finding.evidence.screenshot && <img className="thumb" src={fileUrl(finding.evidence.screenshot)} alt="失败截图" onClick={() => setShot(true)} />}
      </div>
      {finding.status === 'escalated' && <p className="warn">已超过最大轮次，自动循环已停止。你可以继续人工指点，或关闭此项。</p>}
      <p><b>{finding.summary}</b></p>
      {finding.actual && <p className="small mono">{finding.actual}</p>}
      {finding.suggestion && <p className="suggest">💡 {finding.suggestion}</p>}
      {finding.lastError && <p className="error">上次修正失败：{finding.lastError}</p>}
      {step && <StepTable steps={[patch ?? step]} editable={!busy && finding.verdict !== 'data-missing'} onChange={(s) => setPatch(s[0])} />}
      <p className="small">
        {finding.evidence.video && <a href={fileUrl(finding.evidence.video)} target="_blank" rel="noreferrer">录像</a>}
        {finding.evidence.trace && <> · <a href={fileUrl(finding.evidence.trace)}>trace</a></>}
      </p>

      {busy
        ? (
            <div className="actions">
              <span className="muted">{finding.status === 'repairing' ? 'Agent 正在修正计划；若修正涉及结构/预期变更，需要到②批准' : '已排队重跑'}</span>
              <button className="ghost" onClick={() => (finding.status === 'repairing' ? go('plans', finding.caseId) : go('run'))}>查看 →</button>
            </div>
          )
        : finding.verdict === 'data-missing'
          ? (
              <div className="form">
                {(finding.missingKeys ?? []).map((key) => (
                  <label key={key}>
                    {key}
                    <div className="row">
                      <input value={data[key] ?? ''} onChange={(e) => setData({ ...data, [key]: e.target.value })} placeholder="值或文件路径" />
                      <input
                        type="file"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void upload(key, file)
                        }}
                      />
                    </div>
                  </label>
                ))}
                <div className="actions">
                  <AsyncButton disabled={Object.values(data).every((v) => v === '')} onClick={() => send({ kind: 'supply-data', dataPatch: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== '')) })}>补充数据并重跑</AsyncButton>
                  <AsyncButton kind="ghost" onClick={() => send({ kind: 'dismiss' })}>关闭</AsyncButton>
                </div>
              </div>
            )
          : (
              <div className="form">
                <label>
                  指点 Agent（用「」标出正确的页面文字，或直接改上面的步骤）
                  <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="例如：按钮叫「保存」，不是「提交」" />
                </label>
                <div className="actions">
                  <AsyncButton
                    disabled={hint.trim() === '' && patch === undefined}
                    onClick={() => send({
                      kind: 'fix-step',
                      content: hint,
                      ...(patch === undefined ? {} : { stepPatches: [{ stepId: patch.id, patch: { action: patch.action, target: patch.target, value: patch.value, expect: patch.expect } }] }),
                    })}
                  >
                    提交修正并重跑
                  </AsyncButton>
                  <AsyncButton kind="secondary" onClick={() => send({ kind: 'confirm-defect' })}>这是产品缺陷</AsyncButton>
                  <AsyncButton kind="ghost" onClick={() => send({ kind: 'dismiss' })}>关闭</AsyncButton>
                </div>
              </div>
            )}
      <LiveLog scopes={[`repair:${finding.id}`, `run:${finding.runId}`, `triage:${finding.runId}`]} title="Agent / 执行日志" />
      {shot && <Modal onClose={() => setShot(false)}><img src={fileUrl(finding.evidence.screenshot)} alt="失败截图" /></Modal>}
    </section>
  )
}
