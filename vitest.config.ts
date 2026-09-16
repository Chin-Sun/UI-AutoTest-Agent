/**
 * 统一测试入口：每个包一个 project，端到端流程单独一个 project。
 * 不要直接用 `vitest run` 跑全量——请用 `pnpm test`，它包了一层数据清理守卫（scripts/run-tests.mjs）。
 */
import { defineConfig } from 'vitest/config'

const pkg = (name: string, extra: Record<string, unknown> = {}) => ({
  extends: true as const,
  test: { name, root: `./packages/${name}`, include: ['test/**/*.test.{ts,tsx}'], ...extra },
})

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      pkg('core'),
      pkg('agent'),
      pkg('server'),
      pkg('runner', { testTimeout: 60_000 }),
      pkg('flows', { testTimeout: 60_000 }),
      pkg('web', { environment: 'jsdom' }),
      // 被测项目自带的积木（projects/<id>/flows）
      { extends: true, test: { name: 'projects', root: './projects', include: ['*/flows/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'obs-recorder', root: './components/mcp/obs-recorder', include: ['test/**/*.test.ts'] } },
      // 端到端：真实服务 + 真实浏览器，串行执行避免抢 CPU 导致超时
      { extends: true, test: { name: 'e2e', root: './tests', include: ['e2e/**/*.test.ts'], testTimeout: 240_000, hookTimeout: 240_000, fileParallelism: false } },
    ],
    coverage: {
      provider: 'v8',
      // 每个 project 的 root 不同，这里用相对各自 root 的通配
      include: ['src/**/*.{ts,tsx}', '*.ts'],
      exclude: [
        '**/main.ts', '**/main.tsx', '**/*.d.ts', '**/test/**', '**/node_modules/**',
        // 以下由端到端测试（tests/e2e）覆盖，不计入单元测试覆盖率
        'src/pages/**', 'src/App.tsx', 'src/server.ts',
      ],
      reporter: ['text-summary', 'text'],
      reportsDirectory: 'node_modules/.cache/uta-coverage',
      // 下限：防止后续改动悄悄降低覆盖率
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
})
