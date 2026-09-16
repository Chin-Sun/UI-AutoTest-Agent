/**
 * MolarData 路由与接口片段。
 * 任务 2.0 子页面由前端 src/pages/taskV2/** 自动生成，taskId 走 query 参数（写成路径参数会 404）。
 * 来源：molardata-e2e utils/app.ts；前端改路由时两边一起改。
 */

export const ROUTES = {
  login: '/login',
  dashboard: '/dashboard',
  /** /data-task 默认 redirect 到 DataTaskV2 */
  taskList: '/data-task/v2',
} as const

export const TASK_PAGES = {
  io: '/task-v2/io',
  workflow: '/task-v2/workflow',
  dataItem: '/task-v2/data-item',
  setting: '/task-v2/setting',
  member: '/task-v2/member',
  statistics: '/task-v2/statistics',
} as const

export type TaskPage = keyof typeof TASK_PAGES

export const TASK_PAGE_IDS = Object.keys(TASK_PAGES) as [TaskPage, ...TaskPage[]]

export function taskUrl(page: TaskPage, taskId: string): string {
  return `${TASK_PAGES[page]}?${new URLSearchParams({ taskId }).toString()}`
}

/**
 * 接口路径片段，只做子串匹配：前端会拼出 /api/v2//task/... 这样的双斜杠，
 * 写全路径反而匹配不上。
 */
export const ENDPOINTS = {
  taskInfo: '/task/get/task-info',
  taskList: '/task/get/task-list',
  createTask: '/task/create',
} as const

/** MongoDB ObjectId 形态：目录里的值是 taskId 还是任务名，据此判断 */
export function looksLikeTaskId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value)
}
