/** 表单文本与结构化数据互转（纯函数，便于单测） */

export function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** `key=value` 每行一个；没有 `=` 或 key 为空的行忽略，value 中允许再出现 `=` */
export function parseDataLines(text: string): Record<string, string> {
  const data: Record<string, string> = {}
  for (const line of lines(text)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key !== '') data[key] = line.slice(index + 1).trim()
  }
  return data
}

export function formatDataLines(data: Record<string, string>): string {
  return Object.entries(data).map(([key, value]) => `${key}=${value}`).join('\n')
}

// ---------- Token 用量 ----------

export interface TokenTotals {
  input: number
  output: number
  calls: number
}

export const EMPTY_TOKENS: TokenTotals = { input: 0, output: 0, calls: 0 }

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return { input: a.input + b.input, output: a.output + b.output, calls: a.calls + b.calls }
}

/** 999 → 999，1500 → 1.5k，2000 → 2k，1234567 → 1.2M */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  const [value, unit] = count < 999_950 ? [count / 1000, 'k'] : [count / 1_000_000, 'M']
  return `${value.toFixed(1).replace(/\.0$/, '')}${unit}`
}
