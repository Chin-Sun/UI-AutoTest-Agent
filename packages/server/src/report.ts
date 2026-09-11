import type { Finding, Project, Report, Run, StepPlan, TestCase } from '@uta/core'

const escape = (text: string | undefined) => (text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const STATUS: Record<string, string> = { passed: '通过', failed: '未通过', cancelled: '已取消', queued: '排队中', running: '执行中' }
const FINDING: Record<string, string> = {
  awaiting_human: '门禁待补充', awaiting_review: '待审阅', repairing: '修正中', rerunning: '重跑中',
  escalated: '已升级', confirmed: '已确认缺陷', dismissed: '已驳回', resolved: '已解决',
}

export interface ReportRow {
  testCase: TestCase
  run?: Run
  plan?: StepPlan
}

/** 生成自包含 HTML 报告；证据路径相对 data/，报告文件位于 data/report-html/ */
export function renderReport(input: {
  project: Project
  report: Omit<Report, 'html'>
  rows: ReportRow[]
  defects: Finding[]
  open: Finding[]
}): string {
  const { project, report, rows, defects, open } = input
  const file = (path?: string) => (path === undefined ? '' : `../${path}`)
  const titleOf = (caseId: string) => rows.find((row) => row.testCase.id === caseId)?.testCase.title
  const defectCards = defects.map((finding) => `
    <article class="defect">
      <h3>${escape(titleOf(finding.caseId))}</h3>
      <p>${escape(finding.summary)}</p>
      <dl><dt>预期</dt><dd>${escape(finding.expected)}</dd><dt>实际</dt><dd>${escape(finding.actual)}</dd>
      <dt>严重度</dt><dd>${finding.severity}</dd><dt>轮次</dt><dd>${finding.round}</dd></dl>
      ${finding.evidence.screenshot === undefined ? '' : `<img src="${file(finding.evidence.screenshot)}" alt="失败截图">`}
      <p>${finding.evidence.video === undefined ? '' : `<a href="${file(finding.evidence.video)}">录像</a>`}
      ${finding.evidence.trace === undefined ? '' : ` · <a href="${file(finding.evidence.trace)}">trace</a>（npx playwright show-trace）`}</p>
    </article>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(project.name)} 测试报告</title>
<style>
body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 24px;color:#1d2330;background:#f7f8fa}
main{max-width:980px;margin:auto}h1{margin:0 0 4px}.meta{color:#667}
.status{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600}
.final{background:#ddf5e4;color:#17692f}.draft{background:#fff1d6;color:#8a5a00}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:20px 0}
.kpi{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px #0001}.kpi b{display:block;font-size:26px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0001}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eef0f3}th{background:#f1f3f6}
.defect{background:#fff;border-left:4px solid #d93a3a;border-radius:8px;padding:12px 18px;margin:14px 0;box-shadow:0 1px 3px #0001}
.defect img{max-width:100%;border:1px solid #e3e6eb;border-radius:6px}dl{display:grid;grid-template-columns:70px 1fr;margin:0}dt{color:#667}dd{margin:0}
</style></head><body><main>
<h1>${escape(project.name)} · UI 测试报告</h1>
<p class="meta">${new Date(report.createdAt).toLocaleString('zh-CN')} · <span class="status ${report.status}">${report.status === 'final' ? '定稿' : '草稿（仍有待处理项）'}</span></p>
${report.narrative === undefined ? '' : `<p>${escape(report.narrative)}</p>`}
<section class="kpis">
<div class="kpi">用例<b>${report.summary.cases}</b></div><div class="kpi">通过<b>${report.summary.passed}</b></div>
<div class="kpi">未通过<b>${report.summary.failed}</b></div><div class="kpi">确认缺陷<b>${report.summary.defects}</b></div>
<div class="kpi">待处理<b>${report.summary.open}</b></div></section>
${report.blockers.length === 0 ? '' : `<h2>定稿阻塞项</h2><ul>${report.blockers.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>`}
<h2>与预期不符（已确认缺陷）</h2>${defectCards || '<p>无</p>'}
<h2>用例结果</h2>
<table><thead><tr><th>用例</th><th>模块</th><th>计划</th><th>轮次</th><th>结果</th></tr></thead><tbody>
${rows.map(({ testCase, run, plan }) => `<tr><td>${escape(testCase.title)}</td><td>${escape(testCase.module)}</td><td>${plan === undefined ? '—' : `v${plan.version}`}</td><td>${run?.round ?? '—'}</td><td>${run === undefined ? '未执行' : STATUS[run.status]}</td></tr>`).join('')}
</tbody></table>
${open.length === 0 ? '' : `<h2>待处理门禁</h2><table><thead><tr><th>用例</th><th>类型</th><th>状态</th><th>说明</th></tr></thead><tbody>
${open.map((finding) => `<tr><td>${escape(rows.find((row) => row.testCase.id === finding.caseId)?.testCase.title)}</td><td>${finding.verdict}</td><td>${FINDING[finding.status]}</td><td>${escape(finding.summary)}</td></tr>`).join('')}
</tbody></table>`}
</main></body></html>`
}
