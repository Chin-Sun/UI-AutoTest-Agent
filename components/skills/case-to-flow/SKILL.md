---
name: case-to-flow
description: 智能编译方法论：从任意形态的用例（清单标题、自由文本、文档片段）推断意图，挑选或构造测试数据，生成「准备 → 操作 → 决策 → 验证 → 清理」分阶段流程并记录决策点
roles: [compiler, repairer]
---

# 用例 → 分阶段流程

你的任务不是逐句翻译，而是**替测试工程师把一条用例想清楚、跑得通**。输入往往只有一句话（例如清单条目「删除有数据的节点：弹出拦截提示，要求选择数据转移的目标节点后才能删除」），这完全正常：不要因为句子不规范而拒绝编译，也不要把整句原样塞进一个步骤。

动作表、locator 优先级和 Step 字段见 `case-to-steps`；本 skill 说明**怎么思考**，以及 `propose_plan` 里新增的 `data` / `decisions` / `stage` 怎么写。

## 工作顺序

### 1. 理解意图

读 payload 里的这些信息：

| 来源 | 用法 |
| --- | --- |
| `case.title` / `steps` / `expected` | 被测功能点；steps 与 expected 相同时，说明它来自清单，需要你展开 |
| `source.fileHeader` | 清单文件头的「页面 / 可见角色 / 前置」，决定入口页面、账号和隐含前置 |
| `source.section` | 所在章节，例如「C. 节点增删改」 |
| `source.siblings` | 同章节的其他条目，常常补充了边界条件（例如 C6「目标为标注节点时需额外选团队」、C7「无数据节点直接删除」），用于区分本条要验证什么、不要验证什么 |
| 项目知识 skill | 页面路径、控件名称、业务规则 |

先在心里回答四个问题，再写到 `rationale` 的开头（2～4 句即可）：

1. **被测行为**是什么？是正向流程，还是拦截、校验这类行为？
2. **触发操作**是哪一步？
3. **可观测的预期**是什么？页面上能看到的弹窗文案、按钮状态、列表变化分别是什么？
4. **隐含前置**有哪些？用例没说，但不满足就测不了的条件。

### 2. 列数据需求

每一条前置条件都要落成一个数据 key，并写清约束。例如 C5：

- `taskId`：一个已有工作流、可编辑节点的任务
- `sourceNode`：一个**有数据**且可删除（非内置）的节点

### 3. 选数据（按优先级，逐个 key 决定来源）

先调用 `list_test_data` 查看目录（可以按 tags 或关键词过滤）。

| 优先级 | source | 什么时候用 | 怎么写 |
| --- | --- | --- | --- |
| 1 | `catalog` | 目录里有满足约束的条目 | `{ key, source: "catalog", ref: "<目录 key>", reason }` |
| 2 | `generated` | 名称、备注这类由测试自己决定的值 | `{ key, source: "generated", value: "uta-{{case}}-{{ts}}", reason }`，每次执行时生成，避免与共享环境里的旧数据冲突 |
| 3 | `setup` | 目录里没有，但能在页面上造出来（新建记录、导入少量文件） | `{ key, source: "setup", value: "<造出来的对象的名称或模板>", reason }`，并在 `setup` 阶段写出造数步骤 |
| 4 | `human` | 以上都做不到，例如需要一个特定线上对象 | `{ key, source: "human", reason: "需要…" }`，不填 value，执行前门禁会请人补充 |

规则：

- 目录里有的数据，**不要**标成 `human` 推给人。目录条目显示「未配置」时，可以照样引用它（人会在门禁里补），也可以改用 `setup` 自己造，并在 reason 里说明。
- 多条候选都满足时，选**副作用最小**的：优先只读的，其次是专门给自动化用的对象。
- 步骤里凡是出现 `${data.key}`，这个 key 必须在 `data` 中声明，否则计划会被门禁退回。
- 标成 `setup` 的 key，必须在 setup 阶段有真正创建它的步骤；不能只声明、不创建。

### 4. 用积木到达页面、准备前置对象

先调用 `list_flows`：

- **登录**：项目配置了登录时，执行前会自动复用或建立会话。不要写登录步骤，也不要打开登录页。
- **到达页面**：准备阶段用积木找到前置对象、打开目标页面，不要手写猜测的地址（`goto task-v2/detail?...` 这类地址往往是错的）。
- **调用写法**：`{ "id": "s1", "stage": "setup", "action": "use", "flow": "<积木 id>", "params": { … } }`。
- **积木输出**：在后续步骤里用 `${data.<key>}` 引用，不需要在 `data` 里声明；在产出它的积木之前引用会被退回。
- **枚举参数**（工具类型、页面名等）写字面值，不要写成 `${data.x}`。
- **没有合适的积木时**：照常用 Step DSL 编写，并在 rationale 写明「建议新增积木：…」。

### 5. 建流程

每个 step 都要带 `stage`，顺序为：

| stage | 放什么 | 要求 |
| --- | --- | --- |
| `setup` | 进入页面、造前置数据 | 只做被测行为必需的准备；登录态由项目提供，不要加登录步骤 |
| `action` | 触发被测操作 | 与用例描述的操作一一对应 |
| `decision` | 流程中需要选择的地方（弹窗里选目标、选团队） | 每一处都对应一个决策点 |
| `verify` | 断言 | 每条预期至少一个断言；拦截类用例既要断言「被拦住」，也要断言「选择后才成功」 |
| `cleanup` | 删除本次 `setup` 造的数据 | 共享环境必须清理；无法清理时在 rationale 说明 |

`caseRef` 仍然指向用例原句（0 起，预期句接在步骤句之后）。由你推断出来的准备、清理步骤可以不填。

### 6. 记录决策点

凡是用例没写死、需要你做选择的地方，都写进 `decisions`。每个决策点包含 `id`、`question`、`options`、`chosen`、`reason`、`stepIds`。

需要记录的典型情况：

- 选哪个任务或节点
- 快捷键用 Delete 还是 Backspace
- 列表里有多项时选第几项
- 断言选哪个可观测证据

`chosen` 必须是 `options` 之一，`stepIds` 必须是真实存在的步骤 id。`reason` 要说清为什么不选其他候选，例如「标注节点会额外触发 02-C6 的选团队分支」。

### 7. 页面结构不确定时

- `playwright` MCP 可用：先打开目标页面读快照，再确定 locator。
- MCP 不可用：按项目知识和常见中文控件名编译，把**关键假设**写进 rationale（例如「假设弹窗确认按钮叫『确定』」）。人会在审批或门禁时修正，这比拒绝编译更有价值。
- Canvas / WebGL 画布（工作流画布、标注工作台）里的元素无法用 DOM 定位：
  - 操作：优先使用画布外的 DOM 入口，例如节点切换 Tab、属性面板、卡片菜单；
  - 断言：使用弹窗文案、toast、Tab 列表、条目页数据这类 DOM 可见的证据；
  - 必须操作画布坐标才能完成的，在 rationale 标注「需要 Canvas 组件」。

## 禁止

- 因为「句子不规范 / 信息不足」直接放弃。信息不足时写出假设，然后继续编译。
- 编造 `testId`。
- 加登录步骤，或者切换账号重新登录（会顶掉已存的登录态）。
- 项目有积木时手写猜测的页面地址。
- 写没有断言的计划，或者断言与用例预期无关。
- 在一个计划里验证多个清单条目。相邻条目只用于理解边界。

## 提交格式

```json
{
  "rationale": "被测行为：…；触发：…；预期：…；前置：…。假设：…",
  "data": [ { "key": "…", "source": "catalog|generated|setup|human", "ref": "…", "value": "…", "reason": "…" } ],
  "decisions": [ { "id": "d1", "question": "…", "options": ["…"], "chosen": "…", "reason": "…", "stepIds": ["s…"] } ],
  "steps": [ { "id": "s1", "stage": "setup", "action": "goto", "value": "…" } ]
}
```

## 完整示例：02-C5 删除有数据的节点

输入：`steps = expected = ["删除有数据的节点：弹出拦截提示，要求选择数据转移的目标节点后才能删除"]`。`source.fileHeader` 写明「页面：任务详情 →【工作流】画布；前置：任务已创建，已有数据导入」，`source.siblings` 里有 A1、A2（内置节点不可删）、C6、C7。

```json
{
  "rationale": "被测行为：删除有数据的节点会被拦截，必须选择数据转移目标后才能删除。触发：对一个有数据的非内置节点执行删除。预期：弹出拦截提示并要求选择目标节点；选择并确认后节点被删除，节点 Tab 中不再出现。前置：任务有工作流，且存在一个有数据的非内置节点。用积木 molar.ensureTask 取目录预定义的 IAT 任务（已有导入数据），再用 molar.openTaskPage 打开工作流页。假设：节点删除入口是选中节点 Tab 后的「删除」按钮；拦截弹窗包含「转移」字样，确认按钮叫「确定」；「合格数据」节点可以作为转移目标。画布是 Canvas，无法用 DOM 新建节点并灌入数据，所以有数据的节点只能由人提供；该节点会被本用例删除，每次执行前需要重新准备。",
  "data": [
    { "key": "sourceNode", "source": "human", "reason": "需要一个有数据、可删除的非内置节点名称；画布是 Canvas，无法用 DOM 新建节点并导入数据" }
  ],
  "decisions": [
    { "id": "d1", "question": "删除哪个节点？", "options": ["原始数据", "标注", "人提供的有数据非内置节点"], "chosen": "人提供的有数据非内置节点", "reason": "原始数据、标注是内置节点，不可删除（02-A1/A2），走不到数据转移拦截", "stepIds": ["s4", "s5"] },
    { "id": "d2", "question": "数据转移到哪个节点？", "options": ["合格数据", "标注"], "chosen": "合格数据", "reason": "内置节点始终存在；标注节点会额外要求选择接收团队（02-C6），本条只验证基础拦截", "stepIds": ["s8", "s9"] }
  ],
  "steps": [
    { "id": "s1", "stage": "setup", "action": "use", "flow": "molar.ensureTask", "params": { "tool": "IAT", "ref": "task.iat" } },
    { "id": "s2", "stage": "setup", "action": "use", "flow": "molar.openTaskPage", "params": { "taskId": "${data.taskId}", "page": "workflow" } },
    { "id": "s3", "stage": "setup", "action": "assertVisible", "target": { "text": "原始数据" }, "note": "确认画布已加载" },
    { "id": "s4", "stage": "action", "action": "click", "target": { "role": "tab", "name": "${data.sourceNode}" }, "note": "选中有数据的节点" },
    { "id": "s5", "stage": "action", "action": "click", "target": { "role": "button", "name": "删除" }, "caseRef": 0 },
    { "id": "s6", "stage": "verify", "action": "assertVisible", "target": { "role": "dialog" }, "caseRef": 1 },
    { "id": "s7", "stage": "verify", "action": "assertText", "target": { "role": "dialog" }, "expect": "转移", "caseRef": 1 },
    { "id": "s8", "stage": "decision", "action": "click", "target": { "label": "目标节点" } },
    { "id": "s9", "stage": "decision", "action": "click", "target": { "role": "option", "name": "合格数据" } },
    { "id": "s10", "stage": "action", "action": "click", "target": { "role": "button", "name": "确定" } },
    { "id": "s11", "stage": "verify", "action": "assertHidden", "target": { "role": "tab", "name": "${data.sourceNode}" }, "caseRef": 1 }
  ]
}
```

本例没有 cleanup 阶段，因为唯一被改动的数据就是被删除的节点本身。如果准备阶段新建了节点或导入轮次，必须在 cleanup 中删除。
