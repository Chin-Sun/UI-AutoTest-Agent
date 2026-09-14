import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { AnthropicAdapter } from './anthropic'
import { MockAdapter } from './mock'
import { OpenAICompatibleAdapter } from './openai-compatible'
import type { LlmAdapter } from './types'

export * from './types'
export { AnthropicAdapter, MockAdapter, OpenAICompatibleAdapter }

export interface ProviderConfig {
  type: 'mock' | 'anthropic' | 'openai-compatible'
  model?: string
  baseURL?: string
  apiKeyEnv?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  refusalFallback?: boolean
  vision?: boolean
}

export interface LlmConfig {
  default: string
  providers: Record<string, ProviderConfig>
  roles?: Record<string, string>
}

export function loadLlmConfig(file: string): LlmConfig {
  const config = parse(readFileSync(file, 'utf8')) as LlmConfig
  const override = process.env['LLM_PROVIDER']
  if (override !== undefined && override !== '') config.default = override
  config.providers ??= { mock: { type: 'mock' } }
  config.providers['mock'] ??= { type: 'mock' }
  return config
}

export function createAdapter(config: ProviderConfig): LlmAdapter {
  const apiKey = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv] || undefined
  switch (config.type) {
    case 'mock':
      return new MockAdapter()
    case 'anthropic':
      return new AnthropicAdapter({
        model: config.model ?? 'claude-opus-5',
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(config.effort === undefined ? {} : { effort: config.effort }),
        ...(config.refusalFallback === undefined ? {} : { refusalFallback: config.refusalFallback }),
      })
    case 'openai-compatible':
      if (config.model === undefined) throw new Error('openai-compatible provider 需要 model')
      return new OpenAICompatibleAdapter({
        model: config.model,
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(config.vision === undefined ? {} : { vision: config.vision }),
      })
  }
}

/** 按角色路由到 provider，实例缓存复用 */
export function createLlmRouter(config: LlmConfig): { forRole(role: string): LlmAdapter, describe(): Record<string, string> } {
  const cache = new Map<string, LlmAdapter>()
  const providerFor = (role: string) => config.roles?.[role] ?? config.default
  return {
    forRole(role) {
      const name = providerFor(role)
      let adapter = cache.get(name)
      if (adapter === undefined) {
        const provider = config.providers[name]
        if (provider === undefined) throw new Error(`config/llm.yaml 中没有 provider「${name}」`)
        adapter = createAdapter(provider)
        cache.set(name, adapter)
      }
      return adapter
    },
    describe() {
      const roles = ['orchestrator', 'compiler', 'triager', 'repairer', 'reporter']
      return Object.fromEntries(roles.map((role) => {
        const name = providerFor(role)
        const provider = config.providers[name]
        return [role, `${name}${provider?.model === undefined ? '' : ` · ${provider.model}`}`]
      }))
    },
  }
}
