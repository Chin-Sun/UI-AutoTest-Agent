import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { ProjectSchema, type Project } from '@uta/core'

/** 支持 ${VAR} 与 ${VAR:-默认值} */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => env[name] || fallback || '')
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

export async function loadProjects(projectsDir: string, repoRoot: string): Promise<Map<string, Project>> {
  const projects = new Map<string, Project>()
  for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
    const file = join(projectsDir, entry.name, 'project.yaml')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const project = ProjectSchema.parse(parse(expandEnv(await readFile(file, 'utf8'))))
    project.authRoles = Object.fromEntries(Object.entries(project.authRoles).map(([role, path]) => [role, resolvePath(repoRoot, path)]))
    project.importers = Object.fromEntries(Object.entries(project.importers).map(([key, path]) => [key, resolvePath(repoRoot, path)]))
    projects.set(project.id, project)
  }
  return projects
}
