import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { ProjectSchema, type Project } from '@uta/core'

/** 支持 ${VAR} 与 ${VAR:-默认值} */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => env[name] || fallback || '')
}

/** 解析 .env：KEY=value，支持 export 前缀、引号与行尾注释 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw)
    if (match === null) continue
    const value = match[2]!.trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    env[match[1]!] = quoted !== null ? quoted[2]! : value.startsWith('#') ? '' : value.replace(/\s+#.*$/, '')
  }
  return env
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

/** envFile 里的变量垫在环境变量之下：非空的环境变量优先 */
async function withEnvFile(config: unknown, repoRoot: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const envFile = (config as { envFile?: unknown } | null)?.envFile
  if (typeof envFile !== 'string' || envFile === '') return env
  const path = resolvePath(repoRoot, envFile)
  if (!existsSync(path)) return env
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  return { ...parseEnvFile(await readFile(path, 'utf8')), ...present }
}

/**
 * @param env 展开 ${VAR} 用的环境变量；显式传入而不是改写 process.env，
 *            同一进程内启动多个服务（测试）时互不干扰
 */
export async function loadProjects(projectsDir: string, repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<Map<string, Project>> {
  const projects = new Map<string, Project>()
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    const dir = join(projectsDir, entry.name)
    const file = join(dir, 'project.yaml')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const raw = await readFile(file, 'utf8')
    const vars = await withEnvFile(parse(expandEnv(raw, env)), repoRoot, env)
    // 测试数据目录：只有登记的条目会交给模型，envFile 里的其他变量不会进入项目配置
    const dataFile = join(dir, 'test-data.yaml')
    const catalog = existsSync(dataFile) ? (parse(expandEnv(await readFile(dataFile, 'utf8'), vars)) as { entries?: unknown } | null)?.entries ?? [] : []
    const project = ProjectSchema.parse({ ...(parse(expandEnv(raw, vars)) as object | null), testData: catalog })
    project.authRoles = Object.fromEntries(Object.entries(project.authRoles).map(([role, path]) => [role, resolvePath(repoRoot, path)]))
    project.importers = Object.fromEntries(Object.entries(project.importers).map(([key, path]) => [key, resolvePath(repoRoot, path)]))
    if (project.envFile !== undefined) project.envFile = resolvePath(repoRoot, project.envFile)
    project.testData = project.testData.map((item) => (item.tags.includes('path') && item.value ? { ...item, value: resolvePath(repoRoot, item.value) } : item))
    projects.set(project.id, project)
  }
  return projects
}
