/**
 * obs-recorder：把 OBS 录制能力包装成 MCP 组件（stdio）。
 * 需要 OBS 30+，并在「工具 → WebSocket 服务器设置」中启用服务。
 * 环境变量：OBS_WEBSOCKET_URL（默认 ws://127.0.0.1:4455）、OBS_WEBSOCKET_PASSWORD
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
// 显式使用 JSON 协议（Node 下默认是 msgpack）；OBS 两种都支持，JSON 便于排查
import OBSWebSocket from 'obs-websocket-js/json'
import { z } from 'zod'

const obs = new OBSWebSocket()
let connected = false
obs.on('ConnectionClosed', () => { connected = false })

async function ensureConnected(): Promise<void> {
  if (connected) return
  const password = process.env['OBS_WEBSOCKET_PASSWORD']
  await obs.connect(process.env['OBS_WEBSOCKET_URL'] ?? 'ws://127.0.0.1:4455', password === '' ? undefined : password)
  connected = true
}

type Reply = { content: { type: 'text', text: string }[], isError?: boolean }

function tool(fn: (args: Record<string, unknown>) => Promise<string>): (args: Record<string, unknown>) => Promise<Reply> {
  return async (args) => {
    try {
      await ensureConnected()
      return { content: [{ type: 'text', text: await fn(args) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `OBS 操作失败：${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  }
}

const server = new McpServer({ name: 'obs-recorder', version: '0.1.0' })

server.registerTool('status', { description: '查询 OBS 连接与录制状态' }, tool(async () => {
  const [record, scene] = await Promise.all([obs.call('GetRecordStatus'), obs.call('GetCurrentProgramScene')])
  return JSON.stringify({ recording: record.outputActive, timecode: record.outputTimecode, scene: scene.currentProgramSceneName })
}))

server.registerTool('list_scenes', { description: '列出 OBS 场景' }, tool(async () => {
  const { scenes } = await obs.call('GetSceneList')
  return scenes.map((scene) => scene['sceneName']).filter((name): name is string => typeof name === 'string').join('\n')
}))

server.registerTool('set_scene', { description: '切换 OBS 场景', inputSchema: { scene: z.string() } }, tool(async (args) => {
  await obs.call('SetCurrentProgramScene', { sceneName: String(args['scene']) })
  return `已切换到场景 ${String(args['scene'])}`
}))

server.registerTool('start_record', { description: '开始录制，可选先切换场景', inputSchema: { scene: z.string().optional() } }, tool(async (args) => {
  if (typeof args['scene'] === 'string' && args['scene'] !== '') await obs.call('SetCurrentProgramScene', { sceneName: args['scene'] })
  const status = await obs.call('GetRecordStatus')
  if (!status.outputActive) await obs.call('StartRecord')
  return '录制已开始'
}))

server.registerTool('stop_record', { description: '停止录制，返回录像文件路径' }, tool(async () => {
  const status = await obs.call('GetRecordStatus')
  if (!status.outputActive) return '当前没有在录制'
  const { outputPath } = await obs.call('StopRecord')
  return outputPath
}))

await server.connect(new StdioServerTransport())
