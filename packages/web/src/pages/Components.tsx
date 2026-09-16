import { useCallback, useEffect, useState } from 'react'
import { api, type Project } from '../api'
import { AsyncButton, LiveLog, Pill, TokenUsage } from '../components'

interface FlowView {
  id: string
  description: string
  outputs: string[]
}

interface ProjectFlows {
  project: Project
  flows: FlowView[]
}

/** 登录配置状态：每个角色是否配齐账号，缺哪个环境变量 */
export function LoginStatus({ project }: { project: Project }) {
  if (project.login === undefined) return <span className="muted small">未配置（无需登录，或使用 authRoles 登录态文件）</span>
  const accounts = Object.entries(project.login.accounts)
  if (accounts.length === 0) return <Pill tone="failed">没有配置账号</Pill>
  return (
    <>
      {accounts.map(([role, account]) => {
        const missing = [account.usernameVar, account.passwordVar].filter((name): name is string => name !== undefined)
        return (
          <div key={role}>
            <Pill tone="role">{role}</Pill>
            {account.configured === true
              ? <Pill tone="passed">已配置</Pill>
              : <Pill tone="failed">{missing.length === 0 ? '缺少账号' : `在 .env 填写 ${missing.join('、')}`}</Pill>}
          </div>
        )
      })}
      <div className="muted small mono">{project.login.url}</div>
    </>
  )
}

interface ComponentsState {
  skills: { name: string, description: string, roles: string[] }[]
  mcp: { name: string, status: string, error?: string, tools: { name: string, description: string }[], config: { description?: string, enabled: boolean, roles?: string[] } }[]
  drafts: { name: string, kind: string, description: string, roles: string[], preview: string, createdAt: number }[]
}

export function ComponentsPage() {
  const [state, setState] = useState<ComponentsState>()
  const [request, setRequest] = useState('')
  const [answer, setAnswer] = useState<string>()
  const [projects, setProjects] = useState<ProjectFlows[]>([])
  const load = useCallback(() => {
    void api<ComponentsState>('/api/components').then(setState)
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    void api<Project[]>('/api/projects')
      .then((list) => Promise.all(list.map(async (project) => ({ project, flows: await api<FlowView[]>(`/api/projects/${project.id}/flows`) }))))
      .then(setProjects)
  }, [])

  const toggle = async (name: string, enabled: boolean) => {
    await api(`/api/components/mcp/${name}`, { body: { enabled } })
    load()
  }
  const ask = async () => {
    const reply = await api<{ text: string }>('/api/agent/ask', { body: { request } })
    setAnswer(reply.text)
    load()
  }
  const decide = async (name: string, action: 'approve' | 'reject') => {
    await api(`/api/components/drafts/${name}/${action}`, { body: {} })
    load()
  }

  return (
    <div className="page">
      <header>
        <h1>组件中心</h1>
        <p>平台能力 = 已注册组件的叠加。Skill 承载知识与规则，MCP 承载可执行能力；Agent 按角色看到各自可用的组件，缺能力时起草新组件，人批准后才生效。</p>
      </header>
      <div className="split">
        <section className="card grow">
          <h2>Skill</h2>
          <table>
            <tbody>
              {state?.skills.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td>{s.description}</td>
                  <td>{s.roles.map((r) => <Pill key={r} tone="role">{r}</Pill>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>MCP</h2>
          <table>
            <tbody>
              {state?.mcp.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>
                    {m.config.description}
                    {m.error && <div className="error small">{m.error}</div>}
                    {m.tools.length > 0 && <div className="muted small">{m.tools.map((t) => t.name).join('、')}</div>}
                  </td>
                  <td><Pill tone={m.status === 'ready' ? 'passed' : m.status === 'error' ? 'failed' : 'draft'}>{m.status}</Pill></td>
                  <td><AsyncButton kind={m.config.enabled ? 'ghost' : 'secondary'} onClick={() => toggle(m.name, !m.config.enabled)}>{m.config.enabled ? '停用' : '启用'}</AsyncButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card narrow wide">
          <h2>问 Agent</h2>
          <p className="muted small">orchestrator 会列出组件、按需加载 skill、调用 MCP，缺能力时起草组件草稿。</p>
          <textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="例如：我需要一个能校验导出文件内容的组件" />
          <div className="actions">
            <AsyncButton disabled={request.trim() === ''} onClick={ask}>发送</AsyncButton>
            <TokenUsage scopes={['ask']} />
          </div>
          {answer && <pre className="answer">{answer}</pre>}
          <LiveLog scopes={['ask']} title="Agent 过程" />
        </section>
      </div>
      <section className="card">
        <h2>被测项目：登录与流程积木</h2>
        <p className="muted small">登录由 projects/&lt;id&gt;/project.yaml 的 login 配置驱动，执行前自动复用或建立会话；流程积木写在 projects/&lt;id&gt;/flows/，编译 Agent 通过 list_flows 选择。</p>
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>登录</th>
              <th>流程积木</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(({ project, flows }) => (
              <tr key={project.id}>
                <td>
                  <b>{project.name}</b>
                  <div className="muted small mono">{project.baseURL}</div>
                </td>
                <td><LoginStatus project={project} /></td>
                <td>
                  {flows.length === 0
                    ? <span className="muted">无</span>
                    : flows.map((flow) => (
                        <div key={flow.id} className="flow-item">
                          <span className="mono">{flow.id}</span>
                          <span className="muted small"> → {flow.outputs.length === 0 ? '无输出' : flow.outputs.join(', ')}</span>
                          <div className="muted small">{flow.description}</div>
                        </div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>待审批草稿 <span className="muted">{state?.drafts.length ?? 0}</span></h2>
        {state?.drafts.length === 0 && <p className="muted">暂无草稿。</p>}
        {state?.drafts.map((d) => (
          <div key={d.name} className="draft-card">
            <div className="case-head">
              <div>
                <b className="mono">{d.name}</b> <Pill tone="role">{d.kind}</Pill> <span className="muted">{d.description}</span>
              </div>
              <div className="actions">
                <AsyncButton onClick={() => decide(d.name, 'approve')}>批准并加载</AsyncButton>
                <AsyncButton kind="danger" onClick={() => decide(d.name, 'reject')}>拒绝</AsyncButton>
              </div>
            </div>
            <pre>{d.preview}</pre>
          </div>
        ))}
      </section>
    </div>
  )
}
