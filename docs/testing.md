# 测试说明

> **一句话总结**：`pnpm check` 一条命令跑完规范检查、类型检查和全部测试；测试用真实服务与真实浏览器，产生的数据在结束时全部删除，仓库不会被写脏。

**本文适合谁**：要改这个平台的人。改完代码后按本文跑一遍，就能知道有没有改坏；新增功能时按本文的分层决定测试写在哪里。

## 目录

- [测试分层](#测试分层)
- [常用命令](#常用命令)
- [测试数据的清理保证](#测试数据的清理保证)
- [写新测试](#写新测试)
- [规范检查](#规范检查)
- [FAQ](#faq)

## 测试分层

| 层次 | 位置 | 覆盖什么 | 是否启动浏览器 |
| --- | --- | --- | --- |
| 门禁与存储 | `packages/core/test` | 领域模型 schema、门禁规则（状态 × 反馈全矩阵）、原子写与并发、attempt 令牌 | 否 |
| Agent | `packages/agent/test` | 规则引擎（句式、归因、修正）、Agent Loop、组件注册表（含真实 MCP 子进程）、两个 LLM 适配器（假 fetch）、服务层 | 否 |
| 执行器 | `packages/runner/test` | 17 个动作、错误分类、定位映射、取消、登录态、证据产出 | **是** |
| 服务端 | `packages/server/test` | Pipeline 全部门禁分支（注入假执行器）、HTTP 接口、导入器、项目加载、报告渲染、事件总线、前后端事件契约 | 否 |
| 前端 | `packages/web/test` | 表单与标签纯函数、API 客户端与 WebSocket、共用组件交互 | 否（jsdom） |
| 组件 | `components/mcp/obs-recorder/test` | OBS 组件的工具注册与录制控制（连假 OBS 服务） | 否 |
| 端到端 | `tests/e2e` | 主流程（API）、主流程（浏览器操作前端）、边界流程 | **是** |

端到端测试全部使用 `mock` 模型（规则引擎），不联网、不产生模型费用。服务端的 `llmProvider: 'mock'` 会覆盖 `config/llm.yaml` 与 `LLM_PROVIDER`，即使本机配了真实模型也不会被调用。

## 常用命令

```bash
pnpm check          # 规范检查 + 类型检查 + 全部测试（提交前跑这个）
pnpm test           # 全部测试（单元 + 端到端）
pnpm test:unit      # 只跑单元测试，秒级
pnpm test:e2e       # 只跑端到端测试
pnpm test:coverage  # 单元测试覆盖率
pnpm test:watch     # 开发时监听模式
pnpm lint           # ESLint + markdownlint
pnpm typecheck      # 全部包类型检查
```

**首次运行前**：`pnpm install && pnpm playwright:install`（下载 Chromium）。

**覆盖率**：`pnpm test:coverage` 统计单元测试覆盖率，当前语句 93.7%、分支 87.6%、函数 91.1%、行 95.4%；低于配置下限（85 / 80 / 85 / 85）即判失败。页面组件（`src/pages`、`App.tsx`）与服务启动装配（`server.ts`）不计入，它们由端到端测试覆盖。

单个包也可以单独跑：`pnpm --filter @uta/core test`，或只跑一个文件：`pnpm test --project e2e e2e/ui-flow.test.ts`。

**预期**：`pnpm test` 结束时打印各项通过数，并以下面两行收尾。

```text
── 测试数据清理检查 ──
✓ 临时目录全部已清理
✓ 仓库运行态目录未被改动（data、components、projects、config）
```

## 测试数据的清理保证

测试会真实写盘：用例、计划、执行记录、截图、录像、trace、组件草稿。保证不留垃圾、不污染仓库的机制有两层：

1. **测试自己清理**：所有测试把数据写进 `os.tmpdir()` 下以 `uta-` 开头的临时目录，并在 `afterAll` / `afterEach` 删除。服务端与端到端测试连组件目录、项目目录、模型配置都用临时副本，不读写仓库里的 `components/`、`projects/`、`config/`。
2. **守卫脚本兜底**：`pnpm test` 实际执行的是 `scripts/run-tests.mjs`。它在跑测试前后各拍一次快照，然后：
   - 删除本轮新增、以 `uta-` 开头的临时目录；有残留即视为泄漏，**判测试失败**（提醒你补 `afterAll`）；
   - 顺手清理 Playwright 留下的 `playwright-artifacts-*`；
   - 比对仓库的 `data/`、`components/`、`projects/`、`config/`，只要被测试改过就**判失败**。

> ⚠️ 这条守卫真的抓到过问题：一个 agent 测试用了仓库的组件目录，导致 mock 编排 Agent 把草稿写进了 `components/_drafts/`。

## 写新测试

- **纯规则**（门禁、句式、归因）写进 `packages/*/test`，用表驱动，一条规则至少一个正例一个反例。
- **流程分支**（门禁流转、重跑、升级）写进 `packages/server/test/pipeline.test.ts`，用 `makeHarness({ behavior })` 注入假执行器，不启动浏览器，秒级完成。假执行器 `demoSite` 模拟演示站点的真实行为（按钮只有「保存」、计数少 1、兑换码只认 VIP-2026）。
- **真实浏览器行为**（新动作、新的错误分类）写进 `packages/runner/test`，页面元素加到 `packages/runner/test/fixtures/controls.html`。
- **人的操作路径**写进 `tests/e2e/ui-flow.test.ts`，只用页面上的角色与文字定位，不走 API 捷径。
- 临时目录一律用 `mkdtemp(join(tmpdir(), 'uta-xxx-'))`，并在 `afterAll` 删除，守卫据此识别泄漏。

## 规范检查

| 工具 | 范围 | 说明 |
| --- | --- | --- |
| ESLint | 全部 TS/TSX/JS | typescript-eslint 带类型信息的规则 + 代码风格 + React Hooks + Vitest 规则 |
| markdownlint | 全部 Markdown | 中文长行不限制，表格与代码块格式统一 |
| tsc | 全部包（含测试代码） | TypeScript 6；测试代码同样纳入类型检查 |

`pnpm lint:fix` 可自动修复大部分风格问题。

> ⚠️ `@stylistic/jsx-one-expression-per-line` 已关闭：它的自动修复会拆开行内文字并吞掉空格，把「第 1 轮 · 手动」改成「第1 轮 ·手动」。

## FAQ

**Q：端到端测试很慢？**
`pnpm test:unit` 只跑单元测试，通常 5 秒内完成；端到端测试会启动真实服务与浏览器，约 40 秒。

**Q：CI 怎么跑？**
`.github/workflows/test.yml`：安装依赖 → 安装 Chromium → `pnpm lint` → `pnpm typecheck` → `pnpm test`。

**Q：测试失败但看不出原因？**
端到端失败时先看 `tests/e2e` 报出的服务端日志断言；浏览器相关失败可在 `packages/runner/test` 里单独复现该动作。

**Q：改了服务端事件结构，前端没跟上会怎样？**
`packages/server/test/contract.test.ts` 在编译期校验两侧类型，`pnpm typecheck` 会直接失败。
