/**
 * 角色 = persona + 工具白名单（对应 dsh-agent-teams 成员的 MEMBER_DENIED_TOOLS）。
 * 编排链路由 server 的 Pipeline 状态机决定；orchestrator 负责开放式请求与组件扩展。
 */
export type RoleName = 'orchestrator' | 'compiler' | 'triager' | 'repairer' | 'reporter'

export interface RoleDef {
  name: RoleName
  persona: string
  /** 允许的内置工具；MCP 工具按 mcp.json 里 server.roles 追加 */
  tools: string[]
  /** 调用成功即结束的工具；为空表示以最终文本结束 */
  terminalTool?: string
  /** 开工前必须加载的 skill */
  requiredSkills: string[]
}

export const ROLES: Record<RoleName, RoleDef> = {
  orchestrator: {
    name: 'orchestrator',
    persona: '你是 UI 测试平台的编排 Agent。你了解平台已注册的全部组件（Skill 与 MCP），根据请求决定调用哪些组件；现有组件不足以完成任务时，按 component-forge 起草新组件，交给人审批。',
    tools: ['list_components', 'load_skill', 'draft_component'],
    requiredSkills: [],
  },
  compiler: {
    name: 'compiler',
    persona: '你是用例编译 Agent：把任意形态的测试用例（清单里的一句标题、自由文本、文档片段）编译成 Playwright 可执行的分阶段流程。你自己推断前置条件、挑选或构造测试数据、在流程中做出选择并说明理由；不要求输入是规范句式。你不执行测试，只输出计划。',
    tools: ['list_components', 'load_skill', 'list_test_data', 'propose_plan'],
    terminalTool: 'propose_plan',
    requiredSkills: ['case-to-flow', 'case-to-steps'],
  },
  triager: {
    name: 'triager',
    persona: '你是失败归因 Agent：根据失败步骤、错误、截图与 ARIA 快照判定失败类型，并给人可执行的修正建议。你不修改计划。',
    tools: ['load_skill', 'record_verdict'],
    terminalTool: 'record_verdict',
    requiredSkills: ['failure-triage'],
  },
  repairer: {
    name: 'repairer',
    persona: '你是用例修正 Agent：根据人的反馈修正测试计划。只改与反馈相关的步骤、数据或决策点，其余步骤与 id 保持不变。',
    tools: ['load_skill', 'list_test_data', 'propose_plan'],
    terminalTool: 'propose_plan',
    requiredSkills: ['case-to-steps'],
  },
  reporter: {
    name: 'reporter',
    persona: '你是测试报告 Agent：用简洁中文总结本轮测试结论、已确认的缺陷与仍待处理的门禁，面向测试负责人。只陈述事实。',
    tools: [],
    requiredSkills: [],
  },
}
