/** 登录表单识别：配置了选择器就用选择器，否则按常见表单结构自动识别 */
import type { Locator, Page } from 'playwright'
import type { LoginConfig } from '@uta/core'
import { FlowError } from '../sdk'

/** 登录按钮的常见文案 */
export const SUBMIT_TEXT = /^\s*(登\s*录|立即登录|log\s*in|sign\s*in)\s*$/i
const MARK = 'data-uta-login'

export interface LoginForm {
  username: Locator
  password: Locator
  /** 找不到按钮时为 undefined，由调用方在密码框回车提交 */
  submit: Locator | undefined
}

async function firstVisible(locator: Locator, accept: (item: Locator) => Promise<boolean> = async () => true): Promise<Locator | undefined> {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible() && await accept(item)) return item
  }
  return undefined
}

/** 在第一个可见密码框之前、离它最近的可见文本类输入框上打标记 */
async function markUsernameBeforePassword(page: Page): Promise<boolean> {
  return page.evaluate((mark) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
    }
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible)
    if (password === undefined) return false
    const candidates = [...document.querySelectorAll('input')].filter((input) => ['text', 'email', 'tel'].includes(input.type)
      && visible(input)
      && (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    const target = candidates.at(-1)
    if (target === undefined) return false
    target.setAttribute(mark, 'username')
    return true
  }, MARK)
}

export async function detectLoginForm(page: Page, fields: LoginConfig['fields'], timeoutMs: number): Promise<LoginForm> {
  const password = page.locator(fields.password ?? 'input[type="password"]:visible').first()
  try {
    await password.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    throw new FlowError('env', `登录页 ${page.url()} 在 ${timeoutMs}ms 内没有出现密码输入框：页面可能没有加载出来，或 login.url 不对`)
  }

  let username: Locator | undefined
  if (fields.username !== undefined) {
    username = page.locator(fields.username).first()
  } else {
    username = await firstVisible(page.locator('input[autocomplete="username"], input[type="email"]'))
    if (username === undefined && await markUsernameBeforePassword(page)) username = page.locator(`[${MARK}="username"]`).first()
  }
  if (username === undefined) throw new FlowError('step', `登录页 ${page.url()} 上找不到用户名输入框，请在 login.fields.username 里写明选择器`)

  const notHeading = async (item: Locator) => !/^(H[1-6]|LABEL|TITLE|OPTION)$/.test(await item.evaluate((element) => element.tagName))
  const submit = fields.submit !== undefined
    ? page.locator(fields.submit).first()
    : await firstVisible(page.locator('button[type="submit"], input[type="submit"]'))
      ?? await firstVisible(page.getByRole('button', { name: SUBMIT_TEXT }))
      ?? await firstVisible(page.getByText(SUBMIT_TEXT), notHeading)
  return { username, password, submit }
}
