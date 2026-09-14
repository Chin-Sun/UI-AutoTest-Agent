/**
 * 文件存储：data/<collection>/<id>.json，一文件一对象。
 * 原子写（临时文件 + rename）+ 进程内按 key 串行（同 dsh-agent-teams 的 withTeamLock）。
 * 单进程内一致；多进程同时写同一对象不保证一致。
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { z } from 'zod'
import {
  FeedbackSchema, FindingSchema, ReportSchema, RunSchema, StepPlanSchema, TestCaseSchema, UsageRecordSchema,
  type Feedback, type Finding, type Report, type Run, type StepPlan, type TestCase, type UsageRecord,
} from './types'
import { assertAttempt } from './gates'

const locks = new Map<string, Promise<unknown>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  locks.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

export class Collection<T extends { id: string }> {
  constructor(readonly dir: string, private readonly schema: z.ZodType<T>) {}

  private file(id: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`非法 id: ${id}`)
    return join(this.dir, `${id}.json`)
  }

  async get(id: string): Promise<T | undefined> {
    try {
      return this.schema.parse(JSON.parse(await readFile(this.file(id), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async require(id: string): Promise<T> {
    const doc = await this.get(id)
    if (doc === undefined) throw new NotFoundError(`${this.dir.split('/').pop()}/${id} 不存在`)
    return doc
  }

  async list(filter?: (doc: T) => boolean): Promise<T[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const docs: T[] = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const doc = await this.get(name.slice(0, -5))
      if (doc !== undefined && (filter === undefined || filter(doc))) docs.push(doc)
    }
    return docs
  }

  async put(doc: T): Promise<T> {
    const parsed = this.schema.parse(doc)
    await withLock(this.file(parsed.id), async () => {
      await mkdir(this.dir, { recursive: true })
      await writeFileAtomic(this.file(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`)
    })
    return parsed
  }

  /** 读-改-写在同一把锁内完成；fn 抛错则不写 */
  async update(id: string, fn: (doc: T) => T | void): Promise<T> {
    return withLock(this.file(id), async () => {
      const current = await this.require(id)
      const next = this.schema.parse(fn(current) ?? current)
      await writeFileAtomic(this.file(id), `${JSON.stringify(next, null, 2)}\n`)
      return next
    })
  }
}

export class NotFoundError extends Error {}

export function createStore(root: string) {
  const runs = new Collection<Run>(join(root, 'runs'), RunSchema)
  return {
    root,
    cases: new Collection<TestCase>(join(root, 'cases'), TestCaseSchema),
    plans: new Collection<StepPlan>(join(root, 'plans'), StepPlanSchema),
    runs,
    findings: new Collection<Finding>(join(root, 'findings'), FindingSchema),
    feedback: new Collection<Feedback>(join(root, 'feedback'), FeedbackSchema),
    reports: new Collection<Report>(join(root, 'reports'), ReportSchema),
    usage: new Collection<UsageRecord>(join(root, 'usage'), UsageRecordSchema),
    /** 执行者写 run：必须持有当前 attemptId，否则拒绝（迟到结果不能覆盖新 attempt） */
    updateRunAttempt(runId: string, attemptId: string, fn: (run: Run) => Run | void): Promise<Run> {
      return runs.update(runId, (run) => {
        assertAttempt(run, attemptId)
        return fn(run)
      })
    },
  }
}

export type Store = ReturnType<typeof createStore>
