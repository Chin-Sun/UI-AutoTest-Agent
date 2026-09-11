/**
 * 领域模型。所有落盘对象都在这里定义 zod schema，磁盘是唯一真相源
 * （借鉴 dsh-agent-teams 的 team.json：写入前校验，读出时再校验）。
 */
import { z } from 'zod'

// ---------- Step DSL ----------

export const STEP_ACTIONS = [
  'goto', 'click', 'fill', 'select', 'check', 'uncheck', 'upload', 'press', 'hover', 'waitFor',
  'assertVisible', 'assertHidden', 'assertText', 'assertValue', 'assertUrl', 'assertCount',
  'screenshot',
] as const
export type StepAction = (typeof STEP_ACTIONS)[number]

/** locator 优先级：testId > role > label > placeholder > text > css */
export const TargetSchema = z.union([
  z.object({ testId: z.string().min(1) }),
  z.object({ role: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ label: z.string().min(1) }),
  z.object({ placeholder: z.string().min(1) }),
  z.object({ text: z.string().min(1), exact: z.boolean().optional() }),
  z.object({ css: z.string().min(1) }),
])
export type Target = z.infer<typeof TargetSchema>

export const StepSchema = z.object({
  id: z.string().min(1),
  action: z.enum(STEP_ACTIONS),
  target: TargetSchema.optional(),
  /** goto 的 URL、fill/select 的值、press 的按键、upload 的文件路径；可含 ${data.key} */
  value: z.string().optional(),
  /** 断言期望：assertText/assertValue 为包含文本，assertUrl 为子串或 /regex/，assertCount 为数字 */
  expect: z.string().optional(),
  /** 对应原用例的第几句（0 起），用于前端对照 */
  caseRef: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().positive().optional(),
  note: z.string().optional(),
})
export type Step = z.infer<typeof StepSchema>

// ---------- 用例 / 计划 ----------

export const TestCaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  module: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  /** 自然语言步骤，一句一条 */
  steps: z.array(z.string()).default([]),
  expected: z.array(z.string()).default([]),
  /** 用例级测试数据，Plan 用 ${data.key} 引用；人在门禁里补充的数据也落在这里 */
  data: z.record(z.string(), z.string()).default({}),
  /** 外部来源，如 molardata:02-A1 或 testcases/02-workflow.md:11 */
  source: z.string().optional(),
  notes: z.array(z.string()).default([]),
  version: z.number().int().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type TestCase = z.infer<typeof TestCaseSchema>

export const PLAN_STATUSES = ['draft', 'approved', 'superseded', 'discarded'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const StepPlanSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  version: z.number().int().min(1),
  status: z.enum(PLAN_STATUSES),
  steps: z.array(StepSchema).min(1),
  authRole: z.string().optional(),
  createdBy: z.enum(['agent', 'human']),
  /** 由门禁修正产生时记录来源，形成可追溯的修正链 */
  derivedFrom: z.object({ planId: z.string(), findingId: z.string(), feedbackId: z.string() }).optional(),
  rationale: z.string().optional(),
  createdAt: z.number(),
  approvedAt: z.number().optional(),
})
export type StepPlan = z.infer<typeof StepPlanSchema>

// ---------- 执行 ----------

export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const ERROR_KINDS = ['locator', 'timeout', 'assertion', 'navigation', 'missing-data', 'other'] as const
export type StepErrorKind = (typeof ERROR_KINDS)[number]

export const StepResultSchema = z.object({
  stepId: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().min(0),
  error: z.object({ kind: z.enum(ERROR_KINDS), message: z.string() }).optional(),
  /** 相对 data/ 的证据路径 */
  screenshot: z.string().optional(),
  actual: z.string().optional(),
  ariaSnapshot: z.string().optional(),
})
export type StepResult = z.infer<typeof StepResultSchema>

export const RunSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  projectId: z.string(),
  planId: z.string(),
  planVersion: z.number().int(),
  /** 门禁轮次：人工发起为 1，每经一次门禁重跑 +1 */
  round: z.number().int().min(1),
  /** 单调执行代数 + 能力令牌：重跑/取消使旧 attempt 失效，迟到写入被拒绝 */
  attempt: z.number().int().min(1),
  attemptId: z.string(),
  trigger: z.enum(['manual', 'gate-rerun', 'flaky-retry']),
  status: z.enum(RUN_STATUSES),
  stepResults: z.array(StepResultSchema).default([]),
  error: z.string().optional(),
  evidence: z.object({ video: z.string().optional(), trace: z.string().optional() }).default({}),
  options: z.object({ headed: z.boolean().default(false), obs: z.boolean().default(false) }).default({ headed: false, obs: false }),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
})
export type Run = z.infer<typeof RunSchema>

// ---------- 门禁 ----------

/**
 * step-defect：步骤本身错（定位不到、顺序不对）→ 人指点后修正 Plan
 * data-missing：缺数据/前置 → 人补数据后重跑
 * env-flaky：环境抖动 → 自动重试
 * product-defect：步骤都执行了但结果与预期不符 → 进审阅与报告
 * （与 molardata ledger 的 case-defect / product-defect / env-flaky 对应，case-defect 细分为前两类）
 */
export const VERDICTS = ['step-defect', 'data-missing', 'env-flaky', 'product-defect'] as const
export type Verdict = (typeof VERDICTS)[number]

export const SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const
export type Severity = (typeof SEVERITIES)[number]

export const FINDING_STATUSES = [
  'awaiting_human', // 门禁：等人补充步骤或数据
  'awaiting_review', // 审阅：疑似产品缺陷，等人确认
  'repairing', // Agent 正在按反馈修正 Plan（或新 Plan 等人批准）
  'rerunning', // 已排队重跑
  'resolved', // 重跑通过
  'confirmed', // 人确认为产品缺陷，进报告
  'dismissed', // 人判定无需处理
  'escalated', // 超过最大轮次，停止自动循环，等人决定
] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const FindingSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  projectId: z.string(),
  runId: z.string(),
  planId: z.string(),
  stepId: z.string().optional(),
  verdict: z.enum(VERDICTS),
  severity: z.enum(SEVERITIES),
  summary: z.string().min(1),
  expected: z.string().optional(),
  actual: z.string().optional(),
  evidence: z.object({ screenshot: z.string().optional(), video: z.string().optional(), trace: z.string().optional() }).default({}),
  /** Agent 的修正建议，给人参考 */
  suggestion: z.string().optional(),
  /** 缺数据时列出缺少的 key */
  missingKeys: z.array(z.string()).optional(),
  triagedBy: z.enum(['agent', 'rule', 'human']),
  status: z.enum(FINDING_STATUSES),
  round: z.number().int().min(1),
  feedbackIds: z.array(z.string()).default([]),
  /** 同一用例后续失败产生了新 Finding 时，旧的指向新的并关闭 */
  supersededBy: z.string().optional(),
  /** 修正失败等最近一次错误，展示给人 */
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Finding = z.infer<typeof FindingSchema>

export const FEEDBACK_KINDS = ['fix-step', 'supply-data', 'confirm-defect', 'not-a-defect', 'dismiss'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FeedbackSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  kind: z.enum(FEEDBACK_KINDS),
  /** 人的文字指点，repairer 据此修正 */
  content: z.string().default(''),
  /** 人在前端直接改的步骤（结构化，优先于文字） */
  stepPatches: z.array(z.object({ stepId: z.string(), patch: StepSchema.partial().omit({ id: true }) })).optional(),
  dataPatch: z.record(z.string(), z.string()).optional(),
  createdAt: z.number(),
})
export type Feedback = z.infer<typeof FeedbackSchema>

// ---------- 报告 / 项目 / 策略 ----------

export const ReportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(['draft', 'final']),
  blockers: z.array(z.string()),
  summary: z.object({ cases: z.number(), passed: z.number(), failed: z.number(), defects: z.number(), open: z.number() }),
  narrative: z.string().optional(),
  html: z.string(),
  createdAt: z.number(),
})
export type Report = z.infer<typeof ReportSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseURL: z.string(),
  /** 角色 → Playwright storageState 路径 */
  authRoles: z.record(z.string(), z.string()).default({}),
  defaultAuthRole: z.string().optional(),
  slowMo: z.number().int().min(0).default(0),
  viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1280, height: 800 }),
  /** 注入给 compiler 的项目知识 skill 名 */
  knowledgeSkills: z.array(z.string()).default([]),
  importers: z.record(z.string(), z.string()).default({}),
})
export type Project = z.infer<typeof ProjectSchema>

export interface GatePolicy {
  /** 同一用例超过此轮次后升级，不再自动推进 */
  maxRounds: number
  /** env-flaky 自动重试次数（同一 Plan 版本内） */
  flakyRetries: number
}

export const DEFAULT_POLICY: GatePolicy = { maxRounds: 3, flakyRetries: 1 }
