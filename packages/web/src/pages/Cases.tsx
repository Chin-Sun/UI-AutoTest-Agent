import { useCallback, useEffect, useState } from 'react'
import { api, useReload, type Project, type StepPlan, type TestCase } from '../api'
import { AsyncButton, ErrorLine, Pill } from '../components'
import { formatDataLines, lines, parseDataLines } from '../format'
import { PLAN_STATUS_LABEL } from '../labels'
import type { Go } from '../App'

interface Draft {
  id?: string
  title: string
  module: string
  preconditions: string
  steps: string
  expected: string
  data: string
  notes: string
}

const EMPTY: Draft = { title: '', module: '', preconditions: '', steps: '', expected: '', data: '', notes: '' }

function toDraft(testCase: TestCase): Draft {
  return {
    id: testCase.id, title: testCase.title, module: testCase.module ?? '', preconditions: testCase.preconditions.join('\n'),
    steps: testCase.steps.join('\n'), expected: testCase.expected.join('\n'),
    data: formatDataLines(testCase.data), notes: testCase.notes.join('\n'),
  }
}

export function CasesPage({ projectId, project, go }: { projectId: string, project?: Project, go: Go }) {
  const [cases, setCases] = useState<TestCase[]>([])
  const [plans, setPlans] = useState<Record<string, StepPlan[]>>({})
  const [draft, setDraft] = useState<Draft>(EMPTY)

  // 加载只取数据；状态在异步回调里设置（effect 内不同步 setState）
  const fetchAll = useCallback(async () => {
    const list = await api<TestCase[]>(`/api/cases?projectId=${projectId}`)
    const entries = await Promise.all(list.map(async (c) => [c.id, await api<StepPlan[]>(`/api/cases/${c.id}/plans`)] as const))
    return { list, byCase: Object.fromEntries(entries) }
  }, [projectId])
  const apply = useCallback(({ list, byCase }: { list: TestCase[], byCase: Record<string, StepPlan[]> }) => {
    setCases(list)
    setPlans(byCase)
  }, [])
  useEffect(() => {
    void fetchAll().then(apply)
  }, [fetchAll, apply])
  useReload(['case', 'plan'], () => void fetchAll().then(apply))

  const save = async () => {
    const body = {
      projectId, title: draft.title, module: draft.module || undefined, preconditions: lines(draft.preconditions),
      steps: lines(draft.steps), expected: lines(draft.expected), notes: lines(draft.notes),
      data: parseDataLines(draft.data),
    }
    if (draft.id === undefined) await api('/api/cases', { body })
    else await api(`/api/cases/${draft.id}`, { method: 'PUT', body })
    setDraft(EMPTY)
  }
  const field = (key: keyof Draft, label: string, rows = 0, placeholder = '') => (
    <label>
      {label}
      {rows === 0
        ? <input value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} placeholder={placeholder} />
        : <textarea rows={rows} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} placeholder={placeholder} />}
    </label>
  )

  return (
    <div className="page">
      <header>
        <h1>用例录入</h1>
        <p>自然语言写用例，一句一行。用「」标出页面上的文字，数据用 <code>{'${data.key}'}</code> 引用。</p>
      </header>
      <div className="split">
        <section className="card">
          <h2>{draft.id === undefined ? '新建用例' : '编辑用例'}</h2>
          <div className="form">
            {field('title', '标题')}
            {field('module', '模块')}
            {field('preconditions', '前置条件', 2)}
            {field('steps', '操作步骤（一行一句）', 6, '打开「login.html」\n在「用户名」输入「alice」\n点击「登录」按钮')}
            {field('expected', '预期结果（一行一句）', 3, '页面显示「欢迎，alice」')}
            {field('data', '测试数据（key=value，一行一个）', 2, 'vipCode=VIP-2026')}
            {field('notes', '备注', 2)}
          </div>
          <div className="actions">
            <AsyncButton onClick={save} disabled={draft.title === ''}>{draft.id === undefined ? '创建' : '保存（版本 +1）'}</AsyncButton>
            {draft.id !== undefined && <button className="ghost" onClick={() => setDraft(EMPTY)}>取消</button>}
          </div>
        </section>
        <section className="card grow">
          <h2>用例列表 <span className="muted">{cases.length}</span></h2>
          <table>
            <thead><tr><th>标题</th><th>模块</th><th>步骤</th><th>数据</th><th>计划</th><th /></tr></thead>
            <tbody>
              {cases.map((testCase) => {
                const latest = plans[testCase.id]?.find((plan) => plan.status === 'approved' || plan.status === 'draft')
                return (
                  <tr key={testCase.id}>
                    <td>
                      <button type="button" className="linklike" onClick={() => setDraft(toDraft(testCase))}>{testCase.title}</button>
                      <div className="muted small">v{testCase.version}{testCase.source ? ` · ${testCase.source}` : ''}</div>
                    </td>
                    <td>{testCase.module}</td>
                    <td>{testCase.steps.length} / {testCase.expected.length}</td>
                    <td className="small">{Object.keys(testCase.data).join(', ') || '—'}</td>
                    <td>{latest ? <Pill tone={latest.status}>v{latest.version} {PLAN_STATUS_LABEL[latest.status]}</Pill> : <span className="muted">未编译</span>}</td>
                    <td><button className="ghost" onClick={() => go('plans', testCase.id)}>编译 →</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>
      {project?.importers['checklistDir'] !== undefined && <ChecklistImporter projectId={projectId} />}
    </div>
  )
}

interface ChecklistItem { key: string, section: string, title: string }

function ChecklistImporter({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<{ file: string, count: number }[]>([])
  const [file, setFile] = useState('')
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<string>()

  useEffect(() => {
    api<{ file: string, count: number }[]>(`/api/importers/${projectId}/checklists`).then(setFiles, (e: Error) => setError(e.message))
  }, [projectId])
  useEffect(() => {
    if (file !== '') api<ChecklistItem[]>(`/api/importers/${projectId}/checklists/${file}`).then(setItems, (e: Error) => setError(e.message))
  }, [projectId, file])

  const chooseFile = (next: string) => {
    setFile(next)
    setItems([])
    setPicked(new Set())
  }

  return (
    <section className="card">
      <h2>从功能点清单导入</h2>
      <ErrorLine error={error} />
      <div className="actions">
        <select value={file} onChange={(e) => chooseFile(e.target.value)} aria-label="清单文件">
          <option value="">选择清单文件…</option>
          {files.map((f) => <option key={f.file} value={f.file}>{f.file}（{f.count} 条）</option>)}
        </select>
        <AsyncButton
          disabled={picked.size === 0}
          onClick={async () => {
            const r = await api<{ created: number, skipped: number }>(`/api/importers/${projectId}/checklists`, { body: { file, keys: [...picked] } })
            setResult(`已导入 ${r.created} 条，跳过重复 ${r.skipped} 条`)
          }}
        >
          导入所选（{picked.size}）
        </AsyncButton>
        {result && <span className="ok">{result}</span>}
      </div>
      <div className="checklist">
        {items.map((item) => (
          <label key={item.key} className="check">
            <input
              type="checkbox"
              checked={picked.has(item.key)}
              onChange={(e) => {
                const next = new Set(picked)
                if (e.target.checked) next.add(item.key)
                else next.delete(item.key)
                setPicked(next)
              }}
            />
            <span className="mono">{item.key}</span> {item.title}
          </label>
        ))}
      </div>
    </section>
  )
}
