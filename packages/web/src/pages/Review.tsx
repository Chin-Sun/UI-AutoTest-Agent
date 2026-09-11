import { useCallback, useEffect, useState } from 'react'
import { api, fileUrl, useReload, type Finding, type Report, type TestCase } from '../api'
import { AsyncButton, Pill } from '../components'
import { time } from '../labels'
import type { Go } from '../App'

export function ReviewPage({ projectId, findings }: { projectId: string; findings: Finding[]; go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const loadReports = useCallback(() => { void api<Report[]>(`/api/reports?projectId=${projectId}`).then(setReports) }, [projectId])
  useEffect(() => { void api<TestCase[]>(`/api/cases?projectId=${projectId}`).then(setCases) }, [projectId, findings])
  useEffect(loadReports, [loadReports])
  useReload(['report'], loadReports)

  const pending = findings.filter((f) => f.status === 'awaiting_review')
  const confirmed = findings.filter((f) => f.status === 'confirmed')
  const titleOf = (id: string) => cases.find((c) => c.id === id)?.title ?? id

  return (
    <div className="page">
      <header><h1>结果审阅与报告</h1><p>动作全部执行成功、但结果与预期不符的用例进入这里。确认后计入报告；判定“不是缺陷”时写明正确预期，Agent 会据此修正用例。</p></header>
      {pending.length === 0 && <section className="card"><p className="muted">没有待审阅的结果。</p></section>}
      {pending.map((finding) => <ReviewCard key={finding.id} finding={finding} title={titleOf(finding.caseId)} />)}

      <section className="card">
        <div className="case-head">
          <h2>测试报告</h2>
          <AsyncButton onClick={() => api('/api/reports', { body: { projectId } })}>生成报告</AsyncButton>
        </div>
        {reports.length === 0 ? <p className="muted">尚未生成报告。</p> : <table>
          <thead><tr><th>时间</th><th>状态</th><th>用例</th><th>通过</th><th>未通过</th><th>缺陷</th><th>待处理</th><th /></tr></thead>
          <tbody>{reports.map((r) => (
            <tr key={r.id} title={r.blockers.join('\n')}>
              <td>{time(r.createdAt)}</td>
              <td><Pill tone={r.status === 'final' ? 'passed' : 'draft'}>{r.status === 'final' ? '定稿' : '草稿'}</Pill></td>
              <td>{r.summary.cases}</td><td>{r.summary.passed}</td><td>{r.summary.failed}</td><td>{r.summary.defects}</td><td>{r.summary.open}</td>
              <td><a href={fileUrl(r.html)} target="_blank">打开 →</a></td>
            </tr>
          ))}</tbody>
        </table>}
        {confirmed.length > 0 && <>
          <h3>已确认缺陷</h3>
          <ul>{confirmed.map((f) => <li key={f.id}>{titleOf(f.caseId)}：{f.summary}</li>)}</ul>
        </>}
      </section>
    </div>
  )
}

function ReviewCard({ finding, title }: { finding: Finding; title: string }) {
  const [reason, setReason] = useState('')
  const send = (body: object) => api(`/api/findings/${finding.id}/feedback`, { body })
  return (
    <section className="card finding awaiting_review">
      <div className="case-head">
        <h2>{title}</h2>
        <div className="actions"><Pill tone="product-defect">疑似产品缺陷</Pill><Pill tone={finding.severity}>{finding.severity}</Pill><span className="muted small">第 {finding.round} 轮</span></div>
      </div>
      <div className="compare">
        <div><div className="label">预期</div><div className="expected">{finding.expected}</div></div>
        <div><div className="label">实际</div><div className="actual">{finding.actual}</div></div>
      </div>
      <div className="evidence">
        {finding.evidence.screenshot && <img src={fileUrl(finding.evidence.screenshot)} alt="失败截图" />}
        {finding.evidence.video && <video src={fileUrl(finding.evidence.video)} controls muted />}
      </div>
      {finding.evidence.trace && <p className="small"><a href={fileUrl(finding.evidence.trace)}>trace.zip</a></p>}
      <div className="form">
        <label>不是缺陷？写明正确的预期（用「」标出）
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：计数应显示「共 1 项」" />
        </label>
        <div className="actions">
          <AsyncButton onClick={() => send({ kind: 'confirm-defect' })}>确认缺陷</AsyncButton>
          <AsyncButton kind="secondary" disabled={reason.trim() === ''} onClick={() => send({ kind: 'not-a-defect', content: reason })}>不是缺陷，修正用例</AsyncButton>
          <AsyncButton kind="ghost" onClick={() => send({ kind: 'dismiss' })}>忽略</AsyncButton>
        </div>
      </div>
    </section>
  )
}
