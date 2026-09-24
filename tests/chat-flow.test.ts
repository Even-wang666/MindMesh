import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import { getAgentCapabilityHash, SessionResumeUnsupportedError, type DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import type { ChatImageAttachment, Message } from '../src/shared/contracts'

const image: ChatImageAttachment = {
  type: 'image', name: 'chart.png', mediaType: 'image/png', bytes: 68,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nCEAAAAASUVORK5CYII=',
}

describe('chat failures', () => {
  it('stops an active private reply without persisting a failure or later deltas', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi.fn((_agent, _prompt, _id, onText: (text: string) => void) => new Promise((_resolve, reject) => {
      rejectRun = reject
      emitText = onText
    }))
    const stop = vi.fn(async () => { rejectRun(new Error('runtime closed')); return true })
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => ({ send }) as unknown as WebContents)
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('已经输出')

      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      emitText('不应继续输出')
      const messages = await pending

      expect(stop).toHaveBeenCalledWith(agent)
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'agent'])
      expect(messages.at(-1)).toMatchObject({ content: '已经输出', stopped: true })
      expect(send.mock.calls.filter(([channel]) => channel === 'chat:delta'))
        .toEqual([['chat:delta', expect.objectContaining({ text: '已经输出' })]])
    } finally { db.close() }
  })

  it('marks a stopped space reply and does not replay it as complete after runtime recovery', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi.fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise((_resolve, reject) => { rejectRun = reject })
      })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '第二轮完成', sessionId: 'second-session' })
    const stop = vi.fn(async () => { rejectRun(new Error('runtime closed')); return true })
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      const first = service.sendSpace(space.id, `@${agent.name} 第一问`)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('被打断的半句话')

      await expect(service.stop('space', space.id)).resolves.toBe(true)
      expect((await first).at(-1)).toMatchObject({ content: '被打断的半句话', stopped: true })

      await service.sendSpace(space.id, `@${agent.name} 第二问`)
      expect(run.mock.calls[1][1]).not.toContain('被打断的半句话')
      expect(run.mock.calls[2][1]).toContain(`${agent.name}（回复已停止，内容可能不完整）：被打断的半句话`)
    } finally { db.close() }
  })

  it('shows another space agent that a stopped reply is incomplete', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi.fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise((_resolve, reject) => { rejectRun = reject })
      })
      .mockResolvedValueOnce({ text: '已知悉', sessionId: 'other-session' })
    const stop = vi.fn(async () => { rejectRun(new Error('runtime closed')); return true })
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const firstAgent = db.getAgent(space.memberIds[0])!
      const otherAgent = db.getAgent(space.memberIds[1])!
      const first = service.sendSpace(space.id, `@${firstAgent.name} 第一问`)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('被打断的半句话')
      await service.stop('space', space.id)
      await first

      await service.sendSpace(space.id, `@${otherAgent.name} 请继续`)

      expect(run.mock.calls[1][1]).toContain(`${firstAgent.name}（回复已停止，内容可能不完整）：被打断的半句话`)
    } finally { db.close() }
  })

  it('reports that stopping failed when the runtime is not exclusively owned', async () => {
    const db = new MindMeshDatabase(':memory:')
    let resolveRun!: (result: { text: string; sessionId: string }) => void
    const run = vi.fn(() => new Promise<{ text: string; sessionId: string }>((resolve) => { resolveRun = resolve }))
    const stop = vi.fn(async () => false)
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await expect(service.stop('private', agent.id)).resolves.toBe(false)
      resolveRun({ text: '正常完成', sessionId: 'session' })
      expect((await pending).at(-1)?.content).toBe('正常完成')
    } finally { db.close() }
  })

  it('latches a successful stop until the active run settles', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    const run = vi.fn(() => new Promise((_resolve, reject) => { rejectRun = reject }))
    const stop = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      expect(stop).toHaveBeenCalledOnce()
      rejectRun(new Error('runtime closed'))
      await pending
    } finally { db.close() }
  })

  it('shows a runtime error after failure and clears it after a successful reply', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ text: '恢复', sessionId: 'session' })
    const harness = { run, status: () => ({ state: 'ready' as const, label: '准备就绪', detail: '已配置' }) }
    const service = new MindMeshServices(db, harness as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '第一次')
      expect(service.runtimeStatus().state).toBe('error')
      await service.sendPrivate(agent.id, '第二次')
      expect(service.runtimeStatus().state).toBe('ready')
    } finally { db.close() }
  })

  it('persists a private model failure as a visible system message', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn().mockRejectedValue(new Error('secret token detail'))
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => ({ send }) as unknown as WebContents)
    try {
      const agent = db.listAgents()[0]
      const messages = await service.sendPrivate(agent.id, '你好')
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'system'])
      expect(messages[1].content).toContain('回复失败')
      expect(messages[1].content).not.toContain('secret token')
      expect(db.listMessages('private', agent.id)).toEqual(messages)
      expect(send).toHaveBeenCalledWith('chat:progress', { scope: 'private', scopeId: agent.id, agentName: agent.name })
    } finally {
      db.close()
    }
  })

  it('continues a space discussion after one agent fails', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ text: '第二位的回复' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => ({ send }) as unknown as WebContents)
    try {
      const space = db.listSpaces()[0]
      const agents = space.memberIds.map((id) => db.getAgent(id)!)
      const messages = await service.sendSpace(space.id, `@${agents[0].name} @${agents[1].name} 请讨论`)
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'system', 'agent'])
      expect(messages[1].content).toContain(agents[0].name)
      expect(messages[2].authorName).toBe(agents[1].name)
      expect(send.mock.calls.filter(([channel]) => channel === 'chat:progress')).toHaveLength(2)
      expect(run.mock.calls[1][1]).toContain(`${agents[0].name} 回复失败`)
    } finally {
      db.close()
    }
  })
})

describe('session context', () => {
  it('uses the live DeepSeek model list when the API is configured', async () => {
    const db = new MindMeshDatabase(':memory:')
    const providerSettings = {
      getProvider: vi.fn(() => ({ id: 'deepseek-official', apiKey: 'sk-test', name: 'DeepSeek' })),
      statuses: vi.fn(() => []),
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-future' }] }),
    })))
    const service = new MindMeshServices(db, {} as DeepSeekHarnessAdapter,
      providerSettings as unknown as ModelProviderSettings, () => undefined)
    try {
      expect((await service.models()).filter((item) => item.provider === 'deepseek-official'))
        .toEqual([
          { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
          { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
          { provider: 'deepseek-official', id: 'deepseek-future', name: 'deepseek-future' },
        ])
    } finally { db.close(); vi.unstubAllGlobals() }
  })

  it('refreshes the DeepSeek balance after a completed answer', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'session' })
    const providerSettings = {
      getProvider: vi.fn(() => ({ id: 'deepseek-official', apiKey: 'sk-test', name: 'DeepSeek' })),
      statuses: vi.fn(() => [{ id: 'deepseek-official', name: 'DeepSeek', description: 'DeepSeek 官方 API', configured: true, source: 'saved' }]),
    }
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '8.50', topped_up_balance: '80.00' }] }),
    }))
    vi.stubGlobal('fetch', request)
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      providerSettings as unknown as ModelProviderSettings, () => undefined)
    try {
      await service.sendPrivate(db.listAgents()[0].id, '你好')
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.anything()))
      expect(service.modelProviders()[0].balance?.items[0]).toMatchObject({ currency: 'CNY', total: '88.50' })
    } finally { db.close(); vi.unstubAllGlobals() }
  })

  it('routes a turn through the selected model and permission ceiling', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'selected-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const initial = db.listAgents()[0]
      db.updateAgent(initial.id, { ...initial, tools: ['网页搜索', '文件', 'Shell'] })
      await (service.sendPrivate as unknown as (...args: unknown[]) => Promise<Message[]>)(
        initial.id, '限制权限', [], { model: 'deepseek-v4-pro', permission: 'workspace' },
      )

      expect(run.mock.calls[0][0]).toMatchObject({
        model: 'deepseek-v4-pro',
        tools: ['网页搜索', '文件'],
      })
      await service.sendPrivate(initial.id, '恢复权限', [], { model: 'deepseek-v4-pro', permission: 'full' })
      expect(run.mock.calls[1][0].tools).toEqual(['网页搜索', '文件', 'Shell'])
    } finally { db.close() }
  })

  it('rejects a model override that was not returned by the DeepSeek model catalog', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn()
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      await expect(service.sendPrivate(db.listAgents()[0].id, '你好', [], {
        model: 'deepseek-made-up', permission: 'full',
      })).rejects.toThrow('DeepSeek 模型不可用')
      expect(run).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('replays private history when switching models restarts the runtime session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn()
      .mockResolvedValueOnce({ text: '旧回复', sessionId: 'old-session' })
      .mockResolvedValueOnce({ text: '新回复', sessionId: 'new-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agentId = db.listAgents()[0].id
      await service.sendPrivate(agentId, '旧问题')
      await service.sendPrivate(agentId, '新问题', [], { model: 'deepseek-v4-pro', permission: 'full' })
      expect(run.mock.calls[1][1]).toContain('旧问题')
      expect(run.mock.calls[1][1]).toContain('旧回复')
      expect(run.mock.calls[1][1]).toContain('新问题')
    } finally { db.close() }
  })

  it('keeps the newest result when DeepSeek balance refreshes finish out of order', async () => {
    const db = new MindMeshDatabase(':memory:')
    const providerSettings = {
      getProvider: vi.fn(() => ({ id: 'deepseek-official', apiKey: 'sk-test', name: 'DeepSeek' })),
      statuses: vi.fn(() => [{ id: 'deepseek-official', name: 'DeepSeek', description: '', configured: true, source: 'saved' }]),
    }
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve })))
    const response = (total: string) => ({ ok: true, json: async () => ({ is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0.00', topped_up_balance: total }] }) })
    const service = new MindMeshServices(db, {} as DeepSeekHarnessAdapter,
      providerSettings as unknown as ModelProviderSettings, () => undefined)
    try {
      const first = service.refreshModelProviders()
      const second = service.refreshModelProviders()
      resolveSecond(response('20.00'))
      await second
      resolveFirst(response('10.00'))
      await first
      expect(service.modelProviders()[0].balance?.items[0].total).toBe('20.00')
    } finally { db.close(); vi.unstubAllGlobals() }
  })

  it('sends image attachments only through a DeepSeek Flash route', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '看到了图片', sessionId: 'session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '分析图片', [image])
      expect(run.mock.calls[0][4]).toEqual([image])
      expect(db.listMessages('private', agent.id)[0].attachments).toEqual([image])

      db.updateAgent(agent.id, { ...agent, model: 'deepseek-v3.2' })
      await expect(service.sendPrivate(agent.id, '再看一张', [image]))
        .rejects.toThrow('仅 DeepSeek Flash 支持图片输入')
    } finally { db.close() }
  })

  it('starts a Flash-capable session when an older conversation used a text-only model', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const initial = db.listAgents()[0]
      const textOnly = db.updateAgent(initial.id, { ...initial, model: 'deepseek-v3.2' })
      await service.sendPrivate(initial.id, '先建立文字会话')
      db.updateAgent(initial.id, { ...textOnly, model: 'deepseek-v4-flash' })

      await service.sendPrivate(initial.id, '分析图片', [image])

      expect(run.mock.calls[1][0].model).toBe('deepseek-v4-flash')
      expect(run.mock.calls[1][2]).not.toBe('saved-session')
      expect(run.mock.calls[1][4]).toEqual([image])
    } finally { db.close() }
  })

  it('keeps an agent reasoning trace with its reply', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn(async (_agent, _prompt, _id, onText: (text: string, kind: 'text' | 'reasoning') => void) => {
      onText('第一步\n\n第二步', 'reasoning')
      onText('最终回答', 'text')
      return { text: '最终回答', reasoning: '第一步\n\n第二步', sessionId: 'session' }
    })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => ({ send }) as unknown as WebContents)
    try {
      const agent = db.listAgents()[0]
      const messages = await service.sendPrivate(agent.id, '问题')
      expect(messages.at(-1)).toMatchObject({ content: '最终回答', reasoning: '第一步\n\n第二步' })
      expect(db.listMessages('private', agent.id).at(-1)?.reasoning).toBe('第一步\n\n第二步')
      expect(send).toHaveBeenCalledWith('chat:delta', expect.objectContaining({ kind: 'reasoning', text: '第一步\n\n第二步' }))
    } finally { db.close() }
  })

  it('includes every unread space message after a long absence', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '已阅读', sessionId: 'session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      for (let index = 0; index < 31; index += 1) {
        db.addMessage({ scope: 'space', scopeId: space.id, authorType: 'user',
          authorName: '你', content: `未读消息 ${index}` })
      }
      await service.sendSpace(space.id, `@${agent.name} 请总结`)
      expect(run.mock.calls[0][1]).toContain('未读消息 0')
      expect(run.mock.calls[0][1]).toContain('未读消息 30')
    } finally { db.close() }
  })

  it('isolates one agent across two Spaces and its private conversation', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockImplementation(async () => ({ text: `回复 ${run.mock.calls.length}`, sessionId: `session-${run.mock.calls.length}` }))
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const first = db.listSpaces()[0]
      const agent = db.getAgent(first.memberIds[0])!
      const second = db.createSpace({ name: '独立空间', description: '', context: '只属于第二空间的背景', memberIds: [agent.id] })
      await service.sendSpace(first.id, `@${agent.name} 仅在空间一出现的标记甲`)
      await service.sendPrivate(agent.id, '仅在私聊出现的标记乙')
      await service.sendSpace(second.id, `@${agent.name} 仅在空间二出现的标记丙`)
      expect(run.mock.calls[0][1]).toContain('标记甲')
      expect(run.mock.calls[1][1]).toContain('标记乙')
      expect(run.mock.calls[1][1]).not.toContain('标记甲')
      expect(run.mock.calls[2][1]).toContain('标记丙')
      expect(run.mock.calls[2][1]).toContain('只属于第二空间的背景')
      expect(run.mock.calls[2][1]).not.toContain('标记甲')
      expect(run.mock.calls[2][1]).not.toContain('标记乙')
      expect(new Set(run.mock.calls.map((call) => call[2])).size).toBe(3)
    } finally {
      db.close()
    }
  })

  it('recovers a private conversation when the SDK rejects a persisted session after restart', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn()
      .mockResolvedValueOnce({ text: '旧回复', sessionId: 'old-session' })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '新回复', sessionId: 'new-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '旧问题')
      const messages = await service.sendPrivate(agent.id, '新问题')
      expect(messages.at(-1)?.content).toBe('新回复')
      expect(run.mock.calls[2][1]).toContain('旧问题')
      expect(run.mock.calls[2][1]).toContain('旧回复')
      expect(run.mock.calls[2][1]).toContain('新问题')
      expect(run.mock.calls[2][2]).not.toBe('old-session')
      expect(db.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'unused', getAgentCapabilityHash(agent)).harnessSessionId)
        .toBe('new-session')
    } finally {
      db.close()
    }
  })

  it('marks a stopped private reply as incomplete when runtime recovery replays history', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi.fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise((_resolve, reject) => { rejectRun = reject })
      })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '第二轮完成', sessionId: 'new-session' })
    const stop = vi.fn(async () => { rejectRun(new Error('runtime closed')); return true })
    const service = new MindMeshServices(db, { run, stop } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      const first = service.sendPrivate(agent.id, '第一问')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('被打断的半句话')
      await service.stop('private', agent.id)
      await first

      await service.sendPrivate(agent.id, '第二问')

      expect(run.mock.calls[2][1]).toContain(`${agent.name}（回复已停止，内容可能不完整）：被打断的半句话`)
    } finally { db.close() }
  })

  it('does not replay earlier replies when adopting a preexisting space conversation', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '新回复', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      db.addMessage({ scope: 'space', scopeId: space.id, authorType: 'user',
        authorName: '你', content: '历史问题' })
      db.addMessage({ scope: 'space', scopeId: space.id, authorType: 'agent',
        authorId: agent.id, authorName: agent.name, content: '历史回复' })
      await service.sendSpace(space.id, `@${agent.name} 新问题`)
      expect(run.mock.calls[0][1]).toContain('新问题')
      expect(run.mock.calls[0][1]).not.toContain('历史问题')
      expect(run.mock.calls[0][1]).not.toContain('历史回复')
    } finally {
      db.close()
    }
  })

  it('sends each space agent only messages it has not consumed', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      await service.sendSpace(space.id, `@${agent.name} 第一条`)
      await service.sendSpace(space.id, `@${agent.name} 第二条`)
      expect(run.mock.calls[0][1]).toContain('第一条')
      expect(run.mock.calls[1][1]).toContain('第二条')
      expect(run.mock.calls[1][1]).not.toContain('第一条')
      expect(run.mock.calls[1][1]).not.toContain('Researcher：完成')
    } finally {
      db.close()
    }
  })

  it('keeps the original agent configuration for an existing private session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '第一条')
      db.updateAgent(agent.id, { ...agent, persona: '修改后的身份' })
      await service.sendPrivate(agent.id, '第二条')
      expect(run.mock.calls[1][0].persona).toBe(agent.persona)
      expect(run.mock.calls[1][2]).toBe('saved-session')
    } finally {
      db.close()
    }
  })

  it('uses a renamed agent identity without restarting its private session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '第一条')
      db.updateAgent(agent.id, { ...agent, name: '首席研究员', role: '研究负责人' })

      const messages = await service.sendPrivate(agent.id, '第二条')

      expect(run.mock.calls[1][0]).toMatchObject({ name: '首席研究员', role: '研究负责人', persona: agent.persona })
      expect(run.mock.calls[1][1]).toContain('你是 首席研究员。')
      expect(run.mock.calls[1][1]).toContain('角色定位：研究负责人')
      expect(run.mock.calls[1][2]).toBe('saved-session')
      expect(messages.at(-1)?.authorName).toBe('首席研究员')
    } finally {
      db.close()
    }
  })

  it('uses a renamed agent identity without restarting its space session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => undefined)
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      await service.sendSpace(space.id, `@${agent.name} 第一条`)
      db.updateAgent(agent.id, { ...agent, name: '首席研究员', role: '研究负责人' })

      const messages = await service.sendSpace(space.id, '@首席研究员 第二条')

      expect(run.mock.calls[1][0]).toMatchObject({ name: '首席研究员', role: '研究负责人', persona: agent.persona })
      expect(run.mock.calls[1][1]).toContain('你是 首席研究员。')
      expect(run.mock.calls[1][1]).toContain('角色定位：研究负责人')
      expect(run.mock.calls[1][2]).toBe('saved-session')
      expect(messages.at(-1)?.authorName).toBe('首席研究员')
    } finally {
      db.close()
    }
  })

  it('forwards model text before the run completes', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn(async (_agent, _prompt, _id, onText: (text: string) => void) => {
      onText('逐步')
      expect(send).toHaveBeenCalledWith('chat:delta', expect.objectContaining({ text: '逐步' }))
      return { text: '逐步完成', sessionId: 'saved-session' }
    })
    const service = new MindMeshServices(db, { run } as unknown as DeepSeekHarnessAdapter,
      {} as ModelProviderSettings, () => ({ send }) as unknown as WebContents)
    try {
      await service.sendPrivate(db.listAgents()[0].id, '你好')
      expect(send.mock.calls.filter(([channel]) => channel === 'chat:delta')).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})
