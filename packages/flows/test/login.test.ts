/** 通用登录：自动识别、声明式动作、已知失败、会话复用（真实浏览器 + 本地夹具页） */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LoginConfigSchema, type LoginConfig } from '@uta/core'
import { detectLoginForm, ensureSession, FlowError, formLogin, type LoginAccount } from '../src'
import { startSite, type FixtureSite } from './support'

let site: FixtureSite
let browser: Browser
beforeAll(async () => {
  site = await startSite()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await site.close()
})

const timeouts = { navigation: 5_000, action: 2_000 }
const logs: string[] = []
const log = (message: string) => { logs.push(message) }
const config = (input: Record<string, unknown>): LoginConfig => LoginConfigSchema.parse(input)
const alice: LoginAccount = { username: 'alice', password: 'secret' }

async function withPage<T>(fn: (context: BrowserContext, page: Page) => Promise<T>, storageState?: string): Promise<T> {
  const context = await browser.newContext({ baseURL: site.baseURL, ...(storageState === undefined ? {} : { storageState }) })
  try {
    return await fn(context, await context.newPage())
  } finally {
    await context.close()
  }
}

async function failure(promise: Promise<unknown>): Promise<FlowError> {
  return promise.then(() => { throw new Error('应当失败') }, (error: unknown) => error as FlowError)
}

describe('表单识别', () => {
  it('标准表单：带 name 的输入框 + type=submit；div 页：密码框前最近的输入框 + 文字按钮（不认标题里的「登录」）', async () => {
    await withPage(async (_context, page) => {
      await page.goto('std-login.html')
      const standard = await detectLoginForm(page, {}, timeouts.navigation)
      expect(await standard.username.getAttribute('name')).toBe('user')
      expect(await standard.submit!.getAttribute('type')).toBe('submit')

      await page.goto('div-login.html')
      const div = await detectLoginForm(page, {}, timeouts.navigation)
      expect(await div.username.getAttribute('class')).toBe('u')
      expect(await div.submit!.getAttribute('class')).toBe('button')
    })
  })

  it('配置的选择器优先；页面没有密码框时报环境问题', async () => {
    await withPage(async (_context, page) => {
      await page.goto('div-login.html')
      const form = await detectLoginForm(page, { username: 'input.p', submit: '#toast' }, timeouts.navigation)
      expect(await form.username.getAttribute('class')).toBe('p')
      expect(await form.submit!.getAttribute('id')).toBe('toast')

      await page.goto('group.html')
      const error = await failure(detectLoginForm(page, {}, 300))
      expect(error).toMatchObject({ kind: 'env' })
      expect(error.message).toContain('没有出现密码输入框')
    })
  })
})

describe('formLogin', () => {
  it('标准表单登录成功，并满足 localStorage 附加条件', async () => {
    await withPage(async (_context, page) => {
      await formLogin({ page, baseURL: site.baseURL, config: config({ url: 'std-login.html', success: { localStorageKey: 'TOKEN' } }), account: alice, timeouts, log })
      expect(page.url()).toContain('home.html')
    })
  })

  it('勾选协议（点方框不点链接）+ 提交后弹出的确认框', async () => {
    await withPage(async (_context, page) => {
      logs.length = 0
      await formLogin({
        page, baseURL: site.baseURL, account: alice, timeouts, log,
        config: config({ url: 'div-login.html?repeat=1', beforeSubmit: [{ check: '用户协议' }], afterSubmit: [{ clickIfAppears: '.pop-container .footer .button:not(.second)' }] }),
      })
      expect(page.url()).toContain('home.html')
      expect(logs.some((line) => line.includes('已点击'))).toBe(true)
    })
  })

  it('可选弹窗没出现时，登录一成功就结束，不等满超时；找不到要勾选的复选框时跳过', async () => {
    await withPage(async (_context, page) => {
      logs.length = 0
      const started = Date.now()
      await formLogin({
        page, baseURL: site.baseURL, account: alice, timeouts: { navigation: 10_000, action: 2_000 }, log,
        config: config({ url: 'std-login.html', beforeSubmit: [{ check: '不存在的协议' }], afterSubmit: [{ clickIfAppears: '确认' }] }),
      })
      expect(Date.now() - started).toBeLessThan(8_000)
      expect(logs).toContain('登录：没有找到「不存在的协议」复选框，跳过')
    })
  })

  it.each([
    ['密码错误：停在登录页，报缺数据并带页面提示', { url: 'std-login.html' }, { username: 'alice', password: 'wrong' }, 'data-missing', '用户名或密码错误'],
    ['没勾协议：停在登录页，提示检查 beforeSubmit', { url: 'div-login.html' }, alice, 'data-missing', 'beforeSubmit'],
    ['登录后跳到失败页', { url: 'std-login.html', failures: [{ urlContains: 'group.html', message: '账号没有空间' }] }, { username: 'nogroup', password: 'secret' }, 'data-missing', '账号没有空间'],
    ['前置接口失败：报环境问题', { url: 'div-login.html?precheck=1', beforeSubmit: [{ check: '用户协议' }], failures: [{ responseUrlContains: 'api/validate-login', message: '前置校验失败' }] }, alice, 'env', '前置校验失败'],
    ['登录页打不开：报环境问题', { url: 'http://127.0.0.1:1/login' }, alice, 'env', '打不开登录页'],
  ] as [string, Record<string, unknown>, LoginAccount, string, string][])('%s', async (_name, input, account, kind, text) => {
    await withPage(async (_context, page) => {
      const error = await failure(formLogin({ page, baseURL: site.baseURL, config: config(input), account, timeouts: { navigation: 2_500, action: 1_000 }, log }))
      expect(error).toBeInstanceOf(FlowError)
      expect(error).toMatchObject({ kind })
      expect(error.message).toContain(text)
    })
  })
})

describe('ensureSession', () => {
  const sessionConfig = config({ url: 'std-login.html', success: { localStorageKey: 'TOKEN' }, check: { url: 'home.html' } })

  it('首次登录并保存登录态；再次执行复用、不提交表单；登录态失效后重新登录', async () => {
    const authFile = join(site.dir, 'auth', 'admin.json')
    const options = (context: BrowserContext, page: Page, account: LoginAccount | undefined) => ({
      page, context, baseURL: site.baseURL, config: sessionConfig, role: 'admin', account, missingVars: [], authFile, timeouts, log,
    })

    expect(await withPage((context, page) => ensureSession(options(context, page, alice)))).toBe('logged-in')
    expect(existsSync(authFile)).toBe(true)
    // 复用时不需要账号：没有账号也能成功，说明没有走表单登录
    expect(await withPage((context, page) => ensureSession(options(context, page, undefined)), authFile)).toBe('reused')

    const state = JSON.parse(await readFile(authFile, 'utf8')) as { origins: { localStorage: { name: string, value: string }[] }[] }
    for (const origin of state.origins) for (const item of origin.localStorage) if (item.name === 'TOKEN') item.value = 'expired'
    await writeFile(authFile, JSON.stringify(state))
    logs.length = 0
    expect(await withPage((context, page) => ensureSession(options(context, page, alice)), authFile)).toBe('logged-in')
    expect(logs).toContain('会话：admin 的登录态已失效，重新登录')
  })

  it('页面先正常渲染、接口过一会儿才 401 踢回登录页：不能误判为可复用，要重新登录', async () => {
    const authFile = join(site.dir, 'auth', 'slow.json')
    const slowConfig = config({ url: 'std-login.html', success: { localStorageKey: 'TOKEN' }, check: { url: 'app.html' } })
    const options = (context: BrowserContext, page: Page) => ({
      page, context, baseURL: site.baseURL, config: slowConfig, role: 'admin', account: alice, missingVars: [], authFile, timeouts: { navigation: 8_000, action: 2_000 }, log,
    })
    expect(await withPage((context, page) => ensureSession(options(context, page)))).toBe('logged-in')

    const state = JSON.parse(await readFile(authFile, 'utf8')) as { origins: { localStorage: { name: string, value: string }[] }[] }
    for (const origin of state.origins) for (const item of origin.localStorage) if (item.name === 'TOKEN') item.value = 'expired'
    await writeFile(authFile, JSON.stringify(state))
    logs.length = 0
    expect(await withPage((context, page) => ensureSession(options(context, page)), authFile)).toBe('logged-in')
    expect(logs).toContain('会话：admin 的登录态已失效，重新登录')
  })

  it('没有登录态也没有账号：报缺数据，并写明要在 .env 填哪个变量', async () => {
    const error = await withPage((context, page) => failure(ensureSession({
      page, context, baseURL: site.baseURL, config: sessionConfig, role: 'viewer', account: undefined,
      missingVars: ['SHOP_VIEWER_PASSWORD'], authFile: join(site.dir, 'auth', 'viewer.json'), timeouts, log,
    })))
    expect(error).toMatchObject({ kind: 'data-missing' })
    expect(error.message).toBe('缺少 viewer 的登录账号：请在 .env 中填写 SHOP_VIEWER_PASSWORD')
  })
})
