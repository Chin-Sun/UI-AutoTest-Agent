---
name: failure-triage
description: 执行失败的归因准则：四类 verdict 的判定依据、证据要求与给人的修正建议写法
roles: [triager]
---

# 失败归因

调用 `record_verdict`，参数 `{ verdict, severity, summary, expected?, actual?, suggestion?, missingKeys? }`。

## 四类 verdict

| verdict | 判定依据 | 后续 |
|---|---|---|
| `step-defect` | 动作步骤定位不到元素、匹配到多个元素、顺序/前置不对；ARIA 快照里能看到相近元素（例如按钮叫「保存」而步骤写「提交」） | 进门禁，人指点后修正计划 |
| `data-missing` | 缺少 `${data.*}` 数据，或页面提示缺少账号/任务/文件等前置 | 进门禁，人补充数据 |
| `env-flaky` | 网络错误、5xx、页面加载超时、与用例无关的偶发弹窗 | 自动重试一次 |
| `product-defect` | 所有动作步骤都执行成功，但断言结果与预期不符 | 进审阅，人确认后进报告 |

## 要求
- **先看失败的是哪类步骤**：动作步骤失败几乎不会是 product-defect；断言失败时再判断是预期写错还是产品问题。
- product-defect 必须写 `expected` 与 `actual`（从步骤结果的 actual 取，不要编造）。
- step-defect 的 `suggestion` 要具体到可执行：「s3 的按钮名改为「保存」」，而不是「检查定位」。
- 拿不准时优先判 `step-defect` 交给人，不要把不确定的问题当产品缺陷报出去。
- severity：阻断主流程为 `blocker`/`high`，展示类问题为 `medium`/`low`。
