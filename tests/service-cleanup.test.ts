import { getAgentCapabilityHash } from '../src/main/agent-capability'
import { mockHarness, mockProviderSettings } from './service-mocks'
import { describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import {
  SessionResumeUnsupportedError,
  type DeepSeekHarnessAdapter,
} from '../src/main/harness-adapter'
import { MindMeshServices } from '../src/main/services'

function setup() {
  const db = new MindMeshDatabase(':memory:')
  const harness = mockHarness({
    shutdownAll: vi.fn(async () => undefined),
    forgetAgent: vi.fn(async () => undefined),
    forgetConversations: vi.fn(async () => undefined),
    invalidateWorkspace: vi.fn(async () => undefined),
    cleanupUnusedHomes: vi.fn(),
    setWorkspace: vi.fn(),
    status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
  })
  const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
  return { db, harness, service }
}

describe('orphan Harness home cleanup', () => {
  it('cleans after removing an Agent and its runtime sessions', async () => {
    const { db, harness, service } = setup()
    try {
      const agent = db.listAgents()[0]
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`private:${agent.id}`, agent.id),
        agent,
        'session',
        getAgentCapabilityHash(agent)
      )
      await service.removeAgent(agent.id)
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.shutdownAll).not.toHaveBeenCalled()
      expect(harness.forgetAgent).toHaveBeenCalledWith(agent.id)
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally {
      db.close()
    }
  })

  it('cleans after removing a Space', async () => {
    const { db, harness, service } = setup()
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`space:${space.id}`, agent.id),
        agent,
        'session',
        getAgentCapabilityHash(agent)
      )
      await service.removeSpace(space.id)
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.shutdownAll).not.toHaveBeenCalled()
      expect(harness.forgetConversations).toHaveBeenCalledWith([`space:${space.id}`])
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally {
      db.close()
    }
  })

  it('cleans after changing the workspace', async () => {
    const { db, harness, service } = setup()
    try {
      const agent = db.listAgents()[0]
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`private:${agent.id}`, agent.id),
        agent,
        'session',
        getAgentCapabilityHash(agent)
      )
      await service.changeWorkspace('C:\\next-workspace')
      expect(db.getWorkspacePath()).toBe('C:\\next-workspace')
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.setWorkspace).toHaveBeenCalledWith('C:\\next-workspace')
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally {
      db.close()
    }
  })

  it('blocks new sends and waits for an active Space turn before shutdown completes', async () => {
    const db = new MindMeshDatabase(':memory:')
    let finishRun!: (value: { text: string; sessionId: string }) => void
    const run = vi.fn(
      () =>
        new Promise<{ text: string; sessionId: string }>((resolve) => {
          finishRun = resolve
        })
    )
    const harness = mockHarness({
      run,
      shutdownAll: vi.fn(async () => undefined),
      status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
    })
    const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
    try {
      const space = db.listSpaces()[0]
      const members = space.memberIds.map((id) => db.getAgent(id)!)
      const sending = service.sendSpace(
        space.id,
        members.map((agent) => `@${agent.name}`).join(' ')
      )
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())

      const shutdown = service.shutdown()
      await expect(service.sendPrivate(members[0].id, '退出期间的新消息')).rejects.toThrow(
        '正在退出'
      )
      finishRun({ text: '完成', sessionId: 'session' })
      await Promise.all([sending, shutdown])

      expect(harness.shutdownAll).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledOnce()
    } finally {
      db.close()
    }
  })

  it('finishes shutdown after the grace period when an active run never settles', async () => {
    vi.useFakeTimers()
    const db = new MindMeshDatabase(':memory:')
    const harness = mockHarness({
      run: vi.fn(
        () => new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>(() => undefined)
      ),
      shutdownAll: vi.fn(async () => undefined),
      status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
    })
    const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
    try {
      void service.sendPrivate(db.listAgents()[0].id, '不会结束的请求')
      const shutdown = service.shutdown()
      expect(service.shutdown()).toBe(shutdown)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(shutdown).resolves.toBeUndefined()
      expect(harness.shutdownAll).toHaveBeenCalledOnce()
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })

  it('does not start session recovery while shutdown is closing the Harness', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    const run = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>>((_resolve, reject) => {
          rejectRun = reject
        })
    )
    const harness = mockHarness({
      run,
      shutdownAll: vi.fn(async () => {
        rejectRun(new SessionResumeUnsupportedError())
      }),
      status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
    })
    const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
    try {
      const sending = service.sendPrivate(db.listAgents()[0].id, '退出时不要恢复会话')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await Promise.all([sending, service.shutdown()])

      expect(run).toHaveBeenCalledOnce()
      expect(harness.shutdownAll).toHaveBeenCalledOnce()
    } finally {
      db.close()
    }
  })
})
