/**
 * obs-recorder MCP 组件：以真实 stdio 子进程启动，连一个假的 OBS WebSocket（v5 协议）服务，
 * 验证工具注册与录制 / 场景控制；再验证 OBS 不可达时以 isError 返回而不是崩溃。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const serverPath = fileURLToPath(new URL('../server.ts', import.meta.url))

interface FakeObs { url: string, state: { recording: boolean, scene: string, requests: string[] }, close(): Promise<void> }

async function startFakeObs(): Promise<FakeObs> {
  const state = { recording: false, scene: '场景1', requests: [] as string[] }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (protocols) => (protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false) })
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }))
    socket.on('message', (raw) => {
      const message = JSON.parse((raw as Buffer).toString('utf8')) as { op: number, d: { requestType: string, requestId: string, requestData?: Record<string, unknown> } }
      if (message.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }))
        return
      }
      if (message.op !== 6) return
      const { requestType, requestId, requestData } = message.d
      state.requests.push(requestType)
      let responseData: Record<string, unknown> = {}
      switch (requestType) {
        case 'GetRecordStatus': responseData = { outputActive: state.recording, outputTimecode: '00:00:01.000' }; break
        case 'GetCurrentProgramScene': responseData = { currentProgramSceneName: state.scene }; break
        case 'GetSceneList': responseData = { scenes: [{ sceneName: '场景1' }, { sceneName: '演示' }] }; break
        case 'SetCurrentProgramScene': state.scene = typeof requestData?.['sceneName'] === 'string' ? requestData['sceneName'] : ''; break
        case 'StartRecord': state.recording = true; break
        case 'StopRecord':
          state.recording = false
          responseData = { outputPath: '/tmp/rec.mkv' }
          break
      }
      socket.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }))
    })
  })
  await new Promise((resolve) => wss.on('listening', resolve))
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    state,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate()
      wss.close(() => resolve())
    }),
  }
}

async function connectMcp(obsUrl: string): Promise<Client> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', serverPath], cwd: repo, stderr: 'ignore',
    env: { ...env, OBS_WEBSOCKET_URL: obsUrl, OBS_WEBSOCKET_PASSWORD: '' },
  })
  const client = new Client({ name: 'obs-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[]).map((item) => item.text).join('\n')

describe('obs-recorder 与 OBS 正常连接', () => {
  let obs: FakeObs
  let client: Client
  beforeAll(async () => {
    obs = await startFakeObs()
    client = await connectMcp(obs.url)
  })
  afterAll(async () => {
    await client.close()
    await obs.close()
  })

  it('注册 5 个工具', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_scenes', 'set_scene', 'start_record', 'status', 'stop_record'])
  })

  it('status / list_scenes / set_scene', async () => {
    expect(JSON.parse(text(await client.callTool({ name: 'status', arguments: {} })))).toEqual({ recording: false, timecode: '00:00:01.000', scene: '场景1' })
    expect(text(await client.callTool({ name: 'list_scenes', arguments: {} }))).toBe('场景1\n演示')
    expect(text(await client.callTool({ name: 'set_scene', arguments: { scene: '演示' } }))).toBe('已切换到场景 演示')
    expect(obs.state.scene).toBe('演示')
  })

  it('开始录制可先切场景，重复开始不会再次调用 StartRecord；停止返回录像路径', async () => {
    obs.state.requests.length = 0
    expect(text(await client.callTool({ name: 'start_record', arguments: { scene: '场景1' } }))).toBe('录制已开始')
    expect(obs.state).toMatchObject({ recording: true, scene: '场景1' })
    await client.callTool({ name: 'start_record', arguments: {} })
    expect(obs.state.requests.filter((r) => r === 'StartRecord')).toHaveLength(1)
    expect(text(await client.callTool({ name: 'stop_record', arguments: {} }))).toBe('/tmp/rec.mkv')
    expect(text(await client.callTool({ name: 'stop_record', arguments: {} }))).toBe('当前没有在录制')
    expect(obs.state.recording).toBe(false)
  })
})

describe('obs-recorder 在 OBS 不可达时', () => {
  it('工具返回 isError 与可读原因，进程不崩溃', async () => {
    const client = await connectMcp('ws://127.0.0.1:1')
    try {
      const result = await client.callTool({ name: 'status', arguments: {} })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/^OBS 操作失败/)
      expect((await client.listTools()).tools).toHaveLength(5)
    } finally {
      await client.close()
    }
  })
})
