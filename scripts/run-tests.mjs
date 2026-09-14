#!/usr/bin/env node
/**
 * 测试守卫：包住 vitest，保证“测试生成的数据测完就删除”。
 *
 * 1. 运行前给系统临时目录和仓库里的运行态目录拍快照
 * 2. 运行 vitest（参数原样透传）
 * 3. 运行后：
 *    - 删除本轮新增、以 uta- 开头的临时目录（测试本应自行清理，残留即视为泄漏，判失败）
 *    - 顺手清理本轮新增的 playwright-artifacts-* 目录
 *    - 仓库的 data/、components/、projects/、config/ 若被测试改动，判失败（测试必须只写临时目录）
 *
 * 用法：node scripts/run-tests.mjs [vitest 参数…]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = tmpdir()
const GUARDED = ['data', 'components', 'projects', 'config']

function tempEntries() {
  return new Set(readdirSync(temp).filter((name) => name.startsWith('uta-') || name.startsWith('playwright-artifacts-')))
}

function fingerprint(dir, out = new Map()) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue
    if (entry.isDirectory()) fingerprint(path, out)
    else {
      const stat = statSync(path)
      out.set(relative(root, path), `${stat.size}:${stat.mtimeMs}`)
    }
  }
  return out
}

function snapshot() {
  return new Map(GUARDED.map((name) => [name, fingerprint(join(root, name))]))
}

function diff(before, after) {
  const changes = []
  for (const [dir, files] of after) {
    const old = before.get(dir)
    for (const [file, sig] of files) {
      if (!old.has(file)) changes.push(`新增 ${file}`)
      else if (old.get(file) !== sig) changes.push(`修改 ${file}`)
    }
    for (const file of old.keys()) if (!files.has(file)) changes.push(`删除 ${file}`)
  }
  return changes
}

const beforeTemp = tempEntries()
const beforeRepo = snapshot()

const vitest = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })

const leaked = []
for (const name of tempEntries()) {
  if (beforeTemp.has(name)) continue
  rmSync(join(temp, name), { recursive: true, force: true })
  if (name.startsWith('uta-')) leaked.push(name)
}
const repoChanges = diff(beforeRepo, snapshot())

let failed = vitest.status !== 0
console.log('\n── 测试数据清理检查 ──')
if (leaked.length > 0) {
  failed = true
  console.log(`✗ 有 ${leaked.length} 个临时目录未被测试自行清理（已强制删除）：\n  ${leaked.join('\n  ')}`)
} else {
  console.log('✓ 临时目录全部已清理')
}
if (repoChanges.length > 0) {
  failed = true
  console.log(`✗ 测试改动了仓库文件（测试只能写临时目录）：\n  ${repoChanges.slice(0, 30).join('\n  ')}`)
} else {
  console.log(`✓ 仓库运行态目录未被改动（${GUARDED.join('、')}）`)
}
process.exit(failed ? 1 : 0)
