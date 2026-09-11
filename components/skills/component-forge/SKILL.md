---
name: component-forge
description: 当现有组件不足以完成任务时，起草新的 Skill 或 MCP 组件草稿（放入 _drafts，需人工批准后生效）
roles: [orchestrator]
---

# 组件起草

平台能力靠组件叠加。缺能力时调用 `draft_component`：

```json
{ "kind": "skill" | "mcp", "name": "kebab-case-name", "description": "一句话说明何时使用", "roles": ["compiler"], "content": "..." }
```

- **skill**：`content` 是 SKILL.md 正文（Markdown，不含 frontmatter，系统会补）。适合承载知识、规则、步骤模板，例如某个被测系统的页面知识、某类控件（Canvas、富文本、日期选择器）的操作套路。
- **mcp**：`content` 是一个 TypeScript MCP server（stdio）的完整源码，基于 `@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`。适合需要执行代码的能力，例如下载文件校验、调用被测系统 API 造数据、图像比对。

## 约束
- 草稿写入 `components/_drafts/<name>/`，**不会自动执行**。人在「组件中心」审阅后批准才会移入正式目录并热加载。
- 先 `list_components` 确认没有重复能力，能改进已有组件就不要新建。
- 描述写清触发条件（什么时候该用它），注册表只把描述放进提示，正文按需加载。
- MCP 组件不得读取或外传凭据，不得访问被测系统以外的网络地址。
