/** Agent 每跑完一次就落盘一条用量记录并广播，前端据此显示 Token 用量 */
import { newId, type Store, type UsageRecord } from '@uta/core'
import type { AgentUsage } from '@uta/agent'
import type { Bus } from './bus'

export function usageRecorder(store: Store, bus: Bus): (usage: AgentUsage) => Promise<UsageRecord> {
  return async (usage) => {
    const record = await store.usage.put({ id: newId('usage'), ...usage, createdAt: Date.now() })
    bus.emit({ type: 'usage', record })
    return record
  }
}
