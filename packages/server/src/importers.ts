/**
 * molardata 功能点清单导入：testcases/0N-*.md 中形如「- [ ] **A1** 描述」的条目。
 * 主键沿用 molardata ledger 约定：文件号 + 清单编号（02-A1）。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ChecklistItem {
  key: string
  section: string
  title: string
  line: number
}

export function parseChecklist(markdown: string, fileNo: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  let section = ''
  markdown.split('\n').forEach((raw, index) => {
    const heading = /^#{2,3}\s+(.+)$/.exec(raw)
    if (heading !== null) {
      section = heading[1]!.trim()
      return
    }
    const item = /^\s*- \[[ x]\]\s+\*\*([A-Z]+-?\d+)\*\*\s+(.+)$/.exec(raw)
    if (item === null) return
    items.push({ key: `${fileNo}-${item[1]!}`, section, title: item[2]!.replace(/\*\*/g, '').trim(), line: index + 1 })
  })
  return items
}

export async function listChecklists(dir: string): Promise<{ file: string, count: number }[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort()
  return Promise.all(files.map(async (file) => ({ file, count: parseChecklist(await readFile(join(dir, file), 'utf8'), file.slice(0, 2)).length })))
}

/** 编译时交给 Agent 的清单上下文：一句话的条目要结合文件头（页面 / 角色 / 前置）与同章节条目才能理解 */
export interface ChecklistContext {
  file: string
  fileHeader: string
  section: string
  item: string
  siblings: string[]
}

export async function checklistContext(dir: string, key: string): Promise<ChecklistContext | undefined> {
  const fileNo = /^(\d{2})-/.exec(key)?.[1]
  if (fileNo === undefined || !existsSync(dir)) return undefined
  const file = (await readdir(dir)).filter((name) => /^\d{2}-.+\.md$/.test(name)).find((name) => name.startsWith(`${fileNo}-`))
  if (file === undefined) return undefined
  const markdown = await readFile(join(dir, file), 'utf8')
  const items = parseChecklist(markdown, fileNo)
  const item = items.find((candidate) => candidate.key === key)
  if (item === undefined) return undefined
  const lines = markdown.split('\n')
  const firstSection = lines.findIndex((line) => /^#{2,3}\s+/.test(line))
  const fileHeader = lines.slice(0, firstSection < 0 ? lines.length : firstSection).filter((line) => !/^-{3,}\s*$/.test(line)).join('\n').trim()
  return {
    file,
    fileHeader,
    section: item.section,
    item: `${item.key} ${item.title}`,
    siblings: items.filter((other) => other.section === item.section && other.key !== key).map((other) => `${other.key} ${other.title}`),
  }
}

export async function readChecklist(dir: string, file: string): Promise<ChecklistItem[]> {
  if (!/^\d{2}-[\w-]+\.md$/.test(file)) throw Object.assign(new Error('非法清单文件名'), { statusCode: 400 })
  return parseChecklist(await readFile(join(dir, file), 'utf8'), file.slice(0, 2))
}
