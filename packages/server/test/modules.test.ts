/** server 的小模块：导入器、项目加载、报告渲染、事件总线 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Finding, TestCase } from '@uta/core'
import { Bus } from '../src/bus'
import { checklistContext, listChecklists, parseChecklist, readChecklist } from '../src/importers'
import { expandEnv, loadProjects, parseEnvFile } from '../src/projects'
import { renderReport } from '../src/report'
import { demoProject, REPO } from './support'

const checklists = fileURLToPath(new URL('./fixtures/checklists/', import.meta.url))

describe('importers', () => {
  it('按章节解析带编号的条目：主键=文件号-编号，去掉加粗，[x] 也算，行号从 1 开始', () => {
    expect(parseChecklist('## A. 节\n- [ ] **A1** 第**一**条\n- [x] **B-2** 第二条\n- 普通列表\n### 子节\n  - [ ] **C3** 缩进', '02')).toEqual([
      { key: '02-A1', section: 'A. 节', title: '第一条', line: 2 },
      { key: '02-B-2', section: 'A. 节', title: '第二条', line: 3 },
      { key: '02-C3', section: '子节', title: '缩进', line: 6 },
    ])
  })

  it('列出清单文件及条数；目录不存在返回空', async () => {
    expect(await listChecklists(checklists)).toEqual([{ file: '01-import.md', count: 1 }, { file: '02-workflow.md', count: 3 }])
    expect(await listChecklists(join(checklists, 'nope'))).toEqual([])
  })

  it('读取清单；非法文件名以 400 拒绝（防目录穿越）', async () => {
    expect((await readChecklist(checklists, '02-workflow.md')).map((item) => item.key)).toEqual(['02-A1', '02-A2', '02-D1'])
    await expect(readChecklist(checklists, '../secret.md')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('清单上下文：文件头、章节、同章节其他条目；找不到时返回 undefined', async () => {
    expect(await checklistContext(checklists, '02-A1')).toEqual({
      file: '02-workflow.md',
      fileHeader: '# 02 · 动态工作流（测试夹具）',
      section: 'A. 节点类型与内置节点',
      item: '02-A1 新建任务默认包含「原始数据」与「合格数据」两个节点，且不可删除',
      siblings: ['02-A2 「标注」节点不可删除'],
    })
    expect((await checklistContext(checklists, '02-D1'))?.siblings).toEqual([])
    expect(await checklistContext(checklists, '02-Z9')).toBeUndefined()
    expect(await checklistContext(checklists, '09-A1')).toBeUndefined()
    expect(await checklistContext(checklists, 'A1')).toBeUndefined()
    expect(await checklistContext(join(checklists, 'nope'), '02-A1')).toBeUndefined()
  })

  it('真实 molardata 清单格式可解析（目录存在时）', async () => {
    const real = join(REPO, '../MolarTest/AutoTest/testcases')
    const files = await listChecklists(real)
    if (files.length === 0) return
    expect(files.every((file) => file.count > 0)).toBe(true)
  })
})

describe('projects', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('展开 ${VAR} 与 ${VAR:-默认值}；空值取默认值', () => {
    const env = { A: '1', EMPTY: '' }
    expect(expandEnv('${A}-${B:-2}-${EMPTY:-3}-${MISSING}', env)).toBe('1-2-3-')
    expect(expandEnv('无变量', env)).toBe('无变量')
  })

  it('加载 project.yaml：相对路径按仓库根解析，绝对路径保留；没有 project.yaml 的目录跳过', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uta-projects-'))
    await mkdir(join(dir, 'p1'))
    await mkdir(join(dir, 'empty'))
    await writeFile(join(dir, 'p1', 'project.yaml'), [
      'id: p1', 'name: P1', 'baseURL: http://localhost:${UTA_PORT:-1}/', 'authRoles:', '  admin: auth/admin.json', '  abs: /abs/a.json',
      'importers:', '  checklistDir: lists', 'actionTimeoutMs: 1500',
    ].join('\n'))
    const projects = await loadProjects(dir, '/repo', { UTA_PORT: '9999' })
    expect([...projects.keys()]).toEqual(['p1'])
    expect(projects.get('p1')).toMatchObject({
      baseURL: 'http://localhost:9999/', authRoles: { admin: '/repo/auth/admin.json', abs: '/abs/a.json' },
      importers: { checklistDir: '/repo/lists' }, actionTimeoutMs: 1500,
    })
  })

  it('parseEnvFile：跳过注释与非法行，支持 export、引号、行尾注释与空值', () => {
    expect(parseEnvFile('# 注释\nexport A=1\nB="x # y"\nC=2   # 说明\nD=\nE=   # 只有注释\n不是变量\r\nF=a=b\n'))
      .toEqual({ A: '1', B: 'x # y', C: '2', D: '', E: '', F: 'a=b' })
  })

  it('test-data.yaml：值从 envFile 展开（非空环境变量优先）；path 条目按仓库根解析；envFile 里未登记的变量不进入项目配置', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uta-projects-'))
    await mkdir(join(dir, 'p1'))
    await mkdir(join(dir, 'p2'))
    await writeFile(join(dir, 'e2e.env'), 'TASK_ID_X=42 # 图像任务\nOVERRIDE=from-file\nBLANK=from-file\nADMIN_PASSWORD=hunter2\n')
    await writeFile(join(dir, 'p1', 'project.yaml'), ['id: p1', 'name: P1', 'baseURL: http://x/', `envFile: ${join(dir, 'e2e.env')}`].join('\n'))
    await writeFile(join(dir, 'p1', 'test-data.yaml'), [
      'entries:',
      '  - { key: task.x, description: 任务, value: "${TASK_ID_X}", tags: [task] }',
      '  - { key: over, value: "${OVERRIDE}" }',
      '  - { key: blank, value: "${BLANK}" }',
      '  - { key: unset, value: "${NOPE}" }',
      '  - { key: file.a, value: data/a, tags: [file, path] }',
    ].join('\n'))
    await writeFile(join(dir, 'p2', 'project.yaml'), ['id: p2', 'name: P2', 'baseURL: http://x/', 'envFile: missing.env'].join('\n'))
    const projects = await loadProjects(dir, '/repo', { OVERRIDE: 'from-env', BLANK: '' })
    const p1 = projects.get('p1')!
    expect(p1.testData).toEqual([
      { key: 'task.x', description: '任务', value: '42', tags: ['task'] },
      { key: 'over', description: '', value: 'from-env', tags: [] },
      { key: 'blank', description: '', value: 'from-file', tags: [] },
      { key: 'unset', description: '', value: '', tags: [] },
      { key: 'file.a', description: '', value: '/repo/data/a', tags: ['file', 'path'] },
    ])
    expect(JSON.stringify(p1)).not.toContain('hunter2')
    expect(projects.get('p2')).toMatchObject({ envFile: '/repo/missing.env', testData: [] })
  })

  it('配置不合法时报错', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uta-projects-'))
    await mkdir(join(dir, 'bad'))
    await writeFile(join(dir, 'bad', 'project.yaml'), 'id: bad\n')
    await expect(loadProjects(dir, '/repo', {})).rejects.toThrow()
  })

  it('仓库自带的 demo 与 molardata 项目可加载', async () => {
    const projects = await loadProjects(join(REPO, 'projects'), REPO, { UTA_PORT: '4999' })
    expect(projects.get('demo')?.baseURL).toBe('http://localhost:4999/demo/')
    expect(projects.get('molardata')).toMatchObject({ defaultAuthRole: 'admin', knowledgeSkills: ['molar-platform'] })
    const catalog = projects.get('molardata')!.testData
    expect(catalog.map((item) => item.key)).toEqual(expect.arrayContaining(['task.iat', 'account.admin', 'file.images.whitelist']))
    for (const item of catalog.filter((candidate) => candidate.tags.includes('path'))) expect(item.value).toMatch(/^\//)
  })
})

describe('renderReport', () => {
  const testCase = (id: string, title: string): TestCase => ({ id, projectId: 'demo', title, preconditions: [], steps: [], expected: [], data: {}, notes: [], version: 1, createdAt: 0, updatedAt: 0, module: '模块' })
  const finding = (patch: Partial<Finding>): Finding => ({
    id: 'f1', caseId: 'c1', projectId: 'demo', runId: 'r1', planId: 'p1', verdict: 'product-defect', severity: 'high', summary: '期望「A」', expected: 'A', actual: 'B',
    evidence: { screenshot: 'evidence/r1/1.png', video: 'evidence/r1/video.webm', trace: 'evidence/r1/trace.zip' }, triagedBy: 'rule', status: 'confirmed', round: 1, feedbackIds: [], createdAt: 0, updatedAt: 0, ...patch,
  })
  const meta = { id: 'report_1', projectId: 'demo', status: 'final' as const, blockers: [], summary: { cases: 2, passed: 1, failed: 1, defects: 1, open: 0 }, createdAt: 0 }

  it('缺陷卡片含用例标题、预期/实际、相对证据链接；表格列出每条用例结果', () => {
    const html = renderReport({ project: demoProject(), report: meta, rows: [{ testCase: testCase('c1', '计数') }, { testCase: testCase('c2', '登录') }], defects: [finding({})], open: [] })
    expect(html).toContain('<h3>计数</h3>')
    expect(html).toContain('src="../evidence/r1/1.png"')
    expect(html).toContain('href="../evidence/r1/trace.zip"')
    expect(html).toContain('定稿')
    expect(html).toContain('未执行')
    expect(html).not.toContain('待处理门禁')
  })

  it('草稿显示阻塞项与待处理表；所有用户文本都做 HTML 转义', () => {
    const html = renderReport({
      project: { ...demoProject(), name: '<script>alert(1)</script>' },
      report: { ...meta, status: 'draft', blockers: ['f2: <b>未审阅</b>'], narrative: 'a & b' },
      rows: [{ testCase: testCase('c1', '"引号" <i>') }],
      defects: [],
      open: [finding({ id: 'f2', status: 'awaiting_review', summary: '<img onerror=x>' })],
    })
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;b&gt;未审阅&lt;/b&gt;')
    expect(html).toContain('a &amp; b')
    expect(html).toContain('&quot;引号&quot; &lt;i&gt;')
    expect(html).toContain('草稿（仍有待处理项）')
    expect(html).toContain('待审阅')
  })
})

describe('Bus', () => {
  it('广播给所有订阅者；退订后不再收到；单个订阅者抛错不影响其他订阅者', () => {
    const bus = new Bus()
    const a = vi.fn(() => { throw new Error('坏订阅者') })
    const b = vi.fn()
    const off = bus.on(a)
    bus.on(b)
    bus.emit({ type: 'log', scope: 's', message: 'm', ts: 1 })
    off()
    bus.emit({ type: 'log', scope: 's', message: 'm2', ts: 2 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })
})
