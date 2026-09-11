---
name: molar-platform
description: MolarData 数据标注平台（任务 2.0）的页面与业务知识，编译该项目用例时加载
roles: [compiler, triager, repairer]
---

# MolarData 标注平台知识

来源：`MolarTest/AutoTest/testcases/README.md` 与 molardata-e2e 工程约定。

## 范围
- 只覆盖任务 2.0（`/task-v2/*`），旧版任务 1.0 页面不在范围内。
- 清单以代码实现为准。清单主键形如 `02-A1`（文件号 + 清单内编号），导入的用例 `source` 记为 `molardata:02-A1`。

## 账号与角色
- 登录态由 storageState 提供：`admin`（默认）、`annotator`、`reviewer`。不要在计划里加登录步骤。
- 平台对同一账号只保留一个有效会话：计划里不要重新登录，否则会顶掉已存的 token。
- 按钮权限按中文字面量匹配，界面语言为 zh-CN。

## 页面与定位
- 优先使用阶段二迁移的 `data-testid`；没有 testid 时用 role + 中文可访问名称。
- 表格暂无行级 testid：定位行时用 `{text}` 找行内唯一文本，再对行内按钮使用 role。
- 工作流画布、标注工作台是 Canvas/WebGL，不能用 DOM 断言节点，遇到这类用例在 rationale 标注「需要 Canvas 组件」，由 orchestrator 决定是否起草组件。

## 数据
- 数据导入类用例需要真实任务 ID 与测试文件，缺失时引用 `${data.taskId}`、`${data.importFile}`，由门禁请人补充。
- Daily 为共享环境，用例之间可能互相干扰；执行默认串行。
