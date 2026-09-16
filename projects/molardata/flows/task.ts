/**
 * MolarData 任务积木：确保有可用的工具任务、打开任务子页面。
 * 通过真实页面操作并监听前端自己发出的接口响应，不另外拼请求头（token、空间等由前端负责）。
 */
import { defineFlow, FlowError, z, type FlowContext, type Response } from '@uta/flows'
import { ENDPOINTS, looksLikeTaskId, ROUTES, TASK_PAGE_IDS, taskUrl, type TaskPage } from './routes'
import { appShellSelectors, createTaskSelectors, taskListSelectors } from './selectors'
import { autoTaskName, defaultTaskRef, TOOL_CARD_NAME, TOOLS, type Tool } from './tools'

interface TaskRecord {
  _id?: string
  id?: string
  name?: string
  type?: string
}

export interface FoundTask {
  taskId: string
  taskName: string
}

/** 业务接口包装 { code, data }：code 为 200 / 0 才算成功；旧格式直接返回 body */
export async function businessData(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => undefined) as { code?: unknown, data?: unknown } | undefined
  if (body === undefined || body === null) return undefined
  if (body.code === undefined || body.code === null) return body
  return body.code === 200 || body.code === 0 ? body.data : undefined
}

/** 任务列表接口的 data 可能是数组，也可能是 { data | list: [] } 分页结构 */
export function taskRecords(data: unknown): TaskRecord[] {
  if (Array.isArray(data)) return data as TaskRecord[]
  const wrapped = data as { data?: unknown, list?: unknown } | undefined
  if (Array.isArray(wrapped?.data)) return wrapped.data as TaskRecord[]
  if (Array.isArray(wrapped?.list)) return wrapped.list as TaskRecord[]
  return []
}

/**
 * 打开任务子页面并等待 task-info 返回。页面白屏时重试一次：
 * 被测环境偶发 TLS 断连会让 task-info 挂掉、整页白屏（来源 molardata-e2e ImportPage.goto）。
 * @returns 任务信息；任务不存在或无权访问时为 undefined
 */
export async function openTask(ctx: FlowContext, taskId: string, page: TaskPage): Promise<TaskRecord | undefined> {
  const broken: string[] = []
  const onFailed = (request: { url(): string, failure(): { errorText: string } | null }) => broken.push(`${request.url()}（${request.failure()?.errorText ?? '请求失败'}）`)
  ctx.page.on('requestfailed', onFailed)
  try {
    for (let attempt = 1; ; attempt += 1) {
      const infoResponse = ctx.page.waitForResponse((response) => response.url().includes(ENDPOINTS.taskInfo), { timeout: ctx.timeouts.navigation })
      void infoResponse.catch(() => undefined)
      await ctx.page.goto(taskUrl(page, taskId), { waitUntil: 'domcontentloaded' })
      const response = await infoResponse.catch(() => undefined)
      if (response !== undefined && (response.status() === 401 || response.status() === 403)) {
        throw new FlowError('env', `任务信息接口返回 HTTP ${response.status()}：登录态已失效（同一账号在别处登录会顶掉会话），请重新执行让平台重新登录`)
      }
      if (response !== undefined && response.ok()) {
        const record = await businessData(response) as TaskRecord | undefined
        // 接口返回里既没有名称也没有类型，说明不是有效的任务信息（例如被拦截返回的错误体）
        return record !== undefined && (record.name !== undefined || record.type !== undefined) ? record : undefined
      }
      if (response === undefined && new URL(ctx.page.url()).pathname.startsWith(ROUTES.login)) {
        throw new FlowError('env', `打开 ${taskUrl(page, taskId)} 时被带回登录页：登录态已失效，请重新执行让平台重新登录`)
      }
      if (attempt >= 2) {
        const detail = response === undefined ? `${ctx.timeouts.navigation}ms 内没有等到任务信息接口` : `任务信息接口返回 HTTP ${response.status()}`
        if (response !== undefined && response.status() < 500) return undefined
        throw new FlowError('env', `打开任务页面失败（${taskUrl(page, taskId)}）：${detail}${broken.length > 0 ? `；失败请求：${broken.slice(0, 5).join('；')}` : ''}。可能是网络 / 后端问题，或登录态失效被带回登录页`)
      }
      ctx.log(`任务：${taskUrl(page, taskId)} 没有加载出来，重试一次`)
      broken.length = 0
    }
  } finally {
    ctx.page.off('requestfailed', onFailed)
  }
}

async function verifyTaskId(ctx: FlowContext, taskId: string, tool: Tool): Promise<FoundTask | undefined> {
  const info = await openTask(ctx, taskId, 'io')
  if (info === undefined) {
    ctx.log(`任务：${taskId} 不存在或无权访问`)
    return undefined
  }
  if (info.type !== undefined && info.type !== tool) {
    ctx.log(`任务：${taskId} 的工具类型是 ${info.type}，不是 ${tool}`)
    return undefined
  }
  return { taskId, taskName: info.name ?? taskId }
}

/** 在任务列表按名称搜索（列表只支持按名称 / ID / 负责人搜索，不能按工具类型筛选） */
async function searchTask(ctx: FlowContext, name: string, tool: Tool): Promise<FoundTask | undefined> {
  const { page } = ctx
  await page.goto(ROUTES.taskList, { waitUntil: 'domcontentloaded' })
  const input = page.locator(taskListSelectors.searchInput).first()
  try {
    await input.waitFor({ state: 'visible', timeout: ctx.timeouts.navigation })
  } catch {
    throw new FlowError('env', `任务列表页 ${ROUTES.taskList} 没有加载出搜索框：可能是网络问题，或登录态失效`)
  }
  const listResponse = page.waitForResponse(
    (response) => response.url().includes(ENDPOINTS.taskList) && (response.request().postData() ?? '').includes(name),
    { timeout: ctx.timeouts.navigation },
  )
  void listResponse.catch(() => undefined)
  await input.fill(name)
  const response = await listResponse.catch(() => undefined)
  if (response === undefined) throw new FlowError('env', `搜索任务「${name}」时任务列表接口没有返回`)
  const match = taskRecords(await businessData(response)).find((item) => item.name === name && (item.type === undefined || item.type === tool))
  const id = match?._id ?? match?.id
  return id === undefined ? undefined : { taskId: String(id), taskName: name }
}

/** 通过「创建任务」弹窗新建：空白设置 + 基础工作流（前端自动带 packageMode=IMPORT，即导入时分批） */
async function createTask(ctx: FlowContext, name: string, tool: Tool): Promise<FoundTask> {
  const { page } = ctx
  await page.goto(ROUTES.taskList, { waitUntil: 'domcontentloaded' })
  const button = page.locator(taskListSelectors.createButton, { hasText: taskListSelectors.createButtonText }).first()
  try {
    await button.waitFor({ state: 'visible', timeout: ctx.timeouts.navigation })
  } catch {
    throw new FlowError('data-missing', '任务列表页没有「创建任务」按钮：当前账号可能没有创建任务的权限。请在测试数据目录里预定义一个任务，或换有权限的账号')
  }
  await button.click()
  const modal = page.locator(createTaskSelectors.modal).first()
  await modal.waitFor({ state: 'visible' })
  await modal.locator(createTaskSelectors.nameInput).first().fill(name)
  const card = modal.locator(createTaskSelectors.toolCard).filter({ has: page.getByText(TOOL_CARD_NAME[tool], { exact: true }) }).first()
  if (await card.count() === 0) throw new FlowError('data-missing', `创建任务弹窗里没有工具「${TOOL_CARD_NAME[tool]}」：当前空间可能没有开通 ${tool}`)
  await card.click()
  const created = page.waitForResponse((response) => response.url().includes(ENDPOINTS.createTask) && response.request().method() === 'POST', { timeout: ctx.timeouts.navigation })
  void created.catch(() => undefined)
  await modal.locator(createTaskSelectors.confirmButton).first().click()
  const response = await created.catch(() => undefined)
  if (response === undefined || response.status() >= 400) throw new FlowError('env', `创建任务「${name}」失败：${response === undefined ? '接口没有返回' : `HTTP ${response.status()}`}`)
  const data = await businessData(response)
  if (data === undefined) throw new FlowError('env', `创建任务「${name}」失败：接口返回业务错误`)
  const record = data as TaskRecord & { taskId?: string }
  const id = typeof data === 'string' ? data : record._id ?? record.id ?? record.taskId
  if (id !== undefined) return { taskId: String(id), taskName: name }
  // 创建接口没有返回 id 时回到列表按名称找
  const listed = await searchTask(ctx, name, tool)
  if (listed === undefined) throw new FlowError('env', `任务「${name}」创建成功，但在任务列表里找不到`)
  return listed
}

export const ensureTask = defineFlow({
  id: 'molar.ensureTask',
  description: '确保有一个指定工具类型的任务可用，输出 taskId、taskName。查找顺序：人工预定义的任务（ref 指向的测试数据目录条目；不传 ref 时自动使用 task.<工具小写>，如 task.iat；值为 taskId 或任务名）→ 之前自动创建并记住的任务 → 任务列表里名为 uta-auto-<工具> 的任务 → 都没有就通过「创建任务」弹窗新建并记住。新建的任务没有标签和数据，依赖标签 / 已有数据的用例必须有人工预定义任务。',
  params: z.object({
    tool: z.enum(TOOLS).describe('工具类型，如 IAT'),
    ref: z.string().optional().describe('测试数据目录条目 key，如 task.iat；不传时默认 task.<工具小写>'),
  }),
  outputs: ['taskId', 'taskName'],
  async run(ctx, { tool, ref: explicitRef }) {
    // 人工预定义的数据永远优先：不传 ref 时按约定 key 找目录条目
    const ref = explicitRef ?? (ctx.catalog.some((item) => item.key === defaultTaskRef(tool)) ? defaultTaskRef(tool) : undefined)
    if (ref !== undefined) {
      const entry = ctx.catalog.find((item) => item.key === ref)
      if (entry === undefined) throw new FlowError('step', `测试数据目录里没有 ${ref}`)
      if (entry.value !== undefined && entry.value !== '') {
        const found = looksLikeTaskId(entry.value) ? await verifyTaskId(ctx, entry.value, tool) : await searchTask(ctx, entry.value, tool)
        if (found !== undefined) {
          ctx.log(`任务：使用目录 ${ref} 预定义的任务「${found.taskName}」（${found.taskId}）`)
          return { ...found }
        }
        ctx.log(`任务：目录 ${ref} 的值「${entry.value}」没有对应的 ${tool} 任务，继续查找`)
      }
    }

    const stateKey = `task.${tool}`
    const remembered = await ctx.state.get<FoundTask>(stateKey)
    if (remembered !== undefined) {
      const found = await verifyTaskId(ctx, remembered.taskId, tool)
      if (found !== undefined) {
        ctx.log(`任务：复用之前自动创建的任务「${found.taskName}」（${found.taskId}）`)
        return { ...found }
      }
      await ctx.state.delete(stateKey)
    }

    const name = autoTaskName(tool)
    const listed = await searchTask(ctx, name, tool)
    if (listed !== undefined) {
      await ctx.state.set(stateKey, listed)
      ctx.log(`任务：在列表中找到「${name}」（${listed.taskId}），已记住`)
      return { ...listed }
    }

    const created = await createTask(ctx, name, tool)
    await ctx.state.set(stateKey, created)
    ctx.log(`任务：新建「${name}」（${created.taskId}），已记住，下次复用`)
    return { ...created }
  },
})

export const openTaskPage = defineFlow({
  id: 'molar.openTaskPage',
  description: '打开任务的子页面并等待任务信息加载完成（白屏会重试一次）。page 取值：io=导入导出页，workflow=工作流画布，dataItem=条目页，setting=任务设置，member=成员，statistics=统计',
  params: z.object({
    taskId: z.string().min(1).describe('通常引用 molar.ensureTask 的输出 ${data.taskId}'),
    page: z.enum(TASK_PAGE_IDS).describe('任务子页面'),
  }),
  outputs: [],
  async run(ctx, { taskId, page }) {
    const info = await openTask(ctx, taskId, page)
    if (info === undefined) throw new FlowError('assertion', `任务 ${taskId} 不存在或当前账号无权访问`)
    // task-info 返回时页面往往还没渲染：等页头出现，后续步骤才能稳定定位
    try {
      await ctx.page.locator(appShellSelectors.contentHeader).first().waitFor({ state: 'visible', timeout: ctx.timeouts.navigation })
    } catch {
      throw new FlowError('env', `任务「${info.name ?? taskId}」的 ${page} 页没有渲染出来（任务信息已返回）`)
    }
    if (new URL(ctx.page.url()).pathname.startsWith(ROUTES.login)) {
      throw new FlowError('env', `打开任务页后被带回登录页：登录态已失效，请重新执行让平台重新登录`)
    }
    ctx.log(`任务：已打开「${info.name ?? taskId}」的 ${page} 页`)
  },
})
