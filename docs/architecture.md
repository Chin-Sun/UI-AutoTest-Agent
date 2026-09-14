# UI Test Agent 架构设计

> **一句话总结**：以 Agent 为核心、能力靠 Skill / MCP 组件叠加的 Web UI 自动化测试平台。Agent 负责“理解与判断”（编译用例、归因失败、吸收人的反馈），Playwright 负责“确定性执行”，人通过前端页面把关每一个门禁。

**本文适合谁**：要维护、扩展本平台的开发者，以及想了解它如何借鉴 `dsh-agent-teams` 的读者。读完你将知道每个模块的职责、一次测试从录入到报告的完整链路，以及如何向平台叠加新组件。

## 目录

- [一、设计目标](#一设计目标)
- [二、参考项目分析：dsh-agent-teams](#二参考项目分析dsh-agent-teams)
- [三、总体架构](#三总体架构)
- [四、核心流程](#四核心流程)
- [五、评测门禁](#五评测门禁)
- [六、组件体系](#六组件体系)
- [七、模型可插拔](#七模型可插拔)
- [八、实时可视化](#八实时可视化)
- [九、数据模型与存储](#九数据模型与存储)
- [十、前端交互](#十前端交互)
- [十一、接入被测项目](#十一接入被测项目)
- [十二、演进路线](#十二演进路线)

## 一、设计目标

| 编号 | 目标 | 落点 |
| --- | --- | --- |
| G1 | Web 平台可视化操作测试，执行过程实时可见 | `packages/runner` 的 CDP screencast + 前端③执行直播；OBS 作为可选 MCP 组件 |
| G2 | 测试用例固定排列，由组件转成 Playwright 可执行步骤 | `compiler` 角色 + `case-to-steps` Skill，产出 Step DSL，人工批准后才能执行 |
| G3 | 执行错误进入评测门禁，人补充后纠正用例并重跑 | 四类 verdict 状态机（`packages/core/src/gates.ts`）+ 前端④失败门禁 |
| G4 | 结果不符合预期即为缺陷，生成报告供人审阅 | 前端⑤结果审阅 + HTML 报告，存在未审阅项时报告只能是草稿 |
| G5 | 能力可按需求叠加，Agent 能选择组件、起草新组件 | `ComponentRegistry`（Skill + MCP + 草稿审批） |

**设计原则**：先确定性方案，后 AI。LLM 只出现在编译、归因、修正、总结四处；执行过程不经过 LLM，因此可重放、可比对、成本可控。

## 二、参考项目分析：dsh-agent-teams

> **一句话定位**：`dsh-agent-teams` 是 DeepSeek Harness 的插件，把当前会话变成“队长”，按角色创建可续聊的子 Agent 成员，把目标拆成带依赖的任务 DAG，由事件驱动的调度器派工，并用质量门禁判定任务能否完成。

### 2.1 整体关系

```text
        用户 ──自然语言/slash 命令──▶ Captain 会话（系统提示注入 usage 协议）
                                          │ 调用 agent_teams_* 工具
            ┌─────────────────────────────┼──────────────────────────────┐
            ▼                             ▼                              ▼
   staged 计划（team.json）      Scheduler（agent/status 边沿）     Web 路由（审批/停止/快照）
            │ 人在 Web 审批                │ 原子领取 + attemptId           │ 1s 轮询
            ▼                             ▼                              ▼
   spawn 成员（持久子 Agent）  ◀── deliverToMember ──  任务 DAG  ◀── 质量门禁（verdict/合同）
            │ 成员工具白名单                                              ▲
            └──── agent_teams_update_task / send_message（邮箱 JSONL）───┘
```

### 2.2 Agent 的使用

| 机制 | 源码位置 | 做法 |
| --- | --- | --- |
| 队长 | `src/index.ts` `usageSectionText()` | 通过 `ctx.systemPrompt.section()` 往全局系统提示注入 10 条协议，模型读到协议就会以队长身份行动 |
| 成员 | `src/members.ts` `spawnMember` | 每个成员是可续聊的持久子 Agent，带 persona、provider/model/思考强度快照 |
| 权限 | `src/members.ts` `MEMBER_DENIED_TOOLS` | 成员看不到建队、建任务、删队等队长工具，权限靠工具可见性划分 |
| 模型路由 | `resolveMemberLlmSelection` | 默认继承队长的模型路由，也可按成员单独指定，并支持 fallback |

### 2.3 Agent 的链接

| 机制 | 源码位置 | 做法 |
| --- | --- | --- |
| 持久状态 | `src/state.ts` | `<workspace>/.agent-teams/<teamId>/team.json` 是唯一真相源；读写都做 schema 校验，写入为原子写并持有进程内锁 |
| 邮箱 | `src/state.ts` `appendMailbox` | 每个参与者一个 JSONL 邮箱；无法实时投递时持久化，在下一个状态边界重投 |
| 调度 | `src/scheduler.ts` | 不轮询：成员 `idle` 边沿或任务图变化时，为空闲成员原子领取一项就绪任务并唤醒 |
| 执行令牌 | `beginTaskAttempt()` | 每次派工生成新的 `attemptId`；转派会使旧 attempt 失效，迟到的写入被拒绝 |
| 事件 | `src/events.ts` | 每次状态变化都往队长会话追加事件，便于审计与重放 |

### 2.4 Agent 的调用

| 入口 | 做法 |
| --- | --- |
| 工具注册 | `ctx.tools.register(defineTool(...))` 注册 13 个 `agent_teams_*` 工具，模型通过 tool call 驱动团队 |
| 确定性激活 | `/agent-teams` slash 命令 + 手势边界，避免“模型没意识到要建队” |
| 两阶段审批 | `approval="required"` 时先生成 staged 计划，人在 Web 点 Approve & Run 才 spawn 成员（`approveStagedTeam`） |
| 质量门禁 | `src/quality-gates.ts`：review 只有 `verdict=pass` 才能完成；`needs_revision` 自动生成 repair + 下一轮 review；超过轮次上限则 escalate |

### 2.5 借鉴与取舍

| dsh-agent-teams | 本平台 | 取舍理由 |
| --- | --- | --- |
| Captain + 成员子 Agent | `orchestrator` + `compiler / triager / repairer / reporter` 角色 | 测试流水线的阶段固定，角色按阶段划分即可，不需要动态建队 |
| 工具黑名单 | 角色工具白名单 + MCP 按 `roles` 暴露 | 组件会不断叠加，白名单更安全 |
| 系统提示注入协议 | 系统提示只注入组件目录，正文由 `load_skill` 按需加载 | 组件多了以后避免提示膨胀 |
| 任务 DAG + 调度器 | Pipeline 状态机（执行结束 → 归因 → 门禁 → 重跑） | 测试链路是线性的，保留“事件驱动、不轮询”的核心思想 |
| `attemptId` 迟到写入保护 | `Run.attemptId` + `store.updateRunAttempt()` | 取消后浏览器迟到的结果不能覆盖终态 |
| 质量门禁 + 自动 repair/review 循环 | 四类 verdict + 人工反馈 + 修正/重跑 + `maxRounds` 升级 | 测试的“修正”依赖人提供的信息，所以循环的推动者是人 |
| staged 计划 + Web 审批 | 步骤计划草稿 + 人工批准；小修自动批准 | 执行前必须有人看过步骤 |
| 终态只读，下一轮新建任务 | 计划版本不可变，修正生成 v(n+1)；Run 终态只读 | 修正链路可追溯 |
| 纯函数门禁 + 强制 TDD | `gates.ts` 全部为纯函数，vitest 覆盖；`mock` 适配器离线跑通闭环 | 门禁是平台可信度的来源 |

> ⚠️ 本平台是独立服务，不依赖 DeepSeek Harness 运行时；借鉴的是设计，不是代码。

## 三、总体架构

```text
┌──────────────────────────── 前端 packages/web（React + Vite）─────────────────────────────┐
│ ①用例录入  ②步骤编译/审批  ③执行直播  ④失败门禁  ⑤结果审阅/报告  ⑥组件中心              │
└──────────────▲ REST /api ───────────────────────────▲ WebSocket /ws（帧 / 步骤 / 状态 / 日志）┘
               │                                      │
┌──────────────┴──────────── 服务 packages/server（Fastify）──────────────────────────────────┐
│  app.ts 路由   bus.ts 事件总线   pipeline.ts 状态驱动流水线   report.ts   importers.ts       │
└──────┬──────────────────────────────┬──────────────────────────────┬────────────────────────┘
       │                              │                              │
┌──────▼──── packages/agent ─────┐ ┌──▼──── packages/runner ─────┐ ┌──▼──── packages/core ─────┐
│ LLM 适配：anthropic /           │ │ Step DSL 确定性解释器        │ │ 领域模型（zod）            │
│   openai-compatible / mock      │ │ CDP screencast 实时帧        │ │ 门禁纯函数 gates.ts        │
│ Agent Loop（tool-use 循环）      │ │ 每步截图 / 录像 / trace      │ │ 文件存储（原子写 + 锁）     │
│ 角色 roles.ts                   │ │ 数据绑定 / storageState      │ └────────────────────────────┘
│ ComponentRegistry ──────────────┼─┼──▶ components/：skills/*  mcp.json  mcp/obs-recorder  _drafts/
└─────────────────────────────────┘ └──────────────────────────────┘
                                   data/：cases plans runs findings feedback reports evidence transcripts
```

| 模块 | 职责 | 关键文件 |
| --- | --- | --- |
| `core` | 领域模型、门禁规则、文件存储，不依赖任何框架 | `types.ts`、`gates.ts`、`store.ts` |
| `runner` | 按 Step DSL 逐步驱动 Playwright，产出步骤结果与证据 | `runner.ts` |
| `agent` | LLM 适配、Agent Loop、角色、组件注册表、面向流水线的服务 | `llm/*`、`loop.ts`、`registry.ts`、`services.ts` |
| `server` | 组装各模块，推进流水线，提供 REST 与 WebSocket | `pipeline.ts`、`app.ts`、`server.ts` |
| `web` | 六个工作页面，承接人的全部交互 | `pages/*.tsx` |
| `components` | 可叠加的 Skill 与 MCP 组件 | `skills/*/SKILL.md`、`mcp.json` |

## 四、核心流程

### 4.1 状态机

```text
TestCase ──compile（compiler）──▶ StepPlan(draft) ──人批准──▶ StepPlan(approved) ──▶ Run(queued → running)
                                                                                         │
                               Run(passed) ◀─────────────────────────────────────────────┤
                               关闭该用例所有未结 Finding（resolved）                     │
                                                                                         ▼
                                                               Run(failed) ──triager 归因──▶ Finding
   Finding.verdict                      初始状态            人的动作                        系统动作
   step-defect      ─────────▶ awaiting_human  ──fix-step──▶ repairing ──repairer──▶ Plan v+1 ──小修自动批准 / 大改待批准──▶ 重跑 round+1
   data-missing     ─────────▶ awaiting_human  ──supply-data──▶ rerunning ──写入 case.data──▶ 重跑 round+1
   env-flaky        ─────────▶ rerunning（自动重试 1 次），再失败 ▶ awaiting_human
   product-defect   ─────────▶ awaiting_review ──confirm-defect──▶ confirmed（进报告）
                                               └─not-a-defect──▶ repairing（按人给的正确预期修正断言）
   round > maxRounds ────────▶ escalated（停止自动循环，人可继续指点或关闭）
```

### 4.2 例子：四条演示用例走一遍

| 用例 | 首轮结果 | 归因 | 人的动作 | 第 2 轮 |
| --- | --- | --- | --- | --- |
| 登录成功后显示欢迎语 | 通过 | — | — | — |
| 修改昵称并保存 | `s3` 点击「提交」按钮找不到元素 | `step-defect`，建议“页面上现有的 button：「保存」” | 在④写“按钮叫「保存」” | 计划 v2 仅改 locator，自动批准，重跑通过 |
| 使用 VIP 兑换码兑换会员 | 执行前发现缺 `${data.vipCode}` | `data-missing`（规则判定，不启动浏览器） | 在④填 `vipCode=VIP-2026` | 重跑通过 |
| 添加两条待办后计数正确 | 断言「共 2 项」不成立，实际“共 1 项” | `product-defect` | 在⑤确认缺陷 | 进入报告 |

**预期**：报告定稿，`cases=4, passed=3, failed=1, defects=1, open=0`。该流程由 `packages/server/test/e2e.test.ts` 自动验证。

### 4.3 流程与数据：智能编译

清单导入的用例往往只有一句话（例如「02-C5 删除有数据的节点：弹出拦截提示，要求选择数据转移的目标节点后才能删除」）。compiler 按 `case-to-flow` 把它展开成一个**分阶段计划**，并自己决定测试数据从哪来。

```text
用例一句话 + 清单上下文（文件头 / 章节 / 同章节条目）+ 项目知识 skill
        │ list_test_data 查项目测试数据目录
        ▼
propose_plan { steps[stage], data[], decisions[], rationale }
        │ validatePlanSteps + validatePlanData（未声明的 ${data.key}、不存在的目录条目、chosen ∉ options 都会被退回）
        ▼
StepPlan(draft) ──人审阅阶段 / 数据 / 决策点──▶ approved ──执行时 resolvePlanData──▶ Runner
```

| 概念 | 取值 | 说明 |
| --- | --- | --- |
| `Step.stage` | `setup` → `action` → `decision` → `verify` → `cleanup` | 准备前置数据、执行被测操作、流程中的选择、断言、清理本次造的数据 |
| `DataBinding.source` | `catalog` | 引用 `projects/<id>/test-data.yaml` 中登记的条目（任务 ID、账号、本地素材） |
| `DataBinding.source` | `generated` | 模板 `{{case}}` `{{ts}}` `{{rand}}`，每次执行时生成，避免与共享环境冲突 |
| `DataBinding.source` | `setup` | 由 setup 阶段的步骤在页面上造出来 |
| `DataBinding.source` | `human` | 以上都做不到时才用；没有值时执行前判为 `data-missing`，走门禁补数据 |
| `Decision` | `question`、`options`、`chosen`、`reason`、`stepIds` | 用例没写死、由 Agent 做出的选择，②页面可点击高亮关联步骤 |

**数据优先级**：用例数据（人在门禁补的）> 计划声明（目录取值 / 模板展开 / 计划里填的值）。人在草稿里新引用的 `${data.key}` 会自动声明为 `human`。

**审批**：门禁修正只要改动了阶段、数据来源或决策点，就不再自动批准，需要人审阅。

> ⚠️ `mock` 规则引擎不会推断流程：它只把断言归入 `verify`、其余归入 `action`，并把引用的数据声明为 `human`。智能编译需要在 `config/llm.yaml` 把 `compiler` 路由到真实模型。

## 五、评测门禁

门禁规则全部是 `packages/core/src/gates.ts` 中的纯函数，由状态机强制执行，不依赖 prompt。

| 规则 | 函数 | 说明 |
| --- | --- | --- |
| 计划合法 | `validatePlanSteps` | 动作所需字段齐全、id 唯一、至少一个断言；编译与修正的结果都要通过它 |
| 通过判定 | `canPass` | 所有步骤执行完毕且全部通过；缺步骤、跳过都不算通过 |
| 缺数据前置 | `missingBindings` | 执行前检查 `${data.*}` 引用，缺失即判 `data-missing` |
| 归因基线 | `heuristicVerdict` | 断言失败 → `product-defect`；定位/超时 → `step-defect`；网络 → `env-flaky` |
| 归因证据 | `validateFinding` | `product-defect` 必须有预期、实际、截图；`step-defect` 必须指明步骤 |
| 反馈合法 | `applyFeedback` | 每个状态只接受特定反馈，例如已解决的 Finding 不接受任何反馈 |
| 修正审批 | `needsHumanApproval` | 只改 target / value 的小修自动批准；增删步骤、改动作或改期望必须人批准 |
| 迟到写入 | `assertAttempt` | 持有旧 `attemptId` 或 run 已终结时拒绝写入 |
| 升级 | `shouldEscalate` | 轮次超过 `maxRounds`（默认 3）后新 Finding 直接进入 `escalated` |
| 报告定稿 | `canPublishReport` | 存在待审阅、待补充、修正中或重跑中的项时，报告只能是草稿 |

> ⚠️ **关键认知**：`product-defect` 是“动作都执行成功、但结果与预期不符”，不是“测试失败”的同义词。定位失败永远先当作步骤问题交给人，避免把用例错误误报成产品缺陷。

## 六、组件体系

> **类比**：平台像一家餐厅，Agent 是店长。Skill 是菜谱（知识与规则），MCP 是厨具（可执行的能力）。店长按订单挑菜谱和厨具；缺了就写一份采购申请（草稿），老板（人）批准后才进货。

| 组件形式 | 位置 | 适合承载 | 加载方式 |
| --- | --- | --- | --- |
| Skill | `components/skills/<name>/SKILL.md` | 被测系统知识、控件操作套路、归因准则 | 系统提示只放目录，Agent 调 `load_skill` 读正文 |
| MCP | `components/mcp.json` 声明的 stdio server | 需要执行代码的能力：浏览器探查、OBS 录制、造数、文件校验 | 启动时连接，工具以 `mcp__<server>__<tool>` 暴露给对应角色 |
| 草稿 | `components/_drafts/<name>/` | Agent 用 `draft_component` 起草的新组件 | 人在⑥批准后移入正式目录并热加载；MCP 草稿批准后仍需手动启用 |

**内置组件**：

| 组件 | 形式 | 使用角色 | 作用 |
| --- | --- | --- | --- |
| `case-to-flow` | Skill | compiler、repairer | 智能编译方法论：推断意图与前置、按优先级挑选测试数据、生成分阶段流程并记录决策点 |
| `case-to-steps` | Skill | compiler、repairer | Step DSL 规范、locator 优先级、示例 |
| `failure-triage` | Skill | triager | 四类 verdict 判定准则与证据要求 |
| `component-forge` | Skill | orchestrator | 起草新组件的模板与约束 |
| `molar-platform` | Skill | compiler、triager、repairer | MolarData 平台知识 |
| `playwright` | MCP（`@playwright/mcp`，默认停用） | compiler、orchestrator | 打开真实页面读 ARIA 快照，验证 locator |
| `obs-recorder` | MCP（自建，默认停用） | orchestrator、pipeline | 执行时同步开始/停止 OBS 录制、切换场景 |

**角色与工具白名单**（`packages/agent/src/roles.ts`）：

| 角色 | 内置工具 | 终结工具 | 开工前必读 Skill |
| --- | --- | --- | --- |
| `orchestrator` | `list_components`、`load_skill`、`draft_component` | —（以文本结束） | — |
| `compiler` | `list_components`、`load_skill`、`list_test_data`、`propose_plan` | `propose_plan` | `case-to-flow`、`case-to-steps` |
| `triager` | `load_skill`、`record_verdict` | `record_verdict` | `failure-triage` |
| `repairer` | `load_skill`、`list_test_data`、`propose_plan` | `propose_plan` | `case-to-steps` |
| `reporter` | — | — | — |

终结工具的输入经过与门禁相同的校验；不合格时以 `is_error` 回传问题清单，模型修正后重新提交。白名单外的工具调用不会被执行。

**叠加一个新组件**：

1. Skill：新建 `components/skills/<name>/SKILL.md`，frontmatter 写 `name`、`description`、`roles`，重启服务或在⑥批准草稿即生效。
2. MCP：把 server 放到 `components/mcp/<name>/`，在 `components/mcp.json` 登记 `command`、`args`、`roles`，在⑥点“启用”。
3. 让 Agent 起草：在⑥“问 Agent”描述需要的能力，orchestrator 会生成草稿等待批准。

## 七、模型可插拔

`config/llm.yaml` 选择默认 provider，也可以按角色路由；环境变量 `LLM_PROVIDER` 优先。

```yaml
default: claude
providers:
  claude:   { type: anthropic, model: claude-opus-5, refusalFallback: true }
  deepseek: { type: openai-compatible, baseURL: https://api.deepseek.com, model: deepseek-chat, apiKeyEnv: DEEPSEEK_API_KEY }
  mock:     { type: mock }
roles:
  triager: deepseek
```

**预期**：启动日志中出现 `compiler=claude · claude-opus-5  triager=deepseek · deepseek-chat …`，前端侧栏底部显示同样的路由。

| provider 类型 | 说明 |
| --- | --- |
| `anthropic` | 官方 `@anthropic-ai/sdk`；默认 `claude-opus-5`，开启服务端拒答回退（`fallbacks: "default"`）；同供应商续聊时原样回传 thinking 块 |
| `openai-compatible` | OpenAI 协议，覆盖 DeepSeek、通义千问、本地 vLLM/Ollama；`vision: true` 时附带失败截图 |
| `mock` | 规则引擎，走与真实模型完全相同的 Agent Loop 与组件调用，用于离线演示与自动化测试 |

## 八、实时可视化

| 通道 | 实现 | 用途 |
| --- | --- | --- |
| 前端直播 | CDP `Page.startScreencast` 推 JPEG 帧 → 事件总线 → WebSocket → ③的画面区；WebSocket 缓冲超过 4 MB 时丢帧不丢状态 | 执行时实时观看 |
| 步骤高亮 | `step start/end` 事件驱动步骤时间线，附每步截图与耗时 | 定位出错的步骤 |
| 录像与 trace | Playwright `recordVideo` + `tracing`，保存在 `data/evidence/<runId>/` | 回放与归档；`npx playwright show-trace` 逐步查看 DOM 快照 |
| 有头浏览器 | ③勾选“同时打开有头浏览器”，使用项目配置的 `slowMo` | 现场演示 |
| OBS 录制 | `obs-recorder` MCP：执行前 `start_record`，结束后 `stop_record` | 产出正式演示视频，需要 OBS 30+ 并开启 WebSocket 服务 |
| Token 用量 | Agent Loop 每轮把适配器返回的 `usage` 放进 `llm` 事件；每次运行结束落盘 `data/usage/` 并发 `usage` 事件；前端 `TokenUsage` = 落盘累计 + 进行中实时累加；`GET /api/usage?projectId=&scope=` | 编译、归因、修正、报告、问 Agent 旁显示用量，侧栏显示项目累计；mock 只计调用次数 |

## 九、数据模型与存储

所有对象都以 zod schema 定义（`packages/core/src/types.ts`），在 `data/` 下一对象一文件，写入为原子写（临时文件 + rename）并持有进程内锁。

```text
data/
├── cases/<id>.json        # TestCase：自然语言步骤、预期、测试数据 data{}、版本
├── plans/<id>.json        # StepPlan：Step DSL、状态 draft|approved|superseded|discarded、derivedFrom 修正链
├── runs/<id>.json         # Run：round、attemptId、trigger、步骤结果、证据路径
├── findings/<id>.json     # Finding：verdict、状态、预期/实际、建议、证据、supersededBy
├── feedback/<id>.json     # Feedback：人的反馈（fix-step / supply-data / confirm-defect / not-a-defect / dismiss）
├── reports/<id>.json      # Report 元数据；HTML 在 report-html/
├── evidence/<runId>/      # 每步截图、video.webm、trace.zip
├── transcripts/           # 每次 Agent 运行的完整过程（LLM 回复与工具调用）
├── usage/<id>.json        # UsageRecord：每次 Agent 运行的 scope、角色、模型、项目、输入/输出 token、调用次数
└── uploads/               # 人在门禁里上传的测试文件
```

> 单进程内一致；多个进程同时写同一对象不保证一致，这与 `dsh-agent-teams` 的约束相同。

## 十、前端交互

| 页面 | 人做什么 | 看什么算成功 |
| --- | --- | --- |
| ① 用例录入 | 填写或编辑用例；对 molardata 从功能点清单勾选导入 | 列表出现用例，版本号随编辑递增 |
| ② 步骤编译 | 点“编译”，审阅阶段、测试数据与决策点，在表格里改草稿或补数据，点“批准” | 计划状态变为“已批准”；Agent 过程面板显示 `load_skill`、`list_test_data`、`propose_plan` 调用 |
| ③ 执行直播 | 勾选用例与选项，点“执行所选” | 画面实时变化，步骤逐个变为 ✓；结束后可播放录像 |
| ④ 失败门禁 | 对步骤错误写指点或直接改步骤；对缺数据填值或上传文件 | Finding 依次变为“修正中 → 重跑中 → 已解决” |
| ⑤ 结果审阅 | 对疑似缺陷“确认”或“不是缺陷并写明正确预期”；生成报告 | 报告状态为“定稿”，缺陷卡片附预期、实际、截图 |
| ⑥ 组件中心 | 启停 MCP、审批草稿、向 orchestrator 提需求 | 组件状态为 `ready`，批准后的 Skill 出现在列表 |

侧栏徽标显示④、⑤待处理数量；所有页面通过 WebSocket 事件自动刷新。

## 十一、接入被测项目

一个被测项目 = `projects/<id>/project.yaml`，支持 `${VAR}` 与 `${VAR:-默认值}`。

| 字段 | 说明 |
| --- | --- |
| `baseURL` | 被测站点地址，`goto` 使用相对路径 |
| `authRoles` | 角色 → Playwright storageState 路径；计划的 `authRole` 决定用哪个登录态 |
| `knowledgeSkills` | 编译时要求 Agent 加载的领域知识 Skill |
| `importers.checklistDir` | 功能点清单目录，启用①的清单导入；编译时把条目所在的文件头、章节与同章节条目交给 compiler |
| `envFile` | 额外的 `.env`，只用于展开本文件与 `test-data.yaml` 中的 `${VAR}`；非空的环境变量优先 |
| `test-data.yaml`（同目录） | 测试数据目录 `entries: [{ key, description, value, tags }]`；只有登记的条目会交给模型，`tags` 含 `path` 的值按仓库根解析 |

**molardata 接入**（`projects/molardata/project.yaml`）：

1. 在 `molardata-e2e` 执行 `npm run auth:all`，生成 `auth/*.json`；本平台直接引用，不复制凭据。
2. 设置 `MOLAR_BASE_URL`（以及目录不在默认位置时的 `MOLAR_AUTOTEST_DIR`）。`TASK_ID_*` 从 `molardata-e2e/.env` 读取，展开到 `test-data.yaml` 的任务条目。
3. 在①选择“MolarData 标注平台”，从 `testcases/0N-*.md` 勾选条目导入，`source` 记为 `molardata:02-A1`，与 molardata ledger 主键一致。
4. 清单条目是功能点而非详细步骤，`config/llm.yaml` 已把 `compiler`、`repairer` 路由到 OpenAI 兼容的 `ppapi` provider，密钥写在仓库根目录的 `.env`（`PPAPI_API_KEY=…`，已 gitignore，服务启动时自动加载）；`mock` 规则引擎只理解用「」标注的规范句式。

> ⚠️ 登录态文件缺失时，执行直接判为 `data-missing`，建议文案会提示先生成 storageState。

## 十二、演进路线

以下能力都以组件形式叠加，不需要改动核心：

| 需求 | 建议组件 | 形式 |
| --- | --- | --- |
| Canvas / WebGL 标注工具 | `canvas-state`：调用页面暴露的 Canvas State Hook 断言 | MCP + Skill |
| 视觉回归 | `visual-diff`：截图基线比对 | MCP |
| 造数与清理 | `molar-api`：调用平台 API 创建任务、导入数据 | MCP |
| 多角色协作用例 | `multi-role`：同一用例内切换 storageState | runner 扩展 + Skill |
| AI 视觉自愈 | 在 triager 中结合截图与 ARIA 快照给出 locator 候选（已有基础），再由 repairer 自动修正 | Skill |
| CI 集成 | 以 API 触发执行，报告定稿作为流水线门禁 | server 路由 |
| molardata ledger 回写 | 把 Finding 按 `F-NNNN.md` 格式写回 `ledger/findings/` | Skill + importers 扩展 |
