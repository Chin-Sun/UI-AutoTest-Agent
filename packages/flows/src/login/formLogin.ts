/**
 * 通用表单登录：打开登录页 → 填账号密码 → 提交前动作 → 提交 → 提交后动作 → 判定成功或已知失败。
 * 平台差异全部写在 project.yaml 的 login 配置里，不写代码。
 */
import type { Page, Response } from 'playwright'
import type { LoginConfig } from '@uta/core'
import { FlowError } from '../sdk'
import { detectLoginForm } from './detect'

export interface LoginAccount {
  username: string
  password: string
}

export interface LoginTimeouts {
  navigation: number
  action: number
}

export interface FormLoginOptions {
  page: Page
  baseURL: string
  config: LoginConfig
  account: LoginAccount
  timeouts: LoginTimeouts
  log: (message: string) => void
}

type LoginAction = LoginConfig['beforeSubmit'][number]
type FailureRule = LoginConfig['failures'][number]
type ResponseRule = Extract<FailureRule, { responseUrlContains: string }>
type UrlRule = Extract<FailureRule, { urlContains: string }>

const isResponseRule = (rule: FailureRule): rule is ResponseRule => 'responseUrlContains' in rule
const isUrlRule = (rule: FailureRule): rule is UrlRule => 'urlContains' in rule

/** 以 . # [ 开头，或「标签名 + 选择器符号」的按 CSS 处理，否则按可见文字精确匹配 */
const CSS_LIKE = /^[.#[]|^[a-z][\w-]*[.#[:\s>]/i

function locateTarget(page: Page, value: string, within?: string) {
  const scope = within === undefined ? page : page.locator(within)
  return CSS_LIKE.test(value) ? scope.locator(value) : scope.getByText(value, { exact: true })
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function loginPath(config: LoginConfig, baseURL: string): string {
  return new URL(config.url, baseURL).pathname
}

/** 登录是否完成：离开登录页、没有可见密码框，并满足 success 里配置的附加条件 */
export async function loginSucceeded(page: Page, config: LoginConfig, baseURL: string): Promise<boolean> {
  const url = page.url()
  if (!/^https?:/.test(url)) return false
  const onLoginPage = config.success.urlNotContains === undefined
    ? new URL(url).pathname === loginPath(config, baseURL)
    : url.includes(config.success.urlNotContains)
  if (onLoginPage) return false
  if (config.success.visible === undefined && await page.locator('input[type="password"]:visible').count() > 0) return false
  if (config.success.localStorageKey !== undefined) {
    const value = await page.evaluate((key) => window.localStorage.getItem(key), config.success.localStorageKey)
    if (value === null || value === '') return false
  }
  if (config.success.visible !== undefined && !await page.locator(config.success.visible).first().isVisible()) return false
  return true
}

interface ResponseWatch {
  failure: string | undefined
  dispose(): void
}

function watchResponses(page: Page, failures: LoginConfig['failures']): ResponseWatch {
  const rules = failures.filter(isResponseRule)
  const onResponse = (response: Response) => {
    const rule = rules.find((candidate) => response.url().includes(candidate.responseUrlContains) && response.status() >= candidate.statusGte)
    if (rule !== undefined && watch.failure === undefined) watch.failure = `${rule.message}（${response.url()} → HTTP ${response.status()}）`
  }
  const watch: ResponseWatch = { failure: undefined, dispose: () => page.off('response', onResponse) }
  page.on('response', onResponse)
  return watch
}

async function visibleErrorText(page: Page): Promise<string | undefined> {
  const hint = page.locator('[role="alert"]:visible, [class*="error"]:visible, [class*="message"]:visible').first()
  const text = await hint.innerText({ timeout: 300 }).catch(() => '')
  return text.trim() === '' ? undefined : text.trim().slice(0, 80)
}

async function waitForOutcome(options: FormLoginOptions, watch: ResponseWatch): Promise<void> {
  const { page, config, timeouts } = options
  const deadline = Date.now() + timeouts.navigation
  const failedUrl = () => {
    const url = page.url()
    const rule = config.failures.filter(isUrlRule).find((candidate) => url.includes(candidate.urlContains))
    return rule === undefined ? undefined : new FlowError('data-missing', `${rule.message}（当前页面 ${url}）`)
  }
  for (;;) {
    if (watch.failure !== undefined) throw new FlowError('env', watch.failure)
    const urlFailure = failedUrl()
    if (urlFailure !== undefined) throw urlFailure
    if (await loginSucceeded(page, config, options.baseURL).catch(() => false)) {
      // 判定期间页面可能刚好跳到了失败页（如「未绑定空间」），成功前再核对一次
      const late = failedUrl()
      if (late !== undefined) throw late
      return
    }
    const url = page.url()
    if (Date.now() >= deadline) {
      const stillOnForm = await page.locator('input[type="password"]:visible').count().catch(() => 0) > 0
      if (!stillOnForm) throw new FlowError('env', `登录后 ${timeouts.navigation}ms 内没有进入登录后的页面（当前 ${url}），请检查网络或 login.success 配置`)
      const hint = await visibleErrorText(page)
      throw new FlowError('data-missing', `登录失败：仍停留在登录页${hint === undefined ? '' : `，页面提示「${hint}」`}。请核对账号密码，或检查 login.beforeSubmit / afterSubmit 是否覆盖了必选项（如协议勾选、确认弹窗）`)
    }
    await page.waitForTimeout(200)
  }
}

async function checkByName(page: Page, text: string, log: (message: string) => void): Promise<void> {
  const box = page.getByRole('checkbox', { name: new RegExp(escapeRegExp(text)) }).first()
  if (await box.count() === 0 || !await box.isVisible()) {
    log(`登录：没有找到「${text}」复选框，跳过`)
    return
  }
  if (await box.isChecked()) return
  // 说明文字里常带协议链接，点几何中心会点到链接上：点左侧边缘（通常是方框本身）
  const bounds = await box.boundingBox()
  await box.click(bounds === null ? {} : { position: { x: Math.min(8, bounds.width / 2), y: bounds.height / 2 } })
  if (!await box.isChecked()) throw new FlowError('step', `登录：勾选「${text}」后仍未选中，请在 login.beforeSubmit 里改用 click 指定方框的选择器`)
}

async function runAction(options: FormLoginOptions, action: LoginAction, settled: Promise<void> | undefined): Promise<void> {
  const { page, timeouts, log } = options
  if ('check' in action) {
    await checkByName(page, action.check, log)
    return
  }
  if ('click' in action) {
    await locateTarget(page, action.click).first().click({ timeout: timeouts.action })
    return
  }
  const button = locateTarget(page, action.clickIfAppears, action.within).first()
  // 可选弹窗与「登录已有结论」竞速：弹窗无论多晚出现都会被点掉，没有弹窗时也不必等满超时
  const appeared = button.waitFor({ state: 'visible', timeout: action.timeoutMs ?? (settled === undefined ? 2_000 : timeouts.navigation) }).then(() => true, () => false)
  const shouldClick = settled === undefined ? await appeared : await Promise.race([appeared, settled.then(() => false, () => false)])
  if (!shouldClick) return
  await button.click({ timeout: timeouts.action })
  log(`登录：已点击「${action.clickIfAppears}」`)
}

export async function formLogin(options: FormLoginOptions): Promise<void> {
  const { page, config, timeouts } = options
  const watch = watchResponses(page, config.failures)
  try {
    try {
      await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: timeouts.navigation })
    } catch (error) {
      throw new FlowError('env', `打不开登录页 ${config.url}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
    const form = await detectLoginForm(page, config.fields, timeouts.navigation)
    await form.username.fill(options.account.username, { timeout: timeouts.action })
    await form.password.fill(options.account.password, { timeout: timeouts.action })
    for (const action of config.beforeSubmit) await runAction(options, action, undefined)

    const settled = waitForOutcome(options, watch)
    void settled.catch(() => undefined)
    if (form.submit === undefined) await form.password.press('Enter')
    else await form.submit.click({ timeout: timeouts.action })
    for (const action of config.afterSubmit) await runAction(options, action, settled)
    await settled
  } finally {
    watch.dispose()
  }
}
