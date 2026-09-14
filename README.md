# UI Test Agent

> **一句话定位**：以 Agent 为核心、能力靠 Skill / MCP 组件叠加的 Web UI 自动化测试平台。用例一键转成 Playwright 步骤，执行过程实时直播，失败进入人机协同的评测门禁，与预期不符的结果汇成报告。

**本文适合谁**：第一次在本机运行本平台的测试工程师与开发者。按“快速开始”操作约 10 分钟即可跑通完整闭环。架构细节见 [docs/architecture.md](docs/architecture.md)，实施计划见 [docs/PLAN.md](docs/PLAN.md)。

## 目录

- [解决的痛点](#解决的痛点)
- [快速开始](#快速开始)
- [核心功能](#核心功能)
- [配置模型](#配置模型)
- [接入 MolarData](#接入-molardata)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [FAQ](#faq)
- [术语表](#术语表)

## 解决的痛点

| 痛点 | 本平台的做法 |
| --- | --- |
| 手写 Playwright 脚本慢，用例与脚本两套维护 | 自然语言用例由编译 Agent 转成 Step DSL，人在表格里审阅批准 |
| 脚本跑挂了看不懂，只能翻日志 | 执行画面实时直播，逐步截图、录像、trace 全部留存 |
| 失败原因混在一起：脚本错、缺数据、环境抖动、真缺陷 | 归因 Agent 分四类，每类走不同的处理路径 |
| 修脚本、补数据、重跑全靠手工 | 在门禁页写一句指点或填一个值，Agent 修正计划并只重跑该用例 |
| 平台能力固定，新需求要改核心代码 | 能力以 Skill / MCP 组件叠加；Agent 缺能力时起草组件，人批准后生效 |

## 快速开始

**前置条件**：Node.js 22 以上（已验证 24），pnpm 10 以上（已验证 11）。

1. 安装依赖与浏览器：

   ```bash
   cd ~/Desktop/Projects/ui-test-agent
   pnpm install
   pnpm playwright:install
   ```

   **成功标志**：最后一行出现 `Chromium ... downloaded` 或无报错退出。

2. 启动（默认 `mock` 模型，离线可用）：

   ```bash
   pnpm start
   ```

   **成功标志**：终端输出 `UI Test Agent 已启动：http://127.0.0.1:4600`，并列出 LLM 路由与组件。

3. 浏览器打开 `http://127.0.0.1:4600`，按页面顺序操作四条演示用例：

   | 步骤 | 页面 | 操作 | 预期 |
| --- | --- | --- | --- |
   | 1 | ② 步骤编译 | 逐个用例点“编译”→“批准” | 四个计划都显示“已批准” |
   | 2 | ③ 执行直播 | 点“全选可执行”→“执行所选” | 画面实时变化；登录用例通过，其余三条未通过 |
   | 3 | ④ 失败门禁 | “修改昵称”写 `按钮叫「保存」` 并提交；“VIP 兑换”填 `vipCode = VIP-2026` 并提交 | 两条都变为“重跑中”，随后在“最近关闭”中显示“已解决” |
   | 4 | ⑤ 结果审阅 | 对“待办计数”点“确认缺陷”，再点“生成报告” | 报告状态为“定稿”，打开后可见预期「共 2 项」、实际“共 1 项”的缺陷卡片 |

> 开发模式用 `pnpm dev`：服务端热重载在 `4600`，前端 Vite 在 `http://127.0.0.1:5173`。

## 核心功能

- **用例 → 步骤编译**：`compiler` 角色加载 `case-to-steps` Skill，把用例编译成 Step DSL；草稿可在表格中修改，批准后才能执行。替代了手写与维护 Playwright 脚本。
- **确定性执行 + 实时直播**：执行不经过 LLM，由解释器驱动 Playwright；CDP screencast 把画面推到前端，另存录像、trace、每步截图。可选有头浏览器与 OBS 录制。替代了“跑完才知道发生了什么”。
- **评测门禁**：失败归因为 `step-defect`、`data-missing`、`env-flaky`、`product-defect` 四类，分别进入修正、补数据、自动重试、审阅。小修自动批准，改结构或预期需要人批准；超过 3 轮自动升级。替代了人工排查和反复手工重跑。
- **审阅与报告**：疑似缺陷由人确认或驳回；存在待处理项时报告只能是草稿，全部处理后才能定稿。替代了手工整理缺陷清单。
- **组件叠加**：Skill（知识与规则）和 MCP（可执行能力）按角色暴露给 Agent；orchestrator 可起草新组件，人在组件中心批准后热加载。替代了改核心代码扩展能力。
- **模型可插拔**：Anthropic、OpenAI 兼容协议（DeepSeek、通义千问等）、离线 `mock` 三种适配器，可按角色路由。

## 配置模型

编辑 `config/llm.yaml`，或用环境变量临时覆盖：

```bash
ANTHROPIC_API_KEY=sk-ant-... LLM_PROVIDER=claude pnpm start
DEEPSEEK_API_KEY=sk-...      LLM_PROVIDER=deepseek pnpm start
```

**预期**：启动日志的 `LLM 路由` 显示 `compiler=claude · claude-opus-5` 或 `compiler=deepseek · deepseek-chat`。

> ⚠️ `mock` 规则引擎只理解用「」标出页面文字的规范句式（如 `点击「登录」按钮`、`页面显示「欢迎」`）。自由文本用例与功能点清单需要真实模型。

## 接入 MolarData

1. 在 `MolarTest/AutoTest/molardata-e2e` 执行 `npm run auth:all`，生成登录态。
2. 启动时设置被测地址：`MOLAR_BASE_URL=https://<daily 环境> LLM_PROVIDER=claude pnpm start`。
3. 在侧栏切换到“MolarData 标注平台”，在①底部从功能点清单勾选条目导入，再按②③④⑤操作。

配置文件为 `projects/molardata/project.yaml`，平台只引用 `auth/*.json` 路径，不复制凭据。

## 目录结构

```text
ui-test-agent/
├── packages/
│   ├── core/       # 领域模型、门禁纯函数、文件存储
│   ├── runner/     # Step DSL 解释器（Playwright）、screencast、证据采集
│   ├── agent/      # LLM 适配、Agent Loop、角色、组件注册表、Agent 服务
│   ├── server/     # Fastify：Pipeline 状态机、REST、WebSocket、报告
│   └── web/        # React 前端：六个工作页面
├── components/
│   ├── skills/     # case-to-steps、failure-triage、component-forge、molar-platform
│   ├── mcp/        # obs-recorder（自建 MCP）
│   ├── mcp.json    # MCP 组件登记（playwright、obs-recorder，默认停用）
│   └── _drafts/    # Agent 起草、待人工批准的组件
├── projects/
│   ├── demo/       # 本地演示站点（埋有一个缺陷）+ 四条演示用例
│   └── molardata/  # MolarData 接入配置
├── tests/e2e/      # 端到端测试：API 流程、浏览器操作前端的流程、边界流程
├── config/llm.yaml # 模型路由
├── data/           # 运行数据（不入库）
└── docs/           # PLAN.md、architecture.md、testing.md
```

## 开发与测试

```bash
pnpm check          # 规范检查 + 类型检查 + 全部测试（提交前跑这个）
pnpm test           # 全部测试：单元 + 端到端
pnpm test:unit      # 只跑单元测试，秒级
pnpm test:e2e       # 只跑端到端测试（真实服务 + 真实浏览器）
pnpm lint           # ESLint + markdownlint
```

**预期**：21 个测试文件、392 项全部通过，末尾打印测试数据清理检查结果。端到端测试使用 `mock` 模型，不联网、不产生模型费用；测试产生的数据在结束时全部删除，仓库不会被写脏。

测试分层、数据清理机制与新增测试的写法见 [docs/testing.md](docs/testing.md)。

## FAQ

**Q：前端画面是黑的？**
画面只在有用例执行时推送。执行结束后画面区自动切换为录像回放。

**Q：OBS 录制选项是灰的？**
需要安装 OBS 30+，在“工具 → WebSocket 服务器设置”中启用服务，然后在⑥组件中心启用 `obs-recorder`。密码写在 `components/mcp.json` 的 `OBS_WEBSOCKET_PASSWORD`。

**Q：门禁里提交指点后报“规则修正需要用「」标出正确的值”？**
这是 `mock` 模式的限制。用「」标出正确文字，或直接在步骤表格里修改，或配置真实模型。

**Q：重置演示数据？**
停止服务后删除 `data/` 目录，下次启动会重新导入四条演示用例。

## 术语表

| 术语 | 含义 |
| --- | --- |
| Step DSL | 平台的可执行步骤格式：`action` + `target` + `value` + `expect` |
| Plan / 计划 | 某个用例某个版本的 Step DSL；批准后不可变，修正生成新版本 |
| Run | 一次执行；`round` 表示第几轮门禁，`attemptId` 防止迟到写入 |
| Finding | 一次失败的归因结论，带 verdict、证据和处理状态 |
| verdict | 失败类型：`step-defect`、`data-missing`、`env-flaky`、`product-defect` |
| Skill | 以 `SKILL.md` 承载的知识与规则组件 |
| MCP | 以 Model Context Protocol server 提供的可执行能力组件 |
