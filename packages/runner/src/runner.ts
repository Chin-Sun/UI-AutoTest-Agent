/**
 * 确定性执行器：逐步解释 Step DSL。执行过程不经过 LLM，可重放、可比对。
 * 每一步前后发事件；CDP screencast 把画面实时推给前端；同时录 video + trace + 每步截图。
 */
import { chromium, errors, type Locator, type Page } from 'playwright'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isAssertion, missingBindings, resolveBindings, type Step, type StepErrorKind, type StepResult, type Target,
} from '@uta/core'

export interface RunnerHooks {
  onFrame?(jpegBase64: string): void
  onStepStart?(step: Step, index: number): void
  onStepEnd?(result: StepResult, index: number): void
  onLog?(message: string): void
}

export interface RunPlanOptions {
  steps: readonly Step[]
  data: Readonly<Record<string, string>>
  baseURL: string
  storageState?: string
  headed?: boolean
  slowMo?: number
  viewport?: { width: number, height: number }
  /** 证据目录的绝对路径 */
  evidenceDir: string
  /** 证据在 data 根下的相对路径前缀，写进 StepResult 供前端取用 */
  evidenceRel: string
  actionTimeoutMs?: number
  assertTimeoutMs?: number
  signal?: AbortSignal
  hooks?: RunnerHooks
}

export interface RunPlanResult {
  status: 'passed' | 'failed' | 'cancelled'
  stepResults: StepResult[]
  video?: string
  trace?: string
  error?: string
}

class AssertionFailure extends Error {
  constructor(message: string, readonly actual?: string) {
    super(message)
  }
}

export function locate(page: Page, target: Target, data: Readonly<Record<string, string>>): Locator {
  const r = (text: string) => resolveBindings(text, data)
  if ('testId' in target) return page.getByTestId(r(target.testId))
  if ('role' in target) {
    return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      ...(target.name === undefined ? {} : { name: r(target.name) }),
      ...(target.exact === undefined ? {} : { exact: target.exact }),
    })
  }
  if ('label' in target) return page.getByLabel(r(target.label))
  if ('placeholder' in target) return page.getByPlaceholder(r(target.placeholder))
  if ('text' in target) return page.getByText(r(target.text), target.exact === undefined ? {} : { exact: target.exact })
  return page.locator(r(target.css))
}

async function poll<T>(probe: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number): Promise<{ ok: boolean, last: T | undefined }> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  for (;;) {
    try {
      last = await probe()
      if (ok(last)) return { ok: true, last }
    } catch {
      // 元素暂未出现，继续轮询
    }
    if (Date.now() >= deadline) return { ok: false, last }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export function matchesUrl(url: string, expected: string): boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(expected)
  return regex === null ? url.includes(expected) : new RegExp(regex[1]!, regex[2]).test(url)
}

async function executeStep(page: Page, step: Step, opts: RunPlanOptions): Promise<string | undefined> {
  const data = opts.data
  const value = step.value === undefined ? undefined : resolveBindings(step.value, data)
  const expected = step.expect === undefined ? undefined : resolveBindings(step.expect, data)
  const target = step.target === undefined ? undefined : locate(page, step.target, data)
  const assertTimeout = step.timeoutMs ?? opts.assertTimeoutMs ?? 5_000
  const need = (): Locator => {
    if (target === undefined) throw new Error(`${step.action} 缺少 target`)
    return target
  }
  switch (step.action) {
    case 'goto': await page.goto(value!); return
    case 'click': await need().click(); return
    case 'fill': await need().fill(value!); return
    case 'select': await need().selectOption(value!); return
    case 'check': await need().check(); return
    case 'uncheck': await need().uncheck(); return
    case 'upload': await need().setInputFiles(value!); return
    case 'hover': await need().hover(); return
    case 'press':
      if (target === undefined) await page.keyboard.press(value!)
      else await target.press(value!)
      return
    case 'waitFor':
      if (target === undefined) await page.waitForTimeout(Number(value))
      else await target.first().waitFor({ state: 'visible', timeout: step.timeoutMs })
      return
    case 'screenshot': return
    case 'assertVisible': {
      const r = await poll(() => need().first().isVisible(), (v) => v, assertTimeout)
      if (!r.ok) throw new AssertionFailure('元素不可见', '不可见或不存在')
      return '可见'
    }
    case 'assertHidden': {
      const r = await poll(() => need().first().isVisible(), (v) => !v, assertTimeout)
      if (!r.ok) throw new AssertionFailure('元素仍然可见', '可见')
      return '不可见'
    }
    case 'assertText': {
      const r = await poll(() => need().first().innerText({ timeout: 500 }), (v) => v.includes(expected!), assertTimeout)
      if (!r.ok) throw new AssertionFailure(`文本不包含「${expected}」`, r.last ?? '(元素不存在)')
      return r.last
    }
    case 'assertValue': {
      const r = await poll(() => need().first().inputValue({ timeout: 500 }), (v) => v.includes(expected!), assertTimeout)
      if (!r.ok) throw new AssertionFailure(`输入值不包含「${expected}」`, r.last ?? '(元素不存在)')
      return r.last
    }
    case 'assertUrl': {
      const r = await poll(async () => page.url(), (v) => matchesUrl(v, expected!), assertTimeout)
      if (!r.ok) throw new AssertionFailure(`URL 不匹配 ${expected}`, r.last)
      return r.last
    }
    case 'assertCount': {
      const want = Number(expected)
      const r = await poll(() => need().count(), (v) => v === want, assertTimeout)
      if (!r.ok) throw new AssertionFailure(`数量不是 ${want}`, String(r.last ?? 0))
      return String(r.last)
    }
  }
}

export function classifyError(step: Step, error: unknown): { kind: StepErrorKind, message: string } {
  const message = (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 6).join('\n')
  if (error instanceof AssertionFailure) return { kind: 'assertion', message }
  if (/net::ERR_|NS_ERROR_|ECONNREFUSED/.test(message)) return { kind: 'navigation', message }
  if (/strict mode violation|resolved to \d+ elements/.test(message)) return { kind: 'locator', message }
  if (error instanceof errors.TimeoutError) {
    return { kind: isAssertion(step.action) ? 'assertion' : 'locator', message }
  }
  return { kind: 'other', message }
}

export async function runPlan(opts: RunPlanOptions): Promise<RunPlanResult> {
  const log = (message: string) => opts.hooks?.onLog?.(message)
  const stepResults: StepResult[] = []

  // 缺数据在执行前就判定，不浪费一次浏览器执行
  const missing = missingBindings(opts.steps, opts.data)
  if (missing.length > 0) {
    const first = opts.steps.find((step) => JSON.stringify(step).includes(`\${data.${missing[0]}}`)) ?? opts.steps[0]!
    const result: StepResult = { stepId: first.id, status: 'failed', durationMs: 0, error: { kind: 'missing-data', message: `缺少测试数据：${missing.join(', ')}` } }
    opts.hooks?.onStepEnd?.(result, opts.steps.indexOf(first))
    return { status: 'failed', stepResults: [result], error: result.error!.message }
  }

  await mkdir(opts.evidenceDir, { recursive: true })
  const viewport = opts.viewport ?? { width: 1280, height: 800 }
  const browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo ?? 0 })
  const context = await browser.newContext({
    baseURL: opts.baseURL,
    viewport,
    ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
    recordVideo: { dir: opts.evidenceDir, size: viewport },
  })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(opts.actionTimeoutMs ?? 8_000)

  if (opts.hooks?.onFrame !== undefined) {
    const cdp = await context.newCDPSession(page)
    cdp.on('Page.screencastFrame', (frame) => {
      opts.hooks?.onFrame?.(frame.data)
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: viewport.width, maxHeight: viewport.height })
  }

  let status: RunPlanResult['status'] = 'passed'
  let failure: string | undefined
  try {
    for (const [index, step] of opts.steps.entries()) {
      if (opts.signal?.aborted) {
        status = 'cancelled'
        break
      }
      opts.hooks?.onStepStart?.(step, index)
      log(`▶ ${step.id} ${step.action}${step.note ? ` · ${step.note}` : ''}`)
      const started = Date.now()
      const shotName = `step-${String(index + 1).padStart(2, '0')}-${step.id}.png`
      let result: StepResult
      try {
        const actual = await executeStep(page, step, opts)
        await page.screenshot({ path: join(opts.evidenceDir, shotName) }).catch(() => undefined)
        result = { stepId: step.id, status: 'passed', durationMs: Date.now() - started, screenshot: `${opts.evidenceRel}/${shotName}`, ...(actual === undefined ? {} : { actual }) }
      } catch (error) {
        const classified = classifyError(step, error)
        await page.screenshot({ path: join(opts.evidenceDir, shotName) }).catch(() => undefined)
        const aria = await page.locator('body').ariaSnapshot({ timeout: 1_000 }).catch(() => undefined)
        result = {
          stepId: step.id,
          status: 'failed',
          durationMs: Date.now() - started,
          error: classified,
          screenshot: `${opts.evidenceRel}/${shotName}`,
          ...(error instanceof AssertionFailure && error.actual !== undefined ? { actual: error.actual } : {}),
          ...(aria === undefined ? {} : { ariaSnapshot: aria.slice(0, 4_000) }),
        }
        status = 'failed'
        failure = `${step.id}: ${classified.message}`
      }
      stepResults.push(result)
      opts.hooks?.onStepEnd?.(result, index)
      log(`${result.status === 'passed' ? '✓' : '✗'} ${step.id} ${result.durationMs}ms${result.error ? ` · ${result.error.message.split('\n')[0]}` : ''}`)
      if (result.status === 'failed') break
    }
  } finally {
    await context.tracing.stop({ path: join(opts.evidenceDir, 'trace.zip') }).catch(() => undefined)
    const video = page.video()
    await context.close()
    await browser.close()
    if (video !== null) {
      const raw = await video.path().catch(() => undefined)
      if (raw !== undefined) await rename(raw, join(opts.evidenceDir, 'video.webm')).catch(() => undefined)
    }
  }
  // 未执行到的步骤显式记为 skipped，canPass 据此判定
  for (const step of opts.steps) {
    if (!stepResults.some((result) => result.stepId === step.id)) stepResults.push({ stepId: step.id, status: 'skipped', durationMs: 0 })
  }
  return {
    status,
    stepResults,
    video: `${opts.evidenceRel}/video.webm`,
    trace: `${opts.evidenceRel}/trace.zip`,
    ...(failure === undefined ? {} : { error: failure }),
  }
}
