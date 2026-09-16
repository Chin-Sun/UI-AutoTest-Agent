/**
 * 会话：复用已保存的登录态，失效才重新登录。
 * 平台通常对同一账号只保留一个有效会话，每次都重登会顶掉人在浏览器里的会话，也更慢。
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import type { LoginConfig } from '@uta/core'
import { FlowError } from '../sdk'
import { formLogin, loginSucceeded, type LoginAccount, type LoginTimeouts } from './formLogin'

export interface SessionOptions {
  page: Page
  /** 调用方应在登录态文件存在时，用它作为 storageState 创建 context */
  context: BrowserContext
  baseURL: string
  config: LoginConfig
  role: string
  /** 账号没配齐时为 undefined */
  account: LoginAccount | undefined
  /** 缺少的环境变量名，用于提示人补哪一项 */
  missingVars: readonly string[]
  authFile: string
  timeouts: LoginTimeouts
  log: (message: string) => void
}

export type SessionOutcome = 'reused' | 'logged-in'

/** 登录后页面需要稳定这么久才算有效 */
const STABLE_MS = 1_500
/** 等检查页的接口都返回的上限：过期 token 要等接口 401 后前端才会踢回登录页，比页面渲染晚 */
const NETWORK_IDLE_MS = 10_000

export async function sessionValid(options: SessionOptions): Promise<boolean> {
  const { page, config, timeouts } = options
  try {
    await page.goto(config.check.url, { waitUntil: 'domcontentloaded', timeout: timeouts.navigation })
  } catch (error) {
    throw new FlowError('env', `打不开 ${config.check.url}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  // 先等接口都回来（长连接页面等不到 idle 时到上限就继续），再判断是否稳定停在登录后的页面
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeouts.navigation, NETWORK_IDLE_MS) }).catch(() => undefined)
  const deadline = Date.now() + Math.min(timeouts.navigation, 15_000)
  let okSince: number | undefined
  for (;;) {
    const ok = await loginSucceeded(page, config, options.baseURL).catch(() => false)
    if (ok) {
      okSince ??= Date.now()
      if (Date.now() - okSince >= STABLE_MS) return true
    } else {
      okSince = undefined
      if (await page.locator('input[type="password"]:visible').count().catch(() => 0) > 0) return false
    }
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(200)
  }
}

export async function ensureSession(options: SessionOptions): Promise<SessionOutcome> {
  const { role, log } = options
  if (existsSync(options.authFile)) {
    if (await sessionValid(options)) {
      log(`会话：复用 ${role} 的登录态`)
      return 'reused'
    }
    log(`会话：${role} 的登录态已失效，重新登录`)
  }
  if (options.account === undefined) {
    const hint = options.missingVars.length > 0 ? options.missingVars.join('、') : `project.yaml 的 login.accounts.${role}`
    throw new FlowError('data-missing', `缺少 ${role} 的登录账号：请在 .env 中填写 ${hint}`)
  }
  await formLogin({ page: options.page, baseURL: options.baseURL, config: options.config, account: options.account, timeouts: options.timeouts, log })
  await mkdir(dirname(options.authFile), { recursive: true })
  await options.context.storageState({ path: options.authFile })
  log(`会话：${role} 重新登录成功，登录态已保存`)
  return 'logged-in'
}
