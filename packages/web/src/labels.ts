import type { Step, Target } from '@uta/core'

export const ACTION_LABEL: Record<Step['action'], string> = {
  goto: '打开', click: '点击', fill: '输入', select: '选择', check: '勾选', uncheck: '取消勾选', upload: '上传',
  press: '按键', hover: '悬停', waitFor: '等待', assertVisible: '断言可见', assertHidden: '断言不可见',
  assertText: '断言文本', assertValue: '断言值', assertUrl: '断言 URL', assertCount: '断言数量', screenshot: '截图',
}

export const VERDICT_LABEL: Record<string, string> = {
  'step-defect': '步骤错误', 'data-missing': '缺少数据', 'env-flaky': '环境抖动', 'product-defect': '产品缺陷',
}

export const FINDING_STATUS_LABEL: Record<string, string> = {
  awaiting_human: '等待补充', awaiting_review: '待审阅', repairing: '修正中', rerunning: '重跑中',
  resolved: '已解决', confirmed: '已确认缺陷', dismissed: '已关闭', escalated: '已升级',
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '执行中', passed: '通过', failed: '未通过', cancelled: '已取消',
}

export const PLAN_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', approved: '已批准', superseded: '已替代', discarded: '已丢弃',
}

export const TRIGGER_LABEL: Record<string, string> = { manual: '手动', 'gate-rerun': '门禁重跑', 'flaky-retry': '抖动重试' }

export function targetLabel(target: Target | undefined): string {
  if (target === undefined) return ''
  if ('role' in target) return `${target.role}「${target.name ?? ''}」`
  if ('testId' in target) return `testId=${target.testId}`
  if ('label' in target) return `标签「${target.label}」`
  if ('placeholder' in target) return `占位「${target.placeholder}」`
  if ('text' in target) return `文本「${target.text}」`
  return `css ${target.css}`
}

export function time(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
