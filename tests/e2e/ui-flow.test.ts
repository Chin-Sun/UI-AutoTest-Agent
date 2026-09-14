/**
 * 主流程（前端页面）：像测试人员一样只通过浏览器操作六个页面。
 * 每次运行都从源码重新构建前端，保证测的是当前代码。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO, startTestServer, type TestServer } from '../support/harness'
import { client, terminal, until } from '../support/http'

let t: TestServer
let webDist: string
let browser: Browser
let page: Page
const pageErrors: string[] = []
const api = client(() => t.base)
const NEW_CASE = 'UI 新建：错误密码提示'

async function expectVisible(text: string | RegExp, timeout = 15_000) {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout })
}
const go = async (hash: string) => {
  await page.goto(`${t.base}/#/${hash}`)
  await page.waitForLoadState('domcontentloaded')
}

beforeAll(async () => {
  webDist = await mkdtemp(join(tmpdir(), 'uta-web-dist-'))
  await build({ root: join(REPO, 'packages/web'), configFile: join(REPO, 'packages/web/vite.config.ts'), logLevel: 'silent', build: { outDir: webDist, emptyOutDir: true } })
  t = await startTestServer({ webDist })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()) })
})
afterAll(async () => {
  await browser?.close()
  await t?.close()
  await rm(webDist, { recursive: true, force: true })
})

describe('主流程 · 前端页面', () => {
  it('① 用例录入：显示演示用例；表单新建用例；点击标题编辑后版本 +1', async () => {
    await go('cases')
    await expectVisible('登录成功后显示欢迎语')
    await page.getByLabel('标题').fill(NEW_CASE)
    await page.getByLabel('模块').fill('登录')
    await page.getByLabel('操作步骤（一行一句）').fill('打开「login.html」\n在「用户名」输入「bob」\n在「密码」输入「wrong」\n点击「登录」按钮')
    await page.getByLabel('预期结果（一行一句）').fill('页面显示「用户名或密码错误」')
    await page.getByLabel('测试数据（key=value，一行一个）').fill('note=来自界面')
    await page.getByRole('button', { name: '创建' }).click()
    await page.getByRole('button', { name: NEW_CASE }).click()
    await expect(page.getByLabel('标题').inputValue()).resolves.toBe(NEW_CASE)
    await page.getByLabel('备注').fill('编辑过')
    await page.getByRole('button', { name: '保存（版本 +1）' }).click()
    await expectVisible(/^v2/)
    const created = (await api.cases()).find((c) => c.title === NEW_CASE)!
    expect(created).toMatchObject({ version: 2, data: { note: '来自界面' }, notes: ['编辑过'] })
    expect(created.steps).toContain('在「密码」输入「wrong」')
  })

  it('① 用例录入：切换到清单项目，勾选条目导入', async () => {
    await page.getByLabel('项目').selectOption({ label: '清单夹具' })
    await page.getByRole('combobox').nth(1).selectOption('02-workflow.md')
    await page.getByText('02-A1').click()
    await page.getByText('02-D1').click()
    await page.getByRole('button', { name: '导入所选（2）' }).click()
    await expectVisible('已导入 2 条')
    expect((await api.cases('fixture')).map((c) => c.source).sort()).toEqual(['molardata:02-A1', 'molardata:02-D1'])
    await page.getByLabel('项目').selectOption({ label: '演示站点（本地）' })
    await expectVisible('登录成功后显示欢迎语')
  })

  it('② 步骤编译：编译 → 修改草稿 → 保存 → 批准；Agent 过程可见；其余用例一并编译批准', async () => {
    const created = (await api.cases()).find((c) => c.title === NEW_CASE)!
    await go(`plans/${created.id}`)
    await page.getByRole('button', { name: /编译/ }).click()
    await expectVisible('v1 草稿')
    await expectVisible(/propose_plan/)
    const rows = page.locator('table.steps tbody tr')
    await expect(rows.count()).resolves.toBe(5)
    await rows.nth(1).getByRole('textbox').nth(1).fill('carol')
    await page.getByRole('button', { name: '保存修改' }).click()
    await expectVisible('人工修改')
    await page.getByRole('button', { name: '✓ 批准' }).click()
    await page.getByRole('button', { name: '去执行 →' }).waitFor()
    const [plan] = await api.plans(created.id)
    expect(plan).toMatchObject({ status: 'approved', createdBy: 'human' })
    expect(plan!.steps[1]!.value).toBe('carol')

    for (const testCase of (await api.cases()).filter((c) => c.id !== created.id)) {
      await go(`plans/${testCase.id}`)
      await page.getByRole('button', { name: /编译/ }).click()
      await page.getByRole('button', { name: '✓ 批准' }).click()
      await page.getByRole('button', { name: '去执行 →' }).waitFor()
    }
  })

  it('③ 执行直播：执行全部，画面实时更新、步骤逐个完成，结束后可回放录像', async () => {
    await go('run')
    await page.getByRole('button', { name: '全选可执行' }).click()
    await page.getByRole('button', { name: '▶ 执行所选（5）' }).click()
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt="实时画面"]')?.src.startsWith('data:image/jpeg') === true, undefined, { timeout: 30_000 })
    const runs = await until(() => api.runs(), (list) => list.length >= 5 && list.every(terminal))
    expect(runs.filter((r) => r.status === 'passed').map((r) => r.caseId).length).toBe(2)

    const passed = runs.find((r) => r.status === 'passed')!
    await go(`run/${passed.id}`)
    await page.locator('video').waitFor()
    await expect(page.locator('video').getAttribute('src')).resolves.toBe(`/files/${passed.evidence.video}`)
    await expect(page.locator('table.steps .pill.passed').count()).resolves.toBe(passed.stepResults.length)
    await expectVisible('执行日志')
  })

  it('④ 失败门禁：徽标显示待处理数；写指点与补数据后重跑，全部转为已解决', async () => {
    await go('gate')
    await expect(page.locator('aside a', { hasText: '失败门禁' }).locator('.badge').textContent()).resolves.toBe('2')
    const nick = page.locator('section.finding', { hasText: '修改昵称并保存' })
    await nick.getByText('页面上现有的 button').waitFor()
    await nick.locator('textarea').fill('按钮叫「保存」')
    await nick.getByRole('button', { name: '提交修正并重跑' }).click()
    const vip = page.locator('section.finding', { hasText: '使用 VIP 兑换码兑换会员' })
    await vip.getByPlaceholder('值或文件路径').fill('VIP-2026')
    await vip.getByRole('button', { name: '补充数据并重跑' }).click()
    await until(() => api.findings(), (list) => list.filter((f) => f.status === 'resolved').length === 2)
    // 页面通过 WebSocket 事件去抖刷新，用轮询断言等待界面追上
    await expectVisible('最近关闭')
    await expect.poll(() => page.getByRole('cell', { name: '已解决' }).count(), { timeout: 10_000 }).toBe(2)
    await expect.poll(() => page.locator('aside a', { hasText: '失败门禁' }).locator('.badge').count(), { timeout: 10_000 }).toBe(0)
  })

  it('⑤ 结果审阅：预期/实际对比与证据；确认缺陷；生成报告并打开', async () => {
    await go('review')
    await expect(page.locator('.compare .expected').textContent()).resolves.toBe('共 2 项')
    await expect(page.locator('.compare .actual').textContent()).resolves.toContain('共 1 项')
    await page.locator('.evidence img').waitFor()
    await page.getByRole('button', { name: '确认缺陷' }).click()
    await expectVisible('没有待审阅的结果。')
    await page.getByRole('button', { name: '生成报告' }).click()
    await page.getByRole('cell', { name: '定稿' }).waitFor()
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: '打开 →' }).first().click()])
    await popup.getByText('与预期不符（已确认缺陷）').waitFor()
    await expect(popup.getByText('添加两条待办后计数正确').count()).resolves.toBeGreaterThan(0)
    await popup.close()
  })

  it('⑥ 组件中心：列出组件；让 Agent 起草组件并批准加载；再起草一个并拒绝', async () => {
    await go('components')
    await expectVisible('case-to-steps')
    const ask = async (text: string) => {
      await page.getByPlaceholder(/我需要一个/).fill(text)
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.draft-card').first().waitFor()
    }
    await ask('我需要一个校验导出文件内容的组件')
    await page.getByRole('button', { name: '批准并加载' }).click()
    await expect.poll(async () => (await api.get<{ skills: unknown[] }>('/api/components')).skills.length).toBe(5)
    await page.locator('.draft-card').waitFor({ state: 'detached' })
    await ask('再要一个组件')
    await page.getByRole('button', { name: '拒绝' }).click()
    await page.locator('.draft-card').waitFor({ state: 'detached' })
    expect((await api.get<{ drafts: unknown[] }>('/api/components')).drafts).toEqual([])
  })

  it('整个过程没有前端报错', () => {
    expect(pageErrors).toEqual([])
  })
})
