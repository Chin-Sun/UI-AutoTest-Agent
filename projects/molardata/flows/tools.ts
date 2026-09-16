/**
 * MolarData 工具类型。
 * 卡片名来自前端 src/locales/languages/zh-CN.json 的 Tools.name.*（创建任务弹窗按它渲染）；
 * 导入卡片来自 molardata-e2e modules/data-import/constants.ts 的 EXPECTED_CARDS。
 */

export const TOOLS = [
  'IAT', 'CVAT', 'PCAT', 'PCAT3', 'PCAT4', 'PCAT_4D', 'VMT', 'VAT', 'QT2', 'ASR', 'NLP', 'NLP2', 'MAT', 'MASK', 'PHONE', 'LMAT',
] as const

export type Tool = (typeof TOOLS)[number]

/** 创建任务弹窗里的工具卡片名 */
export const TOOL_CARD_NAME: Record<Tool, string> = {
  IAT: '图像通用标注工具v2',
  CVAT: '图像通用标注工具',
  PCAT: '点云标注工具',
  PCAT3: '点云标注工具v3',
  PCAT4: '点云标注工具v4',
  PCAT_4D: '4D点云标注工具',
  VMT: '视频多模态工具',
  VAT: '视频通用标注工具',
  QT2: '问卷工具',
  ASR: '音频工具',
  NLP: '文本标注工具',
  NLP2: '文本标注工具 v2',
  MAT: '医疗标注工具',
  MASK: '图像MASK标注工具',
  PHONE: '音素工具',
  LMAT: '大模型标注工具',
}

/**
 * 各工具「选择上传数据类型」弹窗里的卡片。
 * 前端不是枚举，而是 src/pages/taskV2/io/composables/<TOOL>/<FORMAT>.ts 的目录列表 + common/JSON。
 */
export const EXPECTED_IMPORT_CARDS: Partial<Record<Tool, string[]>> = {
  IAT: ['文件', '文件夹', '云端数据源', '导出JSON', 'COCO', 'LabelMe', 'VOC', 'YOLO', 'JSON'],
  PCAT: ['文件夹', '云端数据源', 'KITTI', 'JSON'],
  VMT: ['文件夹导入', 'JSON'],
  QT2: ['图像文件', '文本文件', 'JSON'],
  ASR: ['文件导入', 'JSON'],
  NLP: ['文本文件', 'JSON'],
  MAT: ['文件夹', 'JSON'],
  PHONE: ['JSON'],
  LMAT: ['JSON'],
  PCAT_4D: ['JSON'],
}

/** 测试数据目录里人工预定义该工具任务的约定 key：IAT → task.iat，PCAT_4D → task.pcat_4d */
export function defaultTaskRef(tool: Tool): string {
  return `task.${tool.toLowerCase()}`
}

/** 平台自动创建的任务统一命名，便于在共享环境里识别与复用 */
export function autoTaskName(tool: Tool): string {
  return `uta-auto-${tool}`
}
