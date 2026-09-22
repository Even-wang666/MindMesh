import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import { SessionResumeUnsupportedError, type DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'

describe('chat failures', () => {
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
      expect(db.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'unused', 'hash').harnessSessionId)
        .toBe('new-session')
    } finally {
      db.close()
    }
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
