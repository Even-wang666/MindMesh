import { describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { getAgentCapabilityHash, type DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import { MindMeshServices } from '../src/main/services'

function setup() {
  const db = new MindMeshDatabase(':memory:')
  const harness = {
    shutdownAll: vi.fn(async () => undefined),
    cleanupUnusedHomes: vi.fn(),
    setWorkspace: vi.fn(),
    status: vi.fn(() => ({ state: 'ready', label: '', detail: '' })),
  } as unknown as DeepSeekHarnessAdapter
  const service = new MindMeshServices(db, harness, {} as ModelProviderSettings, () => undefined)
  return { db, harness, service }
}

describe('orphan Harness home cleanup', () => {
  it('cleans after removing an Agent and its runtime sessions', async () => {
    const { db, harness, service } = setup()
    try {
      const agent = db.listAgents()[0]
      db.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'session', getAgentCapabilityHash(agent))
      await service.removeAgent(agent.id)
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.shutdownAll).toHaveBeenCalledOnce()
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally { db.close() }
  })

  it('cleans after removing a Space', async () => {
    const { db, harness, service } = setup()
    try {
      const space = db.listSpaces()[0]
      const agent = db.getAgent(space.memberIds[0])!
      db.getOrCreateRuntimeSession(`space:${space.id}:${agent.id}`, agent, 'session', getAgentCapabilityHash(agent))
      await service.removeSpace(space.id)
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.shutdownAll).toHaveBeenCalledOnce()
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally { db.close() }
  })

  it('cleans after changing the workspace', async () => {
    const { db, harness, service } = setup()
    try {
      const agent = db.listAgents()[0]
      db.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'session', getAgentCapabilityHash(agent))
      await service.changeWorkspace('C:\\next-workspace')
      expect(db.getWorkspacePath()).toBe('C:\\next-workspace')
      expect(db.referencedCapabilityHashes()).toEqual([])
      expect(harness.setWorkspace).toHaveBeenCalledWith('C:\\next-workspace')
      expect(harness.cleanupUnusedHomes).toHaveBeenCalledWith([])
    } finally { db.close() }
  })
})
