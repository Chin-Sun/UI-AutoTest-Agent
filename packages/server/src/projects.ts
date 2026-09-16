import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { ProjectSchema, type Project } from '@uta/core'

/** 支持 ${VAR}、${VAR:-默认值}，默认值里可以再嵌套引用：${A:-${B}}（由内向外展开） */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const pattern = /\$\{([A-Z0-9_]+)(?::-([^{}]*))?\}/g
  let current = text
  for (let depth = 0; depth < 5; depth += 1) {
    const next = current.replace(pattern, (_, name: string, fallback: string | undefined) => env[name] || fallback || '')
    if (next === current) break
    current = next
  }
  return current
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

// ---------- 仅服务端可见的项目信息 ----------

export interface AccountSecret {
  /** 账号密码都配齐时才有 */
  account?: { username: string, password: string }
  /** 缺少的环境变量名（或配置路径），用于提示人补哪一项 */
  missingVars: string[]
}

export interface ProjectSecrets {
  accounts: Record<string, AccountSecret>
}

const secrets = new WeakMap<Project, ProjectSecrets>()
const directories = new WeakMap<Project, string>()

/** 登录账号的真实值：不进入 Project，/api/projects、模型与日志都拿不到 */
export function projectSecrets(project: Project): ProjectSecrets | undefined {
  return secrets.get(project)
}

/** 项目所在目录（projects/<目录名>），积木从这里加载 */
export function projectDir(project: Project): string | undefined {
  return directories.get(project)
}

/** 从未展开的配置值里取出第一个 ${VAR} 的变量名 */
function referencedVar(raw: unknown): string | undefined {
  return typeof raw === 'string' ? /\$\{([A-Z0-9_]+)/.exec(raw)?.[1] : undefined
}

/** 未展开的 login.accounts（只用来取变量名；YAML 写法不合法时返回空） */
function rawAccounts(raw: string): Record<string, { username?: unknown, password?: unknown }> {
  try {
    const doc = parse(raw) as { login?: { accounts?: Record<string, { username?: unknown, password?: unknown }> } } | null
    return doc?.login?.accounts ?? {}
  } catch {
    return {}
  }
}

/** 把账号真实值剥离到服务端，Project 上只留变量名与是否已配置 */
function separateSecrets(project: Project, raw: string): void {
  if (project.login === undefined) return
  const templates = rawAccounts(raw)
  const accounts: Record<string, AccountSecret> = {}
  for (const [role, account] of Object.entries(project.login.accounts)) {
    const usernameVar = referencedVar(templates[role]?.username)
    const passwordVar = referencedVar(templates[role]?.password)
    const username = account.username ?? ''
    const password = account.password ?? ''
    const missingVars = [
      ...(username === '' ? [usernameVar ?? `login.accounts.${role}.username`] : []),
      ...(password === '' ? [passwordVar ?? `login.accounts.${role}.password`] : []),
    ]
    accounts[role] = { ...(missingVars.length === 0 ? { account: { username, password } } : {}), missingVars }
    project.login.accounts[role] = {
      configured: missingVars.length === 0,
      ...(usernameVar === undefined ? {} : { usernameVar }),
      ...(passwordVar === undefined ? {} : { passwordVar }),
    }
  }
  secrets.set(project, { accounts })
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
    separateSecrets(project, raw)
    directories.set(project, dir)
    projects.set(project.id, project)
  }
  return projects
}
