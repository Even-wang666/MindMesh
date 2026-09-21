import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import type { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
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
    } finally {
      db.close()
    }
  })
})
