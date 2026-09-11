import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { AsyncButton, LiveLog, Pill } from '../components'

interface ComponentsState {
  skills: { name: string; description: string; roles: string[] }[]
  mcp: { name: string; status: string; error?: string; tools: { name: string; description: string }[]; config: { description?: string; enabled: boolean; roles?: string[] } }[]
  drafts: { name: string; kind: string; description: string; roles: string[]; preview: string; createdAt: number }[]
}

export function ComponentsPage() {
  const [state, setState] = useState<ComponentsState>()
  const [request, setRequest] = useState('')
  const [answer, setAnswer] = useState<string>()
  const load = useCallback(() => { void api<ComponentsState>('/api/components').then(setState) }, [])
  useEffect(load, [load])

  return (
    <div className="page">
      <header><h1>组件中心</h1><p>平台能力 = 已注册组件的叠加。Skill 承载知识与规则，MCP 承载可执行能力；Agent 按角色看到各自可用的组件，缺能力时起草新组件，人批准后才生效。</p></header>
      <div className="split">
        <section className="card grow">
          <h2>Skill</h2>
          <table><tbody>{state?.skills.map((s) => (
            <tr key={s.name}><td className="mono">{s.name}</td><td>{s.description}</td><td>{s.roles.map((r) => <Pill key={r} tone="role">{r}</Pill>)}</td></tr>
          ))}</tbody></table>
          <h2>MCP</h2>
          <table><tbody>{state?.mcp.map((m) => (
            <tr key={m.name}>
              <td className="mono">{m.name}</td>
              <td>{m.config.description}{m.error && <div className="error small">{m.error}</div>}{m.tools.length > 0 && <div className="muted small">{m.tools.map((t) => t.name).join('、')}</div>}</td>
              <td><Pill tone={m.status === 'ready' ? 'passed' : m.status === 'error' ? 'failed' : 'draft'}>{m.status}</Pill></td>
              <td><AsyncButton kind={m.config.enabled ? 'ghost' : 'secondary'} onClick={async () => { await api(`/api/components/mcp/${m.name}`, { body: { enabled: !m.config.enabled } }); load() }}>{m.config.enabled ? '停用' : '启用'}</AsyncButton></td>
            </tr>
          ))}</tbody></table>
        </section>
        <section className="card narrow wide">
          <h2>问 Agent</h2>
          <p className="muted small">orchestrator 会列出组件、按需加载 skill、调用 MCP，缺能力时起草组件草稿。</p>
          <textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="例如：我需要一个能校验导出文件内容的组件" />
          <div className="actions"><AsyncButton disabled={request.trim() === ''} onClick={async () => { const r = await api<{ text: string }>('/api/agent/ask', { body: { request } }); setAnswer(r.text); load() }}>发送</AsyncButton></div>
          {answer && <pre className="answer">{answer}</pre>}
          <LiveLog scopes={['ask']} title="Agent 过程" />
        </section>
      </div>
      <section className="card">
        <h2>待审批草稿 <span className="muted">{state?.drafts.length ?? 0}</span></h2>
        {state?.drafts.length === 0 && <p className="muted">暂无草稿。</p>}
        {state?.drafts.map((d) => (
          <div key={d.name} className="draft">
            <div className="case-head">
              <div><b className="mono">{d.name}</b> <Pill tone="role">{d.kind}</Pill> <span className="muted">{d.description}</span></div>
              <div className="actions">
                <AsyncButton onClick={async () => { await api(`/api/components/drafts/${d.name}/approve`, { body: {} }); load() }}>批准并加载</AsyncButton>
                <AsyncButton kind="danger" onClick={async () => { await api(`/api/components/drafts/${d.name}/reject`, { body: {} }); load() }}>拒绝</AsyncButton>
              </div>
            </div>
            <pre>{d.preview}</pre>
          </div>
        ))}
      </section>
    </div>
  )
}
