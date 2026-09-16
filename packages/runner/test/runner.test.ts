/** 真实浏览器：demo 站点上的四类结果 + 全部动作 + 取消 + 登录态 + 钩子 */
import { existsSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LoginConfigSchema, type Step } from '@uta/core'
import { defineFlow, FlowError, z } from '@uta/flows'
import { runPlan, type RunPlanOptions } from '../src'
import { startSite, type StaticSite } from './support'

let site: StaticSite
beforeAll(async () => { site = await startSite() })
afterAll(async () => site.close())

let seq = 0
const run = (steps: Step[], extra: Partial<RunPlanOptions> = {}) => {
  const name = `run${++seq}`
  return runPlan({
    steps, data: {}, baseURL: site.baseURL, evidenceDir: join(site.evidence, name), evidenceRel: `evidence/${name}`,
    actionTimeoutMs: 1_500, assertTimeoutMs: 1_500, ...extra,
  })
}

describe('上传', () => {
  const goto: Step = { id: 's1', action: 'goto', value: 'chooser.html' }

  it('target 不是 file input 时当作触发器：点击并接住文件选择器；多个文件用换行分隔', async () => {
    const a = join(site.evidence, 'a.png')
    const b = join(site.evidence, 'b.png')
    await writeFile(a, 'a')
    await writeFile(b, 'b')
    const result = await run([
      goto,
      { id: 's2', action: 'upload', target: { text: '文件', exact: true }, value: `${a}\n${b}` },
      { id: 's3', action: 'assertText', target: { testId: 'picked' }, expect: 'a.png,b.png' },
    ])
    expect(result.status).toBe('passed')
    expect(result.stepResults[1]?.actual).toBe('a.png，b.png')
  })

  it('上一步点击已唤起选择器、upload 的 target 在页面上不存在：接住已弹出的选择器', async () => {
    const c = join(site.evidence, 'c.png')
    await writeFile(c, 'c')
    const result = await run([
      goto,
      { id: 's2', action: 'click', target: { text: '文件', exact: true } },
      { id: 's3', action: 'upload', target: { css: 'input[type="file"]' }, value: c },
      { id: 's4', action: 'assertText', target: { testId: 'picked' }, expect: 'c.png' },
    ])
    expect(result.status).toBe('passed')
  })

  it('文件不存在判为缺数据并写明路径；既没有目标也没有选择器时报步骤问题', async () => {
    const absent = await run([goto, { id: 's2', action: 'upload', target: { text: '文件', exact: true }, value: '/no/such/file.png' }])
    expect(absent.stepResults[1]).toMatchObject({ status: 'failed', error: { kind: 'missing-data', message: '上传文件不存在：/no/such/file.png' } })
    const file = join(site.evidence, 'd.png')
    await writeFile(file, 'd')
    const nowhere = await run([goto, { id: 's2', action: 'upload', target: { css: 'input.nope' }, value: file }])
    expect(nowhere.stepResults[1]?.error?.kind).toBe('locator')
    expect(nowhere.stepResults[1]?.error?.message).toContain('没有弹出文件选择器')
  })
})

describe('积木与会话', () => {
  const pickUser = defineFlow({
    id: 'demo.pickUser',
    description: '选一个用户名',
    params: z.object({ prefix: z.string() }),
    outputs: ['user'],
    run: async (ctx, { prefix }) => {
      ctx.log(`pick ${prefix}`)
      return { user: `${prefix}alice` }
    },
  })

  it('use 步骤：参数里的绑定先解析；输出写回数据，后续步骤可引用（执行前不算缺数据）', async () => {
    const logs: string[] = []
    const result = await run([
      { id: 's1', action: 'use', flow: 'demo.pickUser', params: { prefix: '${data.prefix}' } },
      { id: 's2', action: 'goto', value: 'login.html' },
      { id: 's3', action: 'fill', target: { label: '用户名' }, value: '${data.user}' },
      { id: 's4', action: 'fill', target: { label: '密码' }, value: 'secret' },
      { id: 's5', action: 'click', target: { role: 'button', name: '登录' } },
      { id: 's6', action: 'assertText', target: { testId: 'welcome' }, expect: '欢迎，mr-alice' },
    ], { data: { prefix: 'mr-' }, flows: [pickUser], hooks: { onLog: (message) => logs.push(message) } })
    expect(result.status).toBe('passed')
    expect(result.stepResults[0]).toMatchObject({ status: 'passed', actual: 'user=mr-alice' })
    expect(logs).toContain('pick mr-')
    expect(logs).toContain('▶ s1 use demo.pickUser')
  })

  it('积木不存在按步骤问题记录；积木抛 FlowError 按它声明的归因记录', async () => {
    const missing = await run([{ id: 's1', action: 'use', flow: 'demo.nope' }, { id: 's2', action: 'assertUrl', expect: 'x' }], { flows: [pickUser] })
    expect(missing.stepResults[0]).toMatchObject({ status: 'failed', error: { kind: 'locator', message: '项目没有积木 demo.nope' } })
    const broken = defineFlow({ ...pickUser, id: 'demo.broken', run: async () => { throw new FlowError('data-missing', '缺少订单') } })
    const failed = await run([{ id: 's1', action: 'use', flow: 'demo.broken', params: { prefix: '' } }], { flows: [broken] })
    expect(failed.stepResults[0]?.error).toEqual({ kind: 'missing-data', message: '缺少订单' })
  })

  it('会话失败：不执行任何步骤，第一步记为失败并附截图', async () => {
    const result = await run([{ id: 's1', action: 'goto', value: 'login.html' }, { id: 's2', action: 'assertUrl', expect: 'login' }], {
      session: { config: LoginConfigSchema.parse({ url: 'login.html' }), role: 'admin', missingVars: ['DEMO_PASSWORD'], authFile: join(site.evidence, 'auth', 'admin.json') },
    })
    expect(result.status).toBe('failed')
    expect(result.stepResults[0]).toMatchObject({ stepId: 's1', status: 'failed', error: { kind: 'missing-data' }, screenshot: `evidence/run${seq}/session.png` })
    expect(result.stepResults[0]?.error?.message).toBe('登录会话失败：缺少 admin 的登录账号：请在 .env 中填写 DEMO_PASSWORD')
    expect(result.stepResults[1]).toEqual({ stepId: 's2', status: 'skipped', durationMs: 0 })
  })

  it('跳转超时判为 navigation；localStorage 在页面脚本执行前写入', async () => {
    const result = await run([
      { id: 's1', action: 'goto', value: 'login.html' },
      { id: 's2', action: 'assertUrl', expect: 'login' },
    ], { localStorage: { LOCALE: 'zh-CN' }, navigationTimeoutMs: 5_000 })
    expect(result.status).toBe('passed')
  })
})

describe('demo 站点四类结果', () => {
  it('登录通过：每步截图，产出录像与 trace，推送画面帧', async () => {
    const frames: string[] = []
    const result = await run([
      { id: 's1', action: 'goto', value: 'login.html' },
      { id: 's2', action: 'fill', target: { label: '用户名' }, value: '${data.user}' },
      { id: 's3', action: 'fill', target: { label: '密码' }, value: 'secret' },
      { id: 's4', action: 'click', target: { role: 'button', name: '登录' } },
      { id: 's5', action: 'assertText', target: { testId: 'welcome' }, expect: '欢迎，alice' },
    ], { data: { user: 'alice' }, hooks: { onFrame: (frame) => frames.push(frame) } })
    expect(result.status).toBe('passed')
    expect(result.stepResults.map((r) => r.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed'])
    expect(result.stepResults[4]?.actual).toBe('欢迎，alice')
    expect(frames.length).toBeGreaterThan(0)
    const dir = join(site.evidence, `run${seq}`)
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(5)
    expect((await stat(join(dir, 'video.webm'))).size).toBeGreaterThan(0)
    expect((await stat(join(dir, 'trace.zip'))).size).toBeGreaterThan(0)
    expect(result.video).toBe(`evidence/run${seq}/video.webm`)
    expect(result.stepResults[0]?.screenshot).toBe(`evidence/run${seq}/step-01-s1.png`)
  })

  it('按钮名写错 → locator，附 ARIA 快照，后续步骤 skipped', async () => {
    const result = await run([
      { id: 's1', action: 'goto', value: 'profile.html' },
      { id: 's2', action: 'click', target: { role: 'button', name: '提交' } },
      { id: 's3', action: 'assertVisible', target: { text: '已保存' } },
    ])
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/^s2:/)
    expect(result.stepResults[1]?.error?.kind).toBe('locator')
    expect(result.stepResults[1]?.ariaSnapshot).toContain('button "保存"')
    expect(result.stepResults[2]).toEqual({ stepId: 's3', status: 'skipped', durationMs: 0 })
  })

  it('埋点缺陷 → assertion，记录实际值', async () => {
    const result = await run([
      { id: 's1', action: 'goto', value: 'todos.html' },
      { id: 's2', action: 'fill', target: { placeholder: '新待办' }, value: '买牛奶' },
      { id: 's3', action: 'click', target: { role: 'button', name: '添加' } },
      { id: 's4', action: 'fill', target: { placeholder: '新待办' }, value: '写周报' },
      { id: 's5', action: 'click', target: { role: 'button', name: '添加' } },
      { id: 's6', action: 'assertText', target: { testId: 'todo-count' }, expect: '共 2 项' },
    ])
    expect(result.stepResults[5]).toMatchObject({ status: 'failed', actual: '共 1 项', error: { kind: 'assertion' } })
  })

  it('缺数据在执行前判定，不启动浏览器、不产生证据', async () => {
    const result = await run([
      { id: 's1', action: 'goto', value: 'redeem.html' },
      { id: 's2', action: 'fill', target: { label: '兑换码' }, value: '${data.vipCode}' },
      { id: 's3', action: 'assertVisible', target: { text: '兑换成功' } },
    ])
    expect(result).toEqual({ status: 'failed', error: '缺少测试数据：vipCode', stepResults: [expect.objectContaining({ stepId: 's2', error: { kind: 'missing-data', message: '缺少测试数据：vipCode' } })] })
    expect(existsSync(join(site.evidence, `run${seq}`))).toBe(false)
  })
})

describe('全部动作', () => {
  it('17 个动作在夹具页上全部通过', async () => {
    const upload = join(site.evidence, 'upload.txt')
    await writeFile(upload, 'hello')
    const steps: Step[] = [
      { id: 'goto', action: 'goto', value: 'controls.html' },
      { id: 'hidden', action: 'assertHidden', target: { text: '加载中' } },
      { id: 'select', action: 'select', target: { label: '城市' }, value: '上海' },
      { id: 'select-ok', action: 'assertText', target: { testId: 'city-out' }, expect: '城市=sh' },
      { id: 'check', action: 'check', target: { label: '同意协议' } },
      { id: 'check-ok', action: 'assertText', target: { testId: 'agree-out' }, expect: '已同意' },
      { id: 'uncheck', action: 'uncheck', target: { label: '同意协议' } },
      { id: 'uncheck-ok', action: 'assertText', target: { testId: 'agree-out' }, expect: '未同意' },
      { id: 'upload', action: 'upload', target: { label: '附件' }, value: upload },
      { id: 'upload-ok', action: 'assertText', target: { testId: 'file-out' }, expect: 'upload.txt' },
      { id: 'fill', action: 'fill', target: { label: '搜索' }, value: '猫' },
      { id: 'press-target', action: 'press', target: { label: '搜索' }, value: 'Enter' },
      { id: 'press-ok', action: 'assertText', target: { testId: 'search-out' }, expect: '已搜索：猫' },
      { id: 'press-page', action: 'press', value: 'Escape' },
      { id: 'press-page-ok', action: 'assertVisible', target: { text: '按下了 Escape' } },
      { id: 'hover', action: 'hover', target: { text: '悬停我' } },
      { id: 'hover-ok', action: 'assertText', target: { testId: 'hover-out' }, expect: '提示内容' },
      { id: 'later', action: 'click', target: { role: 'button', name: '稍后显示' } },
      { id: 'wait-target', action: 'waitFor', target: { text: '延迟出现' } },
      { id: 'wait-ms', action: 'waitFor', value: '50' },
      { id: 'count', action: 'assertCount', target: { css: '[data-testid="items"] li' }, expect: '3' },
      { id: 'value', action: 'assertValue', target: { label: '备注' }, expect: '初始值' },
      { id: 'link', action: 'click', target: { role: 'link', name: '完成' } },
      { id: 'url-sub', action: 'assertUrl', expect: '#done' },
      { id: 'url-re', action: 'assertUrl', expect: '/controls\\.html#done$/' },
      { id: 'shot', action: 'screenshot', value: '最终' },
    ]
    const result = await run(steps)
    expect(result.stepResults.filter((r) => r.status !== 'passed')).toEqual([])
    expect(new Set(steps.map((s) => s.action)).size).toBe(17)
  })

  it.each([
    ['assertHidden 仍可见', { id: 'x', action: 'assertHidden', target: { text: '悬停我' } }, 'assertion', '可见'],
    ['assertValue 不符', { id: 'x', action: 'assertValue', target: { label: '备注' }, expect: '别的' }, 'assertion', '初始值'],
    ['assertCount 不符', { id: 'x', action: 'assertCount', target: { css: 'li' }, expect: '5' }, 'assertion', '3'],
    ['assertUrl 不符', { id: 'x', action: 'assertUrl', expect: 'nowhere' }, 'assertion', undefined],
    ['assertVisible 不存在', { id: 'x', action: 'assertVisible', target: { text: '不存在的文字' } }, 'assertion', '不可见或不存在'],
    ['多个同名按钮（strict mode）', { id: 'x', action: 'click', target: { role: 'button', name: '重复' } }, 'locator', undefined],
    ['waitFor 等不到', { id: 'x', action: 'waitFor', target: { text: '永远不会出现' }, timeoutMs: 500 }, 'locator', undefined],
  ] as [string, Step, string, string | undefined][])('%s → %s', async (_, step, kind, actual) => {
    const result = await run([{ id: 'goto', action: 'goto', value: 'controls.html' }, step])
    const failed = result.stepResults[1]
    // actual 为 undefined 的用例只校验错误类型
    expect({ kind: failed?.error?.kind, actual: actual === undefined ? undefined : failed?.actual }).toEqual({ kind, actual })
  })

  it('无法连接的地址 → navigation', async () => {
    const result = await run([{ id: 's1', action: 'goto', value: 'http://127.0.0.1:1/' }, { id: 's2', action: 'assertUrl', expect: 'x' }])
    expect(result.stepResults[0]?.error?.kind).toBe('navigation')
  })
})

describe('控制与上下文', () => {
  it('钩子按步骤顺序触发；取消后剩余步骤 skipped', async () => {
    const events: string[] = []
    const controller = new AbortController()
    const result = await run([
      { id: 's1', action: 'goto', value: 'controls.html' },
      { id: 's2', action: 'assertCount', target: { css: 'li' }, expect: '3' },
      { id: 's3', action: 'assertCount', target: { css: 'li' }, expect: '3' },
    ], {
      signal: controller.signal,
      hooks: {
        onStepStart: (step, index) => events.push(`start:${step.id}:${index}`),
        onStepEnd: (r, index) => {
          events.push(`end:${r.stepId}:${index}`)
          if (r.stepId === 's2') controller.abort()
        },
        onLog: (message) => events.push(`log:${message.slice(0, 1)}`),
      },
    })
    expect(result.status).toBe('cancelled')
    expect(result.stepResults.map((r) => r.status)).toEqual(['passed', 'passed', 'skipped'])
    expect(events.filter((e) => !e.startsWith('log'))).toEqual(['start:s1:0', 'end:s1:0', 'start:s2:1', 'end:s2:1'])
    expect(events.filter((e) => e.startsWith('log')).length).toBe(4)
  })

  it('storageState 生效（复用登录态）', async () => {
    const statePath = join(site.evidence, 'state.json')
    await writeFile(statePath, JSON.stringify({
      cookies: [{ name: 'token', value: 'abc', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    }))
    const result = await run([
      { id: 's1', action: 'goto', value: 'cookie.html' },
      { id: 's2', action: 'assertText', target: { testId: 'cookie' }, expect: 'token=abc' },
    ], { storageState: statePath })
    expect(result.status).toBe('passed')
  })

  it('target 中的数据绑定在定位前解析', async () => {
    const result = await run([
      { id: 's1', action: 'goto', value: 'controls.html' },
      { id: 's2', action: 'assertVisible', target: { text: '${data.word}' } },
    ], { data: { word: '悬停我' } })
    expect(result.status).toBe('passed')
  })
})
