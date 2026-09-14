/** 测试用 MCP server（stdio）：echo 回显、fail 总是返回错误 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.registerTool('echo', { description: '回显文本', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }))
server.registerTool('fail', { description: '总是失败' }, async () => ({ content: [{ type: 'text', text: '坏了' }], isError: true }))
await server.connect(new StdioServerTransport())
