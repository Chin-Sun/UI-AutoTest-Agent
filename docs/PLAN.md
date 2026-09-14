# UI Test Agent：可叠加组件的 AI 驱动 Web UI 自动化测试平台

## Context

目标：借鉴 `dsh-agent-teams` 的 Agent 设计，在 `Desktop/Projects/ui-test-agent` 新建一个通用平台。核心是一个 Agent，由它决定调用哪些组件（Skill / MCP），必要时起草新组件。平台基于 Playwright 做 Web 可视化 UI 测试，流程是：测试用例 → 可执行步骤 → 执行（实时可见）→ 失败门禁（人补充后修正用例并重跑）→ 与预期不符的结果进入报告供人审阅。人通过前端页面完成全部交互。

已确认的决策：**模型可插拔**（自建 LLM 适配层）；**前端内实时直播 + OBS 录制两者都要**（OBS 作为可选 MCP 组件）；**新建通用平台，把 molardata-e2e 作为第一个被测项目接入**；本次交付**架构文档 + 可运行骨架**（最小闭环）。

### dsh-agent-teams 架构要点（被借鉴的部分）

| dsh-agent-teams 机制 | 位置 | 在新平台中的对应 |
| --- | --- | --- |
| Captain 会话 + 注入的 usage 协议（系统提示分段） | `src/index.ts` `usageSectionText()` | Orchestrator Agent + 由组件注册表动态拼接的系统提示 |
| 成员 = 带 persona 的可续聊子 Agent，并有工具黑名单 | `src/members.ts` `MEMBER_DENIED_TOOLS` | 角色子 Agent（Compiler / Triager / Repairer / Reporter），每个角色有工具白名单 |
| 工具注册表 `ctx.tools.register(defineTool)` | `src/tools.ts` | ComponentRegistry：Skill 加载器 + MCP 客户端管理器，工具名统一加命名空间 |
| 任务 DAG + 事件驱动调度器（idle 边沿触发、原子领取） | `src/scheduler.ts` `kickTeam/kickMember` | Pipeline 调度器：Case → Plan → Run → Triage → Gate，由状态变化推进，不轮询 |
| `attempt` + `attemptId`，迟到的写入会被拒绝 | `src/state.ts` `beginTaskAttempt()` | Run 的 attempt 能力令牌：重跑会让旧 attempt 失效 |
| 质量门禁：结构化合同 + verdict，不 pass 不能 completed；失败自动开 repair 和下一轮 review；设 maxRounds，超过则 escalate | `src/quality-gates.ts` `evaluateQualityCompletion / planQualityFollowUp` | 评测门禁：failure verdict 分类 → 人补充 → 生成新版 Plan → 重跑 round+1，超限升级 |
| 暂存计划 + Web 审批（Approve & Run / 回聊天修改 / 丢弃） | `tools.ts` `approveStagedTeam`、`client/StagingPlanEditor.tsx` | 步骤计划必须人工审阅批准后才能执行 |
| 磁盘即真相；快照路由 + 前端轮询；JSONL 邮箱 | `state.ts`、`snapshot.ts`、`/plugins/dsh-agent-teams/state` | `data/` 目录下的 JSON 为真相；前端 WS/SSE 推送；人的反馈进 inbox |
| 终态只读，下一轮必须新建任务；halt/resume 要显式触发 | `docs/quality-gates.md` §2.2、§6.5 | Plan 版本不可变，修正时生成 v(n+1)；Run 终态只读 |
| 纯函数门禁 + 强制 TDD（fake ctx，不依赖真实 LLM） | `scripts/quality-gates-tdd.mjs` | 门禁规则写成纯函数并用 vitest 覆盖；另提供 `mock` LLM 适配器，离线也能跑通闭环 |

还要复用 molardata-e2e 已有的约定：finding verdict 词表 `product-defect | case-defect | env-flaky`、清单主键 `0N-A1`、`testcases/*.md` 的清单格式、`modules/types.ts` 的 `auth` 角色、证据策略（trace / video / screenshot）。

---

## 总体架构

```text
┌──────────────────────── Web 前端 (React + Vite) ────────────────────────┐
│ ①用例录入  ②步骤编译/审批  ③执行直播  ④失败门禁/反馈  ⑤结果审阅/报告  ⑥组件中心 │
└───────────────▲ REST ─────────────────────▲ WebSocket(帧/步骤/状态) ──────┘
                │                           │
┌───────────────┴──── Server (Fastify) ─────┴──────────────────────────────┐
│  API 路由 · 事件总线(EventBus) · Pipeline 调度器(状态驱动) · 人工 inbox      │
└──────┬──────────────────────┬──────────────────────────┬─────────────────┘
       │                      │                          │
┌──────▼─────── Agent Core ───▼──────┐   ┌───────────────▼──── Runner ───────┐
│ LLM 适配层: anthropic / openai-兼容 │   │ Step DSL 确定性解释器 (Playwright) │
│   (DeepSeek/Qwen…) / mock           │   │ CDP screencast → 帧推送            │
│ Agent Loop (tool-use 循环)          │   │ video / trace / 每步截图 / DOM 快照 │
│ Orchestrator + 角色子 Agent          │   │ 数据绑定 ${data.x} · storageState  │
│ ComponentRegistry                   │   └────────────────────────────────────┘
│   ├─ Skills (components/skills/*)   │
│   └─ MCP 管理器 (components/mcp.json)│──→ MCP: playwright-mcp(探索定位) · obs-recorder · …
│ Gate Engine (纯函数)                 │
└──────────────┬──────────────────────┘
               ▼
        data/ (磁盘即真相)  cases/ plans/ runs/ findings/ reports/ inbox/
```

**核心原则**（与 molardata 实施方案里“先确定性方案，后 AI”一致）：LLM 只在**编译用例、归因失败、吸收人的反馈修正用例、写报告**这几处出场。执行过程是**确定性的 Step DSL 解释器**，不由 LLM 逐步驱动，这样可以重放、可比对，成本也可控。

### 1. 领域模型与状态机（`packages/core`）

- `TestCase { id, projectId, title, module, preconditions[], steps(自然语言), expected[], dataRequirements[], source, version }`
- `StepPlan { id, caseId, version, status: draft|approved|superseded, steps: Step[], dataBindings, authRole, createdBy: agent|human, derivedFrom?: {planVersion, feedbackIds} }`，版本不可变；修正时生成 v(n+1)，旧版本标记为 `superseded`
- `Step { id, action: goto|click|fill|select|check|upload|press|hover|waitFor|assertVisible|assertText|assertUrl|assertCount|screenshot, target?: {role,name}|{testId}|{label}|{text}|{css}, value?, expect?, caseRef(对应用例第几句), timeoutMs? }`，用 zod 做 schema
- `Run { id, caseId, planVersion, round, attempt, attemptId, status: queued|running|passed|failed|cancelled, stepResults[], evidence{video,trace,screenshots[]} }`
- `Finding { id, runId, stepId, verdict: step-defect|data-missing|env-flaky|product-defect, severity, expected, actual, evidence, triagedBy: agent|human, status: awaiting_human|repairing|rerun|confirmed|dismissed }`
- `Feedback { id, findingId, kind: fix-step|supply-data|confirm-defect|not-a-defect, content, dataPatch? }`

Pipeline 状态机（仿照任务 DAG 的 `pending→claimed→in_progress→终态`，终态只读）：

```text
Case(draft) ─compile→ Plan(draft) ─人审批→ Plan(approved) ─→ Run(queued→running)
   Run passed ─→ 结束
   Run failed ─→ Triager 归因 → Finding
       step-defect / data-missing ─→ Gate: awaiting_human ─人反馈→ Repairer 生成 Plan v+1
                                   ─(小改自动批准 / 大改回到人审批)→ 重跑 round+1（只跑失败用例）
       env-flaky ─→ 自动重试 1 次，再失败则升级为 awaiting_human
       product-defect ─→ 审阅队列 ⑤ ─人确认→ 进报告 │ 人判“不是缺陷”→ 转为 step-defect 走修正
   round > maxRounds(默认 3) ─→ escalated，停止自动循环
```

门禁纯函数（`packages/core/src/gates.ts`，仿照 `quality-gates.ts`）：

- `canPass(run)`：所有步骤都执行完、所有 assert 通过，才能 passed
- `validateFinding(f)`：product-defect 必须带 expected / actual / 截图证据；step-defect 必须指明 stepId
- `planRepair(finding, feedback)`：输出下一轮 Plan 草稿与 rerun 任务；不许复活终态 Run
- `needsHumanApproval(oldPlan, newPlan)`：只改 locator 或数据的小改自动批准，增删步骤要人审批
- `shouldEscalate(caseHistory, policy)`、`canPublishReport(runBatch)`

### 2. Agent Core（`packages/agent`）

- **LLM 适配层** `LlmAdapter.chat({system, messages, tools, model}) → {text, toolCalls, usage}`，内置三种：`anthropic`（@anthropic-ai/sdk，默认 claude-sonnet-5）、`openai-compatible`（openai SDK + baseURL，覆盖 DeepSeek 等）、`mock`（按脚本返回，给测试和离线演示用）。配置写在 `config/llm.yaml`，可以按角色分别路由到不同模型，对应 dsh 里成员的 provider/model 快照。
- **Agent Loop**：典型的 tool-use 循环，设最大轮数，每轮落盘 transcript（对应 dsh 的 session events）。
- **角色**（persona 加工具白名单，对应 `MEMBER_DENIED_TOOLS`）：
  - `orchestrator`：读当前状态，决定下一步调哪个角色或组件；缺能力时可以调 `component-forge` 起草新组件
  - `compiler`：把用例编译成 StepPlan，加载 `case-to-steps` skill；可选用 playwright-mcp 打开真实页面探查 locator
  - `triager`：把失败证据（错误、截图、失败步骤、ARIA 快照）归因成 Finding.verdict，加载 `failure-triage` skill
  - `repairer`：结合人的反馈和 Finding 生成 Plan v+1
  - `reporter`：生成报告摘要
- **ComponentRegistry**：
  - Skill：`components/skills/<name>/SKILL.md`，frontmatter 写 `name / description / roles / tools`，渐进加载：系统提示里只放目录，Agent 调 `load_skill(name)` 时才读正文
  - MCP：`components/mcp.json`（stdio / http），启动时连接，工具以 `mcp__<server>__<tool>` 暴露；每个组件有 `enabled` 开关和健康检查
  - 内置工具：`list_components`、`load_skill`、`read_case`、`propose_plan`、`record_finding`、`request_human_input`（写 inbox）、`draft_component`
  - **组件自扩展**：`draft_component` 只能在 `components/_drafts/` 下生成 skill 目录或 MCP 脚手架，前端⑥里经人批准后才移入正式目录并热加载，不会自动执行新代码

### 3. Runner（`packages/runner`）

- 用 `playwright` 库，而不是 test runner，这样每一步都可控，也能插入钩子。按 Plan 逐步执行，每步前后发出 `step-start/step-end` 事件，并截图
- **实时直播**：通过 CDP `Page.startScreencast`，把 JPEG 帧经 EventBus 和 WS 推给前端；可视模式下同时 `headless:false + slowMo`
- 证据：`recordVideo`（webm）、`context.tracing`（trace.zip，可用 `npx playwright show-trace` 打开）、失败时保存 ARIA snapshot
- 数据绑定：`${data.xxx}` 从项目数据集和人补充的 dataPatch 解析；缺失的绑定在执行前就判为 `data-missing`，不浪费一次执行
- 登录态：按项目配置的 `authRole → storageState` 路径（molardata 用它自己的 `auth/*.json`，路径走 env，不复制凭据）

### 4. 组件（`components/`，初始内置）

| 组件 | 形式 | 作用 |
| --- | --- | --- |
| `case-to-steps` | Skill | 用例 → Step DSL 的规则、locator 优先级（testId > role > label > text > css）、示例 |
| `failure-triage` | Skill | 四类 verdict 的判定准则与证据要求 |
| `component-forge` | Skill | 起草新 skill / MCP 的模板与约束 |
| `molar-platform` | Skill | 被测项目知识（从 molardata testcases 前置准备章节提炼） |
| `playwright` | MCP（`@playwright/mcp`） | compiler 探索真实页面、验证 locator |
| `obs-recorder` | MCP（自建，`obs-websocket-js`） | `start_record / stop_record / set_scene`；默认 disabled。本机未安装 OBS，需要装 OBS 30+ 并开启 WebSocket |

### 5. 前端（`packages/web`，React + Vite）

1. **用例录入**：表单、Markdown 粘贴，或从 molardata `testcases/*.md` 与 `ledger/cases/*.jsonl` 导入
2. **步骤编译/审批**：点“编译”后流式展示 Agent 过程，步骤表可编辑（action / target / value / expect），与原用例句子对照，按钮为「批准」「让 Agent 重编」「丢弃」（对应 StagingPlanEditor）
3. **执行**：按模块 / 用例选择执行；左侧实时画面，右侧步骤时间线（当前步骤高亮、每步截图、耗时），可选“同时 OBS 录制”
4. **失败门禁**：列出 awaiting_human 的 Finding（verdict、证据、Agent 建议）。人可以选：修正步骤（内联编辑或文字指点）、补数据（键值 / 上传文件）、改判 verdict，然后「提交并重跑」。页面显示 round 与升级状态
5. **结果审阅/报告**：product-defect 以预期和实际对比展示，附截图、录像、trace，人可以确认或驳回；报告生成 HTML 与 JSON
6. **组件中心**：已注册的 skill / MCP、启停、健康状态，待审批的草稿组件

### 6. Server（`packages/server`，Fastify + ws）

REST：`/api/cases`、`/api/cases/:id/compile`、`/api/plans/:id/approve|reject`、`/api/runs`（POST 发起）、`/api/findings/:id/feedback`、`/api/reports/:batchId`、`/api/components`。
WS：`/ws`，按 runId 或 caseId 订阅 `frame | step | status | agent-log | finding`。Pipeline 调度器订阅 EventBus，由状态变化推进，对应 `agent/status` 触发 `kickMember` 的做法。

---

## 目录结构（pnpm workspace）

```text
Desktop/Projects/ui-test-agent/
├─ docs/architecture.md          # 完整架构文档（含 dsh-agent-teams 借鉴对照表）
├─ packages/{core,agent,runner,server,web}/
├─ components/{skills/*, mcp/obs-recorder/, mcp.json, _drafts/}
├─ projects/
│  ├─ demo/                      # 本地演示站点（故意埋一个缺陷）+ 演示用例
│  └─ molardata/project.yaml     # baseURL、authRole→storageState、清单导入路径（均走 env）
├─ config/llm.yaml
├─ data/                         # 运行态（gitignore）：cases plans runs findings reports inbox transcripts
└─ package.json / pnpm-workspace.yaml / tsconfig.base.json
```

技术栈：Node 24、pnpm 11、TypeScript、zod、Fastify、ws、React 18 + Vite、vitest、playwright、@modelcontextprotocol/sdk、@anthropic-ai/sdk、openai、obs-websocket-js、gray-matter。

## 实施顺序（骨架 = 最小闭环）

0. **先落盘计划**：创建 `Desktop/Projects/ui-test-agent/`，把本计划原文写入 `docs/PLAN.md`，并 `git init`
1. 脚手架：workspace、tsconfig、lint、`docs/architecture.md`
2. `core`：类型与 zod schema、文件存储（原子写，参考 `dsh-agent-teams/src/state.ts` 的 `replaceFileAtomicOrDirect`）、门禁纯函数，**先写 vitest 用例**
3. `runner`：Step DSL 解释器、screencast、证据采集；用 `projects/demo` 自测
4. `agent`：LLM 适配（anthropic / openai-compatible / mock）、loop、ComponentRegistry（skill + MCP）、compiler / triager / repairer 三个角色
5. `server`：路由、EventBus、Pipeline 调度器
6. `web`：6 个页面的最小可用版本
7. 组件：3 个 skill、playwright MCP 接入、obs-recorder MCP（默认关闭）
8. molardata 接入：清单与 ledger 导入器，project.yaml

## 验证

- `pnpm -r typecheck && pnpm -r test`：门禁纯函数与 schema 单测（覆盖 canPass、四类 verdict 的流转、Plan 版本不可变、旧 attempt 写入被拒绝、超过 maxRounds 升级）
- **离线端到端**（`LLM_PROVIDER=mock`）：`pnpm dev` 后打开前端，录入 demo 用例 → 编译 → 批准 → 执行时看到实时画面 → 故意写错一个 locator，门禁出现 step-defect，提交修正后重跑通过 → demo 站点的埋点缺陷进入审阅页，确认后生成报告
- **真实模型**：配置 `ANTHROPIC_API_KEY` 或 DeepSeek 的 baseURL/key，重复上述流程
- 用 Playwright 自测前端（`packages/web/e2e`）覆盖以上流程
- molardata：导入 `02-workflow.md` 中 2~3 条用例，只编译和审阅步骤（真实执行需要 `.env` 凭据，由用户本地确认）
- OBS：装好 OBS 并开启 WebSocket 后，在执行页勾选录制，确认生成录像文件
