import { getAgentCapabilityHash } from '../src/main/agent-capability'
import { mockHarness, mockProviderSettings } from './service-mocks'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import {
  SessionResumeUnsupportedError,
  type DeepSeekHarnessAdapter,
} from '../src/main/harness-adapter'
import type { ChatImageAttachment, RuntimeEvent } from '../src/shared/contracts'

const image: ChatImageAttachment = {
  type: 'image',
  name: 'chart.png',
  mediaType: 'image/png',
  bytes: 68,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nCEAAAAASUVORK5CYII=',
}

describe('chat failures', () => {
  it('stops an active private reply without persisting a failure or later deltas', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi.fn(
      (_agent, _prompt, _id, onText: (text: string) => void) =>
        new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>((_resolve, reject) => {
          rejectRun = reject
          emitText = onText
        })
    )
    const stop = vi.fn(async () => {
      rejectRun(new Error('runtime closed'))
      return true
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('已经输出')

      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      emitText('不应继续输出')
      const messages = await pending

      expect(stop).toHaveBeenCalledWith({ ...agent, tools: [] }, expect.any(String))
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'agent'])
      expect(messages.at(-1)).toMatchObject({ content: '已经输出', stopped: true })
    } finally {
      db.close()
    }
  })

  it('marks a stopped space reply and does not replay it as complete after runtime recovery', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi
      .fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>(
          (_resolve, reject) => {
            rejectRun = reject
          }
        )
      })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '第二轮完成', sessionId: 'second-session' })
    const stop = vi.fn(async () => {
      rejectRun(new Error('runtime closed'))
      return true
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => undefined
    )
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
      expect(run.mock.calls[2][1]).toContain(
        `${agent.name}（回复已停止，内容可能不完整）：被打断的半句话`
      )
    } finally {
      db.close()
    }
  })

  it('shows another space agent that a stopped reply is incomplete', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi
      .fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>(
          (_resolve, reject) => {
            rejectRun = reject
          }
        )
      })
      .mockResolvedValueOnce({ text: '已知悉', sessionId: 'other-session' })
    const stop = vi.fn(async () => {
      rejectRun(new Error('runtime closed'))
      return true
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => undefined
    )
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

      expect(run.mock.calls[1][1]).toContain(
        `${firstAgent.name}（回复已停止，内容可能不完整）：被打断的半句话`
      )
    } finally {
      db.close()
    }
  })

  it('reports that stopping failed when the runtime is not exclusively owned', async () => {
    const db = new MindMeshDatabase(':memory:')
    let resolveRun!: (result: { text: string; sessionId: string }) => void
    const run = vi.fn(
      () =>
        new Promise<{ text: string; sessionId: string }>((resolve) => {
          resolveRun = resolve
        })
    )
    const stop = vi.fn(async () => false)
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await expect(service.stop('private', agent.id)).resolves.toBe(false)
      resolveRun({ text: '正常完成', sessionId: 'session' })
      expect((await pending).at(-1)?.content).toBe('正常完成')
    } finally {
      db.close()
    }
  })

  it('latches a successful stop until the active run settles', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    const run = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>((_resolve, reject) => {
          rejectRun = reject
        })
    )
    const stop = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      const pending = service.sendPrivate(agent.id, '请分析')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      await expect(service.stop('private', agent.id)).resolves.toBe(true)
      expect(stop).toHaveBeenCalledOnce()
      rejectRun(new Error('runtime closed'))
      await pending
    } finally {
      db.close()
    }
  })

  it('shows a runtime error after failure and clears it after a successful reply', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ text: '恢复', sessionId: 'session' })
    const harness = {
      run,
      status: () => ({ state: 'ready' as const, label: '准备就绪', detail: '已配置' }),
    }
    const service = new MindMeshServices(
      db,
      mockHarness(harness),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '第一次')
      expect(service.runtimeStatus().state).toBe('error')
      await service.sendPrivate(agent.id, '第二次')
      expect(service.runtimeStatus().state).toBe('ready')
    } finally {
      db.close()
    }
  })

  it('persists a private model failure as a visible system message', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn().mockRejectedValue(new Error('secret token detail'))
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      const agent = db.listAgents()[0]
      const messages = await service.sendPrivate(agent.id, '你好')
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'system'])
      expect(messages[1].content).toContain('回复失败')
      expect(messages[1].content).not.toContain('secret token')
      expect(db.listMessages(db.conversationIdFor('private', agent.id))).toEqual(messages)
      expect(send).toHaveBeenCalledWith('chat:progress', {
        scope: 'private',
        scopeId: agent.id,
        agentName: agent.name,
      })
    } finally {
      db.close()
    }
  })

  it('continues a space discussion after one agent fails', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ text: '第二位的回复' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      const space = db.listSpaces()[0]
      const agents = space.memberIds.map((id) => db.getAgent(id)!)
      const messages = await service.sendSpace(
        space.id,
        `@${agents[0].name} @${agents[1].name} 请讨论`
      )
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
      getProvider: vi.fn(() => ({
        id: 'deepseek-official' as const,
        apiKey: 'sk-test',
        name: 'DeepSeek',
      })),
      statuses: vi.fn(() => []),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-future' }],
        }),
      }))
    )
    const service = new MindMeshServices(
      db,
      mockHarness(),
      mockProviderSettings(providerSettings),
      () => undefined
    )
    try {
      expect(
        (await service.models()).filter((item) => item.provider === 'deepseek-official')
      ).toEqual([
        {
          provider: 'deepseek-official',
          id: 'deepseek-flash',
          name: 'DeepSeek V4.1 Flash',
          contextWindow: 1_000_000,
        },
        {
          provider: 'deepseek-official',
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          contextWindow: 1_000_000,
        },
        { provider: 'deepseek-official', id: 'deepseek-future', name: 'deepseek-future' },
      ])
    } finally {
      db.close()
      vi.unstubAllGlobals()
    }
  })

  it('refreshes the DeepSeek balance after a completed answer', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'session' })
    const providerSettings = {
      getProvider: vi.fn(() => ({
        id: 'deepseek-official' as const,
        apiKey: 'sk-test',
        name: 'DeepSeek',
      })),
      statuses: vi.fn(() => [
        {
          id: 'deepseek-official' as const,
          name: 'DeepSeek',
          description: 'DeepSeek 官方 API',
          configured: true,
          source: 'saved' as const,
        },
      ]),
    }
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '88.50',
            granted_balance: '8.50',
            topped_up_balance: '80.00',
          },
        ],
      }),
    }))
    vi.stubGlobal('fetch', request)
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(providerSettings),
      () => undefined
    )
    try {
      await service.sendPrivate(db.listAgents()[0].id, '你好')
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          'https://api.deepseek.com/user/balance',
          expect.anything()
        )
      )
      expect(service.modelProviders()[0].balance?.items[0]).toMatchObject({
        currency: 'CNY',
        total: '88.50',
      })
    } finally {
      db.close()
      vi.unstubAllGlobals()
    }
  })

  it('routes a turn through the selected model and permission ceiling', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'selected-session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const initial = db.listAgents()[0]
      db.updateAgent(initial.id, { ...initial, tools: ['网页搜索', '文件', 'Shell'] })
      await service.sendPrivate(initial.id, '限制权限', [], {
        model: 'deepseek-v4-pro',
        permission: 'workspace',
      })

      expect(run.mock.calls[0][0]).toMatchObject({
        model: 'deepseek-v4-pro',
        tools: ['网页搜索', '文件'],
      })
      await service.sendPrivate(initial.id, '恢复权限', [], {
        model: 'deepseek-v4-pro',
        permission: 'full',
      })
      expect(run.mock.calls[1][0].tools).toEqual(['网页搜索', '文件', 'Shell'])
    } finally {
      db.close()
    }
  })

  it('defaults every turn to chat permission without replacing an existing persona snapshot', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const initial = db.listAgents()[0]
      const enabled = db.updateAgent(initial.id, { ...initial, tools: ['文件', 'Shell'] })
      await service.sendPrivate(initial.id, '完全权限', [], { permission: 'full' })
      db.updateAgent(initial.id, { ...enabled, persona: '不应进入既有会话的新身份' })
      await service.sendPrivate(initial.id, '默认权限')
      await service.sendPrivate(initial.id, '空选项', [], {})
      await service.sendPrivate(initial.id, '只切模型', [], { model: 'deepseek-v4-pro' })

      expect(run.mock.calls[0][0].tools).toEqual(['文件', 'Shell'])
      expect(run.mock.calls[1][0]).toMatchObject({ persona: initial.persona, tools: [] })
      expect(run.mock.calls[2][0]).toMatchObject({ persona: initial.persona, tools: [] })
      expect(run.mock.calls[3][0]).toMatchObject({
        persona: initial.persona,
        model: 'deepseek-v4-pro',
        tools: [],
      })
    } finally {
      db.close()
    }
  })

  it('removes Shell from an existing Space session when the next turn omits options', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const space = db.listSpaces()[0]
      const initial = db.getAgent(space.memberIds[0])!
      db.updateAgent(initial.id, { ...initial, tools: ['文件', 'Shell'] })
      await service.sendSpace(space.id, `@${initial.name} 完全权限`, [], { permission: 'full' })
      await service.sendSpace(space.id, `@${initial.name} 默认权限`)

      expect(run.mock.calls[0][0].tools).toEqual(['文件', 'Shell'])
      expect(run.mock.calls[1][0].tools).toEqual([])
    } finally {
      db.close()
    }
  })

  it.each([
    ['chat', []],
    ['workspace', ['网页搜索', '文件']],
    ['full', ['网页搜索', '文件', 'Shell']],
  ] as const)(
    'applies the %s permission ceiling to every mentioned Space member',
    async (permission, tools) => {
      const db = new MindMeshDatabase(':memory:')
      const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'session' })
      const service = new MindMeshServices(
        db,
        mockHarness({ run }),
        mockProviderSettings(),
        () => undefined
      )
      try {
        const space = db.listSpaces()[0]
        const members = space.memberIds.map((id) => db.getAgent(id)!)
        for (const member of members)
          db.updateAgent(member.id, { ...member, tools: ['网页搜索', '文件', 'Shell'] })
        await service.sendSpace(
          space.id,
          members.map((member) => `@${member.name}`).join(' '),
          [],
          { permission }
        )
        expect(run).toHaveBeenCalledTimes(members.length)
        expect(run.mock.calls.map(([member]) => member.tools)).toEqual(
          members.map(() => [...tools])
        )
      } finally {
        db.close()
      }
    }
  )

  it('applies a reasoning effort change to an existing session on the next turn', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi
      .fn()
      .mockImplementation((_agent, _prompt, sessionId) =>
        Promise.resolve({ text: '完成', sessionId })
      )
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const initial = db.listAgents()[0]
      await service.sendPrivate(initial.id, '第一问')
      const firstSessionId = run.mock.calls[0][2]
      expect(run.mock.calls[0][0].reasoningEffort).toBeUndefined()

      // 模拟空间抽屉保存思考强度：走同一条 agents.update → db.updateAgent 链路
      const withEffort = db.updateAgent(initial.id, { ...initial, reasoningEffort: 'low' })
      await service.sendPrivate(initial.id, '第二问')
      expect(run.mock.calls[1][0]).toMatchObject({
        reasoningEffort: 'low',
        persona: initial.persona,
      })
      expect(run.mock.calls[1][2]).not.toBe(firstSessionId)

      // 档位不变时不应重建会话
      await service.sendPrivate(initial.id, '第三问')
      expect(run.mock.calls[2][2]).toBe(run.mock.calls[1][2])

      // 清除档位（跟随默认）同样触发重建
      db.updateAgent(initial.id, { ...withEffort, reasoningEffort: undefined })
      await service.sendPrivate(initial.id, '第四问')
      expect(run.mock.calls[3][0].reasoningEffort).toBeUndefined()
      expect(run.mock.calls[3][2]).not.toBe(run.mock.calls[2][2])
    } finally {
      db.close()
    }
  })

  it('applies a reasoning effort change to an existing Space member session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi
      .fn()
      .mockImplementation((_agent, _prompt, sessionId) =>
        Promise.resolve({ text: '完成', sessionId })
      )
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const space = db.listSpaces()[0]
      const initial = db.getAgent(space.memberIds[0])!
      await service.sendSpace(space.id, `@${initial.name} 第一问`)
      const firstSessionId = run.mock.calls[0][2]

      db.updateAgent(initial.id, { ...initial, reasoningEffort: 'max' })
      await service.sendSpace(space.id, `@${initial.name} 第二问`)
      expect(run.mock.calls[1][0]).toMatchObject({
        reasoningEffort: 'max',
        persona: initial.persona,
      })
      expect(run.mock.calls[1][2]).not.toBe(firstSessionId)
    } finally {
      db.close()
    }
  })

  it('rejects oversized user messages before creating sessions or running an Agent', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn()
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      const space = db.listSpaces()[0]
      const oversized = '你'.repeat(21_846)

      await expect(service.sendPrivate(agent.id, oversized)).rejects.toThrow('64 KiB')
      await expect(service.sendSpace(space.id, oversized)).rejects.toThrow('64 KiB')
      expect(run).not.toHaveBeenCalled()
      expect(db.listMessages(db.conversationIdFor('private', agent.id))).toEqual([])
      expect(db.listMessages(db.conversationIdFor('space', space.id))).toEqual([])
      expect(db.referencedCapabilityHashes()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects a model override that was not returned by the DeepSeek model catalog', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn()
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      await expect(
        service.sendPrivate(db.listAgents()[0].id, '你好', [], {
          model: 'deepseek-made-up',
          permission: 'full',
        })
      ).rejects.toThrow('DeepSeek 模型不可用')
      expect(run).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('replays private history when switching models restarts the runtime session', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi
      .fn()
      .mockResolvedValueOnce({ text: '旧回复', sessionId: 'old-session' })
      .mockResolvedValueOnce({ text: '新回复', sessionId: 'new-session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agentId = db.listAgents()[0].id
      await service.sendPrivate(agentId, '旧问题')
      await service.sendPrivate(agentId, '新问题', [], {
        model: 'deepseek-v4-pro',
        permission: 'full',
      })
      expect(run.mock.calls[1][1]).toContain('旧问题')
      expect(run.mock.calls[1][1]).toContain('旧回复')
      expect(run.mock.calls[1][1]).toContain('新问题')
    } finally {
      db.close()
    }
  })

  it('keeps the newest result when DeepSeek balance refreshes finish out of order', async () => {
    const db = new MindMeshDatabase(':memory:')
    const providerSettings = {
      getProvider: vi.fn(() => ({
        id: 'deepseek-official' as const,
        apiKey: 'sk-test',
        name: 'DeepSeek',
      })),
      statuses: vi.fn(() => [
        {
          id: 'deepseek-official' as const,
          name: 'DeepSeek',
          description: '',
          configured: true,
          source: 'saved' as const,
        },
      ]),
    }
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve
          })
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveSecond = resolve
          })
        )
    )
    const response = (total: string) => ({
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: total,
            granted_balance: '0.00',
            topped_up_balance: total,
          },
        ],
      }),
    })
    const service = new MindMeshServices(
      db,
      mockHarness(),
      mockProviderSettings(providerSettings),
      () => undefined
    )
    try {
      const first = service.refreshModelProviders()
      const second = service.refreshModelProviders()
      resolveSecond(response('20.00'))
      await second
      resolveFirst(response('10.00'))
      await first
      expect(service.modelProviders()[0].balance?.items[0].total).toBe('20.00')
    } finally {
      db.close()
      vi.unstubAllGlobals()
    }
  })

  it('sends image attachments only through a DeepSeek Flash route', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '看到了图片', sessionId: 'session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '分析图片', [image])
      expect(run.mock.calls[0][4]).toEqual([image])
      expect(db.listMessages(db.conversationIdFor('private', agent.id))[0].attachments).toEqual([image])

      db.updateAgent(agent.id, { ...agent, model: 'deepseek-v3.2' })
      await expect(service.sendPrivate(agent.id, '再看一张', [image])).rejects.toThrow(
        '仅 DeepSeek Flash 支持图片输入'
      )
    } finally {
      db.close()
    }
  })

  it.each(['private', 'space'] as const)(
    'starts a Flash-capable %s session when an older conversation used a text-only model',
    async (scope) => {
      const db = new MindMeshDatabase(':memory:')
      const run = vi.fn().mockResolvedValue({ text: '完成', sessionId: 'saved-session' })
      const service = new MindMeshServices(
        db,
        mockHarness({ run }),
        mockProviderSettings(),
        () => undefined
      )
      try {
        const space = db.listSpaces()[0]
        const initial = db.getAgent(space.memberIds[0])!
        const send = (content: string, attachments: ChatImageAttachment[] = []) =>
          scope === 'private'
            ? service.sendPrivate(initial.id, content, attachments)
            : service.sendSpace(space.id, `@${initial.name} ${content}`, attachments)
        const textOnly = db.updateAgent(initial.id, { ...initial, model: 'deepseek-v3.2' })
        await send('先建立文字会话')
        db.updateAgent(initial.id, { ...textOnly, model: 'deepseek-v4-flash' })

        await send('分析图片', [image])

        expect(run.mock.calls[1][0].model).toBe('deepseek-v4-flash')
        expect(run.mock.calls[1][2]).not.toBe('saved-session')
        expect(run.mock.calls[1][4]).toEqual([image])
      } finally {
        db.close()
      }
    }
  )

  it('keeps an agent reasoning trace with its reply', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn(
      async (_agent, _prompt, _id, onText: (text: string, kind: 'text' | 'reasoning') => void) => {
        onText('第一步\n\n第二步', 'reasoning')
        onText('最终回答', 'text')
        return { text: '最终回答', reasoning: '第一步\n\n第二步', sessionId: 'session' }
      }
    )
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      const agent = db.listAgents()[0]
      const messages = await service.sendPrivate(agent.id, '问题')
      expect(messages.at(-1)).toMatchObject({ content: '最终回答', reasoning: '第一步\n\n第二步' })
      expect(db.listMessages(db.conversationIdFor('private', agent.id)).at(-1)?.reasoning).toBe('第一步\n\n第二步')
    } finally {
      db.close()
    }
  })

  it('includes every unread space message after a long absence', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '已阅读', sessionId: 'session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      for (let index = 0; index < 31; index += 1) {
        db.addMessage({
          scope: 'space',
          scopeId: space.id,
          authorType: 'user',
          authorName: '你',
          content: `未读消息 ${index}`,
        })
      }
      await service.sendSpace(space.id, `@${agent.name} 请总结`)
      expect(run.mock.calls[0][1]).toContain('未读消息 0')
      expect(run.mock.calls[0][1]).toContain('未读消息 30')
    } finally {
      db.close()
    }
  })

  it('isolates one agent across two Spaces and its private conversation', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockImplementation(async () => ({
      text: `回复 ${run.mock.calls.length}`,
      sessionId: `session-${run.mock.calls.length}`,
    }))
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const first = db.listSpaces()[0]
      const agent = db.getAgent(first.memberIds[0])!
      const second = db.createSpace({
        name: '独立空间',
        description: '',
        context: '只属于第二空间的背景',
        memberIds: [agent.id],
      })
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
    const run = vi
      .fn()
      .mockResolvedValueOnce({ text: '旧回复', sessionId: 'old-session' })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '新回复', sessionId: 'new-session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '旧问题')
      const messages = await service.sendPrivate(agent.id, '新问题')
      expect(messages.at(-1)?.content).toBe('新回复')
      expect(run.mock.calls[2][1]).toContain('旧问题')
      expect(run.mock.calls[2][1]).toContain('旧回复')
      expect(run.mock.calls[2][1]).toContain('新问题')
      expect(run.mock.calls[2][2]).not.toBe('old-session')
      expect(
        db.getOrCreateRuntimeSession(
          runtimeContextKey(`private:${agent.id}`, agent.id),
          agent,
          'unused',
          getAgentCapabilityHash(agent)
        ).harnessSessionId
      ).toBe('new-session')
    } finally {
      db.close()
    }
  })

  it('marks a stopped private reply as incomplete when runtime recovery replays history', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    let emitText!: (text: string) => void
    const run = vi
      .fn()
      .mockImplementationOnce((_agent, _prompt, _id, onText: (text: string) => void) => {
        emitText = onText
        return new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>(
          (_resolve, reject) => {
            rejectRun = reject
          }
        )
      })
      .mockRejectedValueOnce(new SessionResumeUnsupportedError())
      .mockResolvedValueOnce({ text: '第二轮完成', sessionId: 'new-session' })
    const stop = vi.fn(async () => {
      rejectRun(new Error('runtime closed'))
      return true
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run, stop }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      const first = service.sendPrivate(agent.id, '第一问')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      emitText('被打断的半句话')
      await service.stop('private', agent.id)
      await first

      await service.sendPrivate(agent.id, '第二问')

      expect(run.mock.calls[2][1]).toContain(
        `${agent.name}（回复已停止，内容可能不完整）：被打断的半句话`
      )
    } finally {
      db.close()
    }
  })

  it('does not replay earlier replies when adopting a preexisting space conversation', async () => {
    const db = new MindMeshDatabase(':memory:')
    const run = vi.fn().mockResolvedValue({ text: '新回复', sessionId: 'saved-session' })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: '你',
        content: '历史问题',
      })
      db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'agent',
        authorId: agent.id,
        authorName: agent.name,
        content: '历史回复',
      })
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
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
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
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
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
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, '第一条')
      db.updateAgent(agent.id, { ...agent, name: '首席研究员', role: '研究负责人' })

      const messages = await service.sendPrivate(agent.id, '第二条')

      expect(run.mock.calls[1][0]).toMatchObject({
        name: '首席研究员',
        role: '研究负责人',
        persona: agent.persona,
      })
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
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      await service.sendSpace(space.id, `@${agent.name} 第一条`)
      db.updateAgent(agent.id, { ...agent, name: '首席研究员', role: '研究负责人' })

      const messages = await service.sendSpace(space.id, '@首席研究员 第二条')

      expect(run.mock.calls[1][0]).toMatchObject({
        name: '首席研究员',
        role: '研究负责人',
        persona: agent.persona,
      })
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
    const agent = db.listAgents()[0]
    const run = vi.fn(
      async (
        _agent,
        _prompt,
        _id,
        onText: (text: string) => void,
        _attachments,
        _request,
        _fresh,
        _runOptions,
        onRuntimeEvent?: (event: RuntimeEvent) => void
      ) => {
        onText('逐步')
        onRuntimeEvent?.({
          type: 'text:delta',
          requestId: 'r1',
          sessionId: 's',
          seq: 1,
          conversationId: `private:${agent.id}`,
          agentId: agent.id,
          executionId: 'e1',
          triggerMessageId: 'm1',
          time: 0,
          text: '逐步',
        })
        return { text: '逐步完成', sessionId: 'saved-session' }
      }
    )
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      await service.sendPrivate(agent.id, '你好')
      // The streamed text reached the renderer as a text:delta on the runtime
      // event channel, batched together with the lifecycle events.
      const runtimeEvents = send.mock.calls
        .filter(([channel]) => channel === 'chat:runtimeEvent')
        .flatMap(([, batch]) => batch as RuntimeEvent[])
      expect(runtimeEvents.map((event) => event.type)).toEqual([
        'run:start',
        'text:delta',
        'run:end',
      ])
    } finally {
      db.close()
    }
  })

  it('routes a native turn/end:error into the failure path instead of a success reply', async () => {
    const db = new MindMeshDatabase(':memory:')
    const send = vi.fn()
    const run = vi.fn(async () => ({
      text: '部分回答',
      sessionId: 'saved-session',
      endReason: 'error' as const,
      endError: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
    }))
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => ({ send }) as unknown as WebContents
    )
    try {
      const messages = await service.sendPrivate(db.listAgents()[0].id, '你好')
      // No assistant reply is persisted; a system failure notice takes its place.
      expect(messages.map((message) => message.authorType)).toEqual(['user', 'system'])
      expect(messages.at(-1)).toMatchObject({ authorType: 'system' })
      expect(messages.at(-1)?.content).toContain('回复失败')
      // The renderer receives an error event followed by a run:end(error).
      const runtimeEvents = send.mock.calls
        .filter(([channel]) => channel === 'chat:runtimeEvent')
        .flatMap(([, batch]) => batch as RuntimeEvent[])
      expect(runtimeEvents.map((event) => event.type)).toEqual(['run:start', 'error', 'run:end'])
      expect(runtimeEvents.find((event) => event.type === 'run:end')).toMatchObject({
        reason: 'error',
      })
    } finally {
      db.close()
    }
  })
})
