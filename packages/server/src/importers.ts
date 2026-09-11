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

export async function listChecklists(dir: string): Promise<{ file: string; count: number }[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort()
  return Promise.all(files.map(async (file) => ({ file, count: parseChecklist(await readFile(join(dir, file), 'utf8'), file.slice(0, 2)).length })))
}

export async function readChecklist(dir: string, file: string): Promise<ChecklistItem[]> {
  if (!/^\d{2}-[\w-]+\.md$/.test(file)) throw new Error('非法清单文件名')
  return parseChecklist(await readFile(join(dir, file), 'utf8'), file.slice(0, 2))
}
