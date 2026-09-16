/**
 * 确定性执行器：逐步解释 Step DSL。执行过程不经过 LLM，可重放、可比对。
 * 每一步前后发事件；CDP screencast 把画面实时推给前端；同时录 video + trace + 每步截图。
 * 配置了登录会话时先复用 / 建立登录态；action=use 的步骤调用项目积木（@uta/flows）。
 */
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { chromium, errors, type BrowserContext, type FileChooser, type Locator, type Page } from 'playwright'
import {
  flowOutputs, isAssertion, missingBindings, resolveBindings,
  type LoginConfig, type Step, type StepErrorKind, type StepResult, type Target, type TestDataEntry,
} from '@uta/core'
import {
  ensureSession, FlowError, memoryState, runFlow,
  type FlowDefinition, type FlowErrorKind, type FlowState, type FlowTimeouts, type LoginAccount,
} from '@uta/flows'

export interface RunnerHooks {
  onFrame?(jpegBase64: string): void
  onStepStart?(step: Step, index: number): void
  onStepEnd?(result: StepResult, index: number): void
  onLog?(message: string): void
}

/** 表单登录会话：执行步骤前复用已保存的登录态，失效才用账号重新登录 */
export interface RunSession {
  config: LoginConfig
  role: string
  /** 账号没配齐时不传，会话直接判为缺数据 */
  account?: LoginAccount
  missingVars: string[]
  /** 登录态文件（storageState） */
  authFile: string
}

export interface RunPlanOptions {
  steps: readonly Step[]
  data: Readonly<Record<string, string>>
  baseURL: string
  /** 项目直接提供的登录态文件（没有配置 session 时使用） */
  storageState?: string
  session?: RunSession
  headed?: boolean
  slowMo?: number
  viewport?: { width: number, height: number }
  /** 证据目录的绝对路径 */
  evidenceDir: string
  /** 证据在 data 根下的相对路径前缀，写进 StepResult 供前端取用 */
  evidenceRel: string
  actionTimeoutMs?: number
  assertTimeoutMs?: number
  navigationTimeoutMs?: number
  /** 页面脚本执行前写入的 localStorage（如锁定界面语言） */
  localStorage?: Record<string, string>
  /** 项目积木，action=use 时调用 */
  flows?: readonly FlowDefinition[]
  catalog?: readonly TestDataEntry[]
  /** 项目级持久状态；不传时用内存状态 */
  state?: FlowState
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

export function timeoutsOf(opts: Pick<RunPlanOptions, 'actionTimeoutMs' | 'assertTimeoutMs' | 'navigationTimeoutMs'>): FlowTimeouts {
  return { action: opts.actionTimeoutMs ?? 8_000, assert: opts.assertTimeoutMs ?? 5_000, navigation: opts.navigationTimeoutMs ?? 30_000 }
}

/** 积木参数里的字符串逐个解析 ${data.key} */
export function resolveParams(value: unknown, data: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return resolveBindings(value, data)
  if (Array.isArray(value)) return value.map((item) => resolveParams(item, data))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveParams(item, data)]))
  return value
}

/** 一次执行内共享的可变状态：积木输出会写回 data，供后续步骤引用 */
interface ExecutionEnv {
  data: Record<string, string>
  state: FlowState
  log: (message: string) => void
  /** 页面最近弹出、还没被使用的文件选择器（例如上一步点击触发的） */
  chooser: FileChooser | undefined
}

/**
 * 上传文件。target 是 file input 时直接设置；不是时把它当作触发器：
 * 很多前端点击后才临时创建 input 并唤起系统文件选择器，页面里根本没有 input 可以定位。
 * 上一步点击已经唤起、还没被使用的选择器也会被接住。
 */
async function uploadFiles(page: Page, target: Locator, files: string[], env: ExecutionEnv, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pending = env.chooser
    if (pending !== undefined) {
      env.chooser = undefined
      await pending.setFiles(files)
      return
    }
    if (await target.count() > 0) {
      const first = target.first()
      if (await first.evaluate((element) => element instanceof HTMLInputElement && element.type === 'file')) {
        await first.setInputFiles(files)
        return
      }
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: timeoutMs }), first.click()])
      env.chooser = undefined
      await chooser.setFiles(files)
      return
    }
    if (Date.now() >= deadline) throw new FlowError('step', `上传：${timeoutMs}ms 内既没有找到上传目标，也没有弹出文件选择器。请把 target 写成触发上传的按钮 / 卡片，或页面上真实存在的 file input`)
    await page.waitForTimeout(200)
  }
}

async function executeStep(page: Page, step: Step, opts: RunPlanOptions, env: ExecutionEnv): Promise<string | undefined> {
  const data = env.data
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
    case 'upload': {
      // 多个文件用换行分隔
      const files = value!.split('\n').map((file) => file.trim()).filter((file) => file !== '')
      const absent = files.find((file) => !existsSync(file))
      if (absent !== undefined) throw new FlowError('data-missing', `上传文件不存在：${absent}`)
      await uploadFiles(page, need(), files, env, opts.actionTimeoutMs ?? 8_000)
      return files.map((file) => basename(file)).join('，')
    }
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
    case 'use': {
      const flow = opts.flows?.find((candidate) => candidate.id === step.flow)
      if (flow === undefined) throw new FlowError('step', `项目没有积木 ${step.flow ?? '(未指定)'}`)
      const outputs = await runFlow(flow, {
        page, context: page.context(), baseURL: opts.baseURL, data: { ...data }, catalog: opts.catalog ?? [],
        state: env.state, timeouts: timeoutsOf(opts), log: env.log,
      }, resolveParams(step.params ?? {}, data))
      Object.assign(data, outputs)
      const summary = Object.entries(outputs).map(([key, output]) => `${key}=${output}`).join('，')
      return summary === '' ? '完成' : summary
    }
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

const FLOW_ERROR_KIND: Record<FlowErrorKind, StepErrorKind> = {
  'env': 'navigation',
  'data-missing': 'missing-data',
  'step': 'locator',
  'assertion': 'assertion',
}

export function classifyError(step: Step, error: unknown): { kind: StepErrorKind, message: string } {
  const message = (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 6).join('\n')
  if (error instanceof FlowError) return { kind: FLOW_ERROR_KIND[error.kind], message }
  if (error instanceof AssertionFailure) return { kind: 'assertion', message }
  if (/net::ERR_|NS_ERROR_|ECONNREFUSED/.test(message)) return { kind: 'navigation', message }
  if (/strict mode violation|resolved to \d+ elements/.test(message)) return { kind: 'locator', message }
  if (error instanceof errors.TimeoutError) {
    // 页面跳转超时是环境问题（网络慢、资源加载不完），不是定位写错
    if (step.action === 'goto' || /page\.goto|waitForURL|waitForNavigation/.test(message)) return { kind: 'navigation', message }
    return { kind: isAssertion(step.action) ? 'assertion' : 'locator', message }
  }
  return { kind: 'other', message }
}

async function openSession(page: Page, context: BrowserContext, opts: RunPlanOptions, session: RunSession, log: (message: string) => void): Promise<StepResult | undefined> {
  const started = Date.now()
  try {
    await ensureSession({
      page, context, baseURL: opts.baseURL, config: session.config, role: session.role, account: session.account,
      missingVars: session.missingVars, authFile: session.authFile, timeouts: timeoutsOf(opts), log,
    })
    return undefined
  } catch (error) {
    const first = opts.steps[0]!
    const classified = classifyError(first, error)
    const shotName = 'session.png'
    await page.screenshot({ path: join(opts.evidenceDir, shotName) }).catch(() => undefined)
    return {
      stepId: first.id,
      status: 'failed',
      durationMs: Date.now() - started,
      error: { kind: classified.kind, message: `登录会话失败：${classified.message}` },
      screenshot: `${opts.evidenceRel}/${shotName}`,
    }
  }
}

export async function runPlan(opts: RunPlanOptions): Promise<RunPlanResult> {
  const log = (message: string) => opts.hooks?.onLog?.(message)
  const stepResults: StepResult[] = []

  // 缺数据在执行前就判定，不浪费一次浏览器执行；积木执行时才产出的 key 不算缺失
  const produced = flowOutputs(opts.steps, (opts.flows ?? []).map((flow) => ({ id: flow.id, outputs: [...flow.outputs] })))
  const missing = missingBindings(opts.steps, opts.data, produced)
  if (missing.length > 0) {
    const first = opts.steps.find((step) => JSON.stringify(step).includes(`\${data.${missing[0]}}`)) ?? opts.steps[0]!
    const result: StepResult = { stepId: first.id, status: 'failed', durationMs: 0, error: { kind: 'missing-data', message: `缺少测试数据：${missing.join(', ')}` } }
    opts.hooks?.onStepEnd?.(result, opts.steps.indexOf(first))
    return { status: 'failed', stepResults: [result], error: result.error!.message }
  }

  await mkdir(opts.evidenceDir, { recursive: true })
  const viewport = opts.viewport ?? { width: 1280, height: 800 }
  const timeouts = timeoutsOf(opts)
  const storageState = opts.session === undefined
    ? opts.storageState
    : existsSync(opts.session.authFile) ? opts.session.authFile : undefined
  const browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo ?? 0 })
  const context = await browser.newContext({
    baseURL: opts.baseURL,
    viewport,
    ...(storageState === undefined ? {} : { storageState }),
    recordVideo: { dir: opts.evidenceDir, size: viewport },
  })
  if (opts.localStorage !== undefined && Object.keys(opts.localStorage).length > 0) {
    await context.addInitScript((entries: [string, string][]) => {
      for (const [key, value] of entries) {
        try {
          window.localStorage.setItem(key, value)
        } catch {
          // 无痕 / 禁用存储时忽略
        }
      }
    }, Object.entries(opts.localStorage))
  }
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(timeouts.action)
  page.setDefaultNavigationTimeout(timeouts.navigation)

  if (opts.hooks?.onFrame !== undefined) {
    const cdp = await context.newCDPSession(page)
    cdp.on('Page.screencastFrame', (frame) => {
      opts.hooks?.onFrame?.(frame.data)
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: viewport.width, maxHeight: viewport.height })
  }

  const env: ExecutionEnv = { data: { ...opts.data }, state: opts.state ?? memoryState(), log, chooser: undefined }
  // 监听后浏览器不再弹出原生选择器；记下来交给后续的 upload 步骤
  page.on('filechooser', (chooser) => { env.chooser = chooser })
  let status: RunPlanResult['status'] = 'passed'
  let failure: string | undefined
  try {
    if (opts.session !== undefined) {
      const failed = await openSession(page, context, opts, opts.session, log)
      if (failed !== undefined) {
        stepResults.push(failed)
        opts.hooks?.onStepEnd?.(failed, 0)
        log(`✗ ${failed.error!.message.split('\n')[0]}`)
        status = 'failed'
        failure = `${failed.stepId}: ${failed.error!.message}`
      }
    }
    for (const [index, step] of opts.steps.entries()) {
      if (status === 'failed') break
      if (opts.signal?.aborted) {
        status = 'cancelled'
        break
      }
      opts.hooks?.onStepStart?.(step, index)
      log(`▶ ${step.id} ${step.action}${step.flow === undefined ? '' : ` ${step.flow}`}${step.note ? ` · ${step.note}` : ''}`)
      const started = Date.now()
      const shotName = `step-${String(index + 1).padStart(2, '0')}-${step.id}.png`
      let result: StepResult
      try {
        const actual = await executeStep(page, step, opts, env)
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
      log(`${result.status === 'passed' ? '✓' : '✗'} ${step.id} ${result.durationMs}ms${result.error ? ` · ${result.error.message.split('\n')[0]}` : result.actual !== undefined && step.action === 'use' ? ` · ${result.actual}` : ''}`)
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
