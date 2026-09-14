/** Token 用量汇总 */
import type { UsageRecord } from './types'

export interface TokenTotals {
  input: number
  output: number
  calls: number
}

export function sumUsage(records: readonly Pick<UsageRecord, 'input' | 'output' | 'calls'>[]): TokenTotals {
  return records.reduce<TokenTotals>(
    (total, record) => ({ input: total.input + record.input, output: total.output + record.output, calls: total.calls + record.calls }),
    { input: 0, output: 0, calls: 0 },
  )
}
