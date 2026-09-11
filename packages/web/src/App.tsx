import { useCallback, useEffect, useState } from 'react'
import { api, useReload, type Finding, type Project } from './api'
import { CasesPage } from './pages/Cases'
import { PlansPage } from './pages/Plans'
import { RunPage } from './pages/Run'
import { GatePage } from './pages/Gate'
import { ReviewPage } from './pages/Review'
import { ComponentsPage } from './pages/Components'

export type PageId = 'cases' | 'plans' | 'run' | 'gate' | 'review' | 'components'
export type Go = (page: PageId, param?: string) => void

const NAV: { id: PageId; label: string; hint: string }[] = [
  { id: 'cases', label: '① 用例录入', hint: '录入 / 导入测试用例' },
  { id: 'plans', label: '② 步骤编译', hint: '用例 → Playwright 步骤，人工审批' },
  { id: 'run', label: '③ 执行直播', hint: '执行并实时观看' },
  { id: 'gate', label: '④ 失败门禁', hint: '补充步骤或数据后重跑' },
  { id: 'review', label: '⑤ 结果审阅', hint: '确认与预期不符的结果、生成报告' },
  { id: 'components', label: '⑥ 组件中心', hint: 'Skill / MCP / Agent' },
]

function parseHash(): { page: PageId; param?: string } {
  const [page, param] = location.hash.replace(/^#\/?/, '').split('/')
  return { page: NAV.some((item) => item.id === page) ? page as PageId : 'cases', ...(param ? { param: decodeURIComponent(param) } : {}) }
}

export function App() {
  const [route, setRoute] = useState(parseHash)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(() => localStorage.getItem('uta.project') ?? 'demo')
  const [llm, setLlm] = useState<Record<string, string>>({})
  const [findings, setFindings] = useState<Finding[]>([])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    void api<Project[]>('/api/projects').then(setProjects)
    void api<{ llm: Record<string, string> }>('/api/health').then((health) => setLlm(health.llm))
  }, [])
  const loadFindings = useCallback(() => { void api<Finding[]>(`/api/findings?projectId=${projectId}`).then(setFindings) }, [projectId])
  useEffect(loadFindings, [loadFindings])
  useReload(['finding'], loadFindings)

  const go: Go = (page, param) => { location.hash = `#/${page}${param ? `/${encodeURIComponent(param)}` : ''}` }
  const selectProject = (id: string) => {
    localStorage.setItem('uta.project', id)
    setProjectId(id)
  }
  const badges: Partial<Record<PageId, number>> = {
    gate: findings.filter((f) => ['awaiting_human', 'escalated', 'repairing', 'rerunning'].includes(f.status)).length,
    review: findings.filter((f) => f.status === 'awaiting_review').length,
  }
  const page = route.page

  return (
    <div className="shell">
      <aside>
        <div className="brand">UI Test Agent</div>
        <select value={projectId} onChange={(event) => selectProject(event.target.value)} aria-label="项目">
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <nav>
          {NAV.map((item) => (
            <a key={item.id} href={`#/${item.id}`} className={page === item.id ? 'active' : ''} title={item.hint}>
              {item.label}
              {(badges[item.id] ?? 0) > 0 && <span className="badge">{badges[item.id]}</span>}
            </a>
          ))}
        </nav>
        <div className="llm" title="config/llm.yaml">
          <b>LLM</b>
          {Object.entries(llm).map(([role, provider]) => <div key={role}><span>{role}</span>{provider}</div>)}
        </div>
      </aside>
      <main key={projectId}>
        {page === 'cases' && <CasesPage projectId={projectId} project={projects.find((p) => p.id === projectId)} go={go} />}
        {page === 'plans' && <PlansPage projectId={projectId} caseId={route.param} go={go} />}
        {page === 'run' && <RunPage projectId={projectId} runId={route.param} go={go} />}
        {page === 'gate' && <GatePage projectId={projectId} findings={findings} go={go} />}
        {page === 'review' && <ReviewPage projectId={projectId} findings={findings} go={go} />}
        {page === 'components' && <ComponentsPage />}
      </main>
    </div>
  )
}
