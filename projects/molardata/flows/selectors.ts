/**
 * MolarData 选择器。testid 优先、旧 CSS 兜底（双轨，来源 molardata-e2e utils/selector-helpers.ts）。
 * 前端位置：src/pages/dataTask/v2.vue、src/pages/dataTask/components/CreateTaskV2Button/**
 */

/** testid 必须打在兜底选择器命中的同一个节点上，否则并集会命中两个元素 */
export function byTestId(testId: string, fallback: string): string {
  return testId === '' ? fallback : `[data-testid="${testId}"], ${fallback}`
}

/** 应用外壳（AppLayout.vue）。页头 #appContentHeader 渲染出来才算页面真正可用 */
export const appShellSelectors = {
  contentHeader: '#appContentHeader',
} as const

export const taskListSelectors = {
  /**
   * 输入即搜索（防抖），无需回车。
   * 页头里的搜索框不一定在 .page-container 内（daily 上 molardata-e2e 的旧选择器已失效），
   * 所以不限定祖先，并用占位文字「任务号 / 名称 / 创建者」兜底
   */
  searchInput: byTestId('data-task-search-input', '.header-input input, input[placeholder*="任务号"], input[placeholder*="名称"]'),
  /** 「创建任务」按钮是 div.button.primary，按文字筛选 */
  createButton: '.button.primary',
  createButtonText: '创建任务',
} as const

export const createTaskSelectors = {
  modal: '.create-task-v2-modal',
  /** 任务名称输入框（TaskConfig.vue 的 NInput） */
  nameInput: '.create-task-config .config-input input',
  /** 工具卡片（ToolList.vue），卡片内文字为 Tools.name.* */
  toolCard: '.task-type-item',
  confirmButton: '.modal-footer .button.primary',
} as const
