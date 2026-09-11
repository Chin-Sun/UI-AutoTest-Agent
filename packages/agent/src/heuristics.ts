/**
 * 规则引擎：mock 适配器的“大脑”，也是 LLM 不可用时的确定性基线。
 * 只理解规范写法的中文用例（「」标出页面文字），自由文本需要真实 LLM。
 */
import {
  applyStepPatches, heuristicVerdict, isAssertion,
  type Feedback, type Finding, type Severity, type Step, type StepResult, type Target, type Verdict,
} from '@uta/core'

const Q = '[「“"]([^」”"]+)[」”"]'
const re = (source: string) => new RegExp(source)
type Draft = Omit<Step, 'id' | 'caseRef'>

const CLICK_ROLES: Record<string, string> = { 链接: 'link', 标签页: 'tab', 菜单项: 'menuitem', 复选框: 'checkbox' }

const ACTION_RULES: { test: RegExp; build: (m: RegExpMatchArray) => Draft }[] = [
  { test: re(`^(?:打开|访问|进入)\\s*${Q}`), build: (m) => ({ action: 'goto', value: m[1]! }) },
  { test: re(`^(?:在\\s*)?${Q}\\s*(?:中|里|框|输入框)?\\s*(?:输入|填写|填入)\\s*${Q}`), build: (m) => ({ action: 'fill', target: { label: m[1]! }, value: m[2]! }) },
  { test: re(`(?:选择|选中)\\s*${Q}\\s*为\\s*${Q}`), build: (m) => ({ action: 'select', target: { label: m[1]! }, value: m[2]! }) },
  { test: re(`^取消勾选\\s*${Q}`), build: (m) => ({ action: 'uncheck', target: { label: m[1]! } }) },
  { test: re(`^勾选\\s*${Q}`), build: (m) => ({ action: 'check', target: { label: m[1]! } }) },
  { test: re(`^上传\\s*${Q}\\s*到\\s*${Q}`), build: (m) => ({ action: 'upload', target: { label: m[2]! }, value: m[1]! }) },
  {
    test: re(`^(?:点击|单击)\\s*${Q}\\s*(按钮|链接|标签页|菜单项|复选框)?`),
    build: (m) => ({ action: 'click', target: { role: CLICK_ROLES[m[2] ?? ''] ?? 'button', name: m[1]! } }),
  },
  { test: /^按下?\s*[「“"]?(Enter|Tab|Escape|回车)[」”"]?/, build: (m) => ({ action: 'press', value: m[1] === '回车' ? 'Enter' : m[1]! }) },
  { test: /^等待\s*(\d+)\s*(毫秒|ms|秒)/, build: (m) => ({ action: 'waitFor', value: String(Number(m[1]) * (m[2] === '秒' ? 1000 : 1)) }) },
]

const EXPECT_RULES: { test: RegExp; build: (m: RegExpMatchArray) => Draft }[] = [
  { test: re(`(?:URL|网址|地址)\\s*(?:包含|为|是)\\s*${Q}`), build: (m) => ({ action: 'assertUrl', expect: m[1]! }) },
  { test: re(`${Q}\\s*的值(?:为|是)\\s*${Q}`), build: (m) => ({ action: 'assertValue', target: { label: m[1]! }, expect: m[2]! }) },
  { test: re(`(?:不显示|不再显示|不出现)\\s*${Q}`), build: (m) => ({ action: 'assertHidden', target: { text: m[1]! } }) },
  { test: re(`${Q}\\s*消失`), build: (m) => ({ action: 'assertHidden', target: { text: m[1]! } }) },
  { test: re(`(?:显示|出现|看到|提示)\\s*${Q}`), build: (m) => ({ action: 'assertVisible', target: { text: m[1]! } }) },
]

function match(sentence: string, rules: typeof ACTION_RULES): Draft | undefined {
  for (const rule of rules) {
    const m = sentence.trim().match(rule.test)
    if (m !== null) return rule.build(m)
  }
  return undefined
}

export function heuristicCompile(testCase: { steps: string[]; expected: string[] }): { steps: Step[]; rationale: string; unparsed: string[] } {
  const steps: Step[] = []
  const unparsed: string[] = []
  const sentences = [
    ...testCase.steps.map((text) => ({ text, expected: false })),
    ...testCase.expected.map((text) => ({ text, expected: true })),
  ]
  sentences.forEach(({ text, expected }, caseRef) => {
    const draft = expected
      ? match(text, EXPECT_RULES) ?? match(text, ACTION_RULES)
      : match(text, ACTION_RULES) ?? match(text, EXPECT_RULES)
    if (draft === undefined) unparsed.push(text)
    else steps.push({ id: `s${steps.length + 1}`, ...draft, caseRef })
  })
  const rationale = unparsed.length === 0
    ? '规则引擎按「」标注逐句编译'
    : `规则引擎无法理解 ${unparsed.length} 句（${unparsed.join('；')}），请改写为规范句式或配置真实 LLM`
  return { steps, rationale, unparsed }
}

// ---------- 归因 ----------

export interface TriageInput {
  caseTitle: string
  steps: readonly Step[]
  failedStepId: string
  result: StepResult
}

export interface TriageOutput {
  verdict: Verdict
  severity: Severity
  summary: string
  expected?: string
  actual?: string
  suggestion?: string
  missingKeys?: string[]
}

function targetText(target: Target | undefined): string | undefined {
  if (target === undefined) return undefined
  if ('name' in target && target.name !== undefined) return target.name
  if ('text' in target) return target.text
  if ('label' in target) return target.label
  if ('placeholder' in target) return target.placeholder
  if ('testId' in target) return target.testId
  if ('css' in target) return target.css
  return undefined
}

/** 从 ARIA 快照里找出同类控件的可访问名称，作为给人的修正候选 */
export function ariaCandidates(aria: string | undefined, role: string): string[] {
  if (aria === undefined) return []
  return [...new Set([...aria.matchAll(new RegExp(`- ${role} "([^"]+)"`, 'g'))].map((m) => m[1]!))]
}

function nearbyText(aria: string | undefined, expected: string): string | undefined {
  if (aria === undefined || expected === '') return undefined
  const head = expected.slice(0, 1)
  const lines = aria.split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').replace(/^[a-z]+(?: "[^"]*")?:\s*/, '').trim())
    .filter((line) => line.includes(head) && !line.includes(expected))
  return lines.length === 0 ? undefined : lines.slice(0, 2).join(' / ')
}

export function heuristicTriage(input: TriageInput): TriageOutput {
  const step = input.steps.find((candidate) => candidate.id === input.failedStepId)
  const { verdict, reason } = heuristicVerdict(step, input.result)
  const expected = step?.expect ?? targetText(step?.target)
  if (verdict === 'data-missing') {
    const keys = (input.result.error?.message.split('：')[1] ?? '').split(/[,，]\s*/).filter(Boolean)
    return { verdict, severity: 'medium', summary: `缺少测试数据：${keys.join(', ')}`, missingKeys: keys, suggestion: `请补充 ${keys.map((key) => `${key}=…`).join('、')}` }
  }
  if (verdict === 'product-defect') {
    const near = nearbyText(input.result.ariaSnapshot, expected ?? '')
    const actual = input.result.actual === '不可见或不存在' || input.result.actual === undefined
      ? `页面未出现「${expected}」${near === undefined ? '' : `，相近内容：${near}`}`
      : input.result.actual
    return { verdict, severity: 'high', summary: `期望「${expected}」，实际${actual.startsWith('页面') ? '' : '为'}${actual}`, expected, actual }
  }
  if (verdict === 'env-flaky') return { verdict, severity: 'low', summary: reason }
  const role = step?.target !== undefined && 'role' in step.target ? step.target.role : 'textbox'
  const candidates = ariaCandidates(input.result.ariaSnapshot, role)
  return {
    verdict,
    severity: 'medium',
    summary: `${input.failedStepId} 找不到「${expected ?? step?.action}」`,
    actual: input.result.error?.message.split('\n')[0],
    suggestion: candidates.length === 0
      ? '请描述正确的操作方式，或直接修改该步骤'
      : `页面上现有的 ${role}：${candidates.map((name) => `「${name}」`).join('、')}。若目标是其中之一，在反馈里写出正确名称即可`,
  }
}

// ---------- 修正 ----------

export interface RepairInput {
  steps: readonly Step[]
  finding: Pick<Finding, 'stepId' | 'verdict'>
  feedback: Pick<Feedback, 'kind' | 'content' | 'stepPatches'>
}

function retarget(target: Target, value: string): Target {
  if ('role' in target) return { ...target, name: value }
  if ('label' in target) return { label: value }
  if ('placeholder' in target) return { placeholder: value }
  if ('text' in target) return { text: value }
  if ('testId' in target) return { testId: value }
  return { css: value }
}

export function heuristicRepair(input: RepairInput): { steps: Step[]; rationale: string } {
  if ((input.feedback.stepPatches?.length ?? 0) > 0) {
    return { steps: applyStepPatches(input.steps, input.feedback.stepPatches), rationale: '按人工直接修改的步骤更新' }
  }
  const quoted = [...input.feedback.content.matchAll(/[「“"]([^」”"]+)[」”"]/g)].map((m) => m[1]!)
  if (quoted.length === 0) throw new Error('规则修正需要用「」标出正确的值（例如：按钮叫「保存」），或直接在表格里改步骤；配置真实 LLM 后可理解自由文本')
  const step = input.steps.find((candidate) => candidate.id === input.finding.stepId)
  if (step === undefined) throw new Error(`找不到出错的步骤 ${input.finding.stepId ?? '(未知)'}`)
  const value = quoted[0]!
  const patched: Step = { ...step }
  if (isAssertion(step.action) && step.expect !== undefined) patched.expect = value
  else if (step.target !== undefined) patched.target = retarget(step.target, value)
  else patched.value = value
  return {
    steps: input.steps.map((candidate) => (candidate.id === step.id ? patched : { ...candidate })),
    rationale: `${step.id}：按人工指点改为「${value}」`,
  }
}
