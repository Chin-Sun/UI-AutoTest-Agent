---
name: case-to-steps
description: 把自然语言测试用例编译成 Playwright 可执行的 Step DSL，包含动作表、locator 优先级与示例
roles: [compiler, repairer]
---

# 用例 → Step DSL

## 输出

调用 `propose_plan`，参数 `{ steps: Step[], rationale }`。每个 Step：

| 字段 | 说明 |
| --- | --- |
| `id` | `s1`、`s2`……按顺序，修正时保留原 id |
| `action` | 见下表 |
| `target` | 只能是以下之一：`{testId}` `{role,name}` `{label}` `{placeholder}` `{text}` `{css}` |
| `value` | goto 的相对 URL（不要以 `/` 开头，基于项目 baseURL）、fill/select 的值、press 的按键、upload 的路径 |
| `expect` | 断言期望 |
| `caseRef` | 对应原用例第几句（0 起；预期句接在步骤句之后编号） |

| action | 需要 |
| --- | --- |
| goto | value |
| click / check / uncheck / hover | target |
| fill / select / upload | target + value |
| press | value（target 可选） |
| waitFor | target 或毫秒数 value |
| assertVisible / assertHidden | target |
| assertText / assertValue | target + expect（包含即通过） |
| assertUrl | expect（子串或 `/正则/`） |
| assertCount | target + expect（整数） |

## 规则

1. **locator 优先级**：`testId` > `role+name` > `label` > `placeholder` > `text` > `css`。不要编造 testId；没把握时用 role/label/text。
2. 按钮、链接用 `{role: "button"|"link", name}`；输入框优先 `{label}`，没有 label 时用 `{placeholder}`。
3. 用例里的每条「预期」至少对应一个断言步骤，没有断言的计划会被门禁拒绝。
4. 用例中以 `${data.key}` 出现的数据原样保留，不要替换成猜测值；缺的数据由门禁请人补充。
5. 不确定页面结构时，如果 `playwright` MCP 可用，先打开页面读快照再出计划；否则按用例字面编译，并在 rationale 写明假设。
6. 不要加入用例没有要求的步骤（例如额外登录），登录态由项目的 storageState 提供。

## 示例

用例：打开「login.html」；在「用户名」输入「alice」；点击「登录」按钮；预期：页面显示「欢迎，alice」

```json
[
  {"id":"s1","action":"goto","value":"login.html","caseRef":0},
  {"id":"s2","action":"fill","target":{"label":"用户名"},"value":"alice","caseRef":1},
  {"id":"s3","action":"click","target":{"role":"button","name":"登录"},"caseRef":2},
  {"id":"s4","action":"assertVisible","target":{"text":"欢迎，alice"},"caseRef":3}
]
```
