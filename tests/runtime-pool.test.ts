import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/contracts'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import { MindMeshDatabase } from '../src/main/database'

const state = vi.hoisted(() => ({
  launched: [] as string[],
  closed: [] as string[],
  release: undefined as undefined | (() => void),
}))

vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    private home: string
    constructor(options: { dshHome: string }) { this.home = options.dshHome; state.launched.push(this.home) }
    async run(prompt: string) {
      if (prompt === 'hold') await new Promise<void>((resolveRun) => { state.release = resolveRun })
      if (prompt === 'fail') throw new Error('run failed')
      return { finalResponse: '完成', sessionId: 'session' }
    }
    async close() { state.closed.push(this.home) }
  },
  JsonRpcResponseError: class extends Error {},
}))

import { DeepSeekHarnessAdapter, getAgentCapabilityHash } from '../src/main/harness-adapter'

const settings = {
  getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }),
  configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }],
} as unknown as ModelProviderSettings
const agent = (persona: string): Agent => ({
  id: persona, name: persona, role: '', persona, provider: 'deepseek-official',
  model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
})

beforeEach(() => { state.launched.length = 0; state.closed.length = 0; state.release = undefined })
afterEach(() => { state.release?.() })

describe('Harness runtime pool', () => {
  it('keeps three recent idle runtimes and closes the least recently used', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      for (const name of ['a', 'b', 'c', 'd']) await adapter.run(agent(name), name)
      expect(state.closed).toEqual([state.launched[0]])
      expect(existsSync(state.launched[0])).toBe(true)
      await adapter.run(agent('b'), 'again')
      await adapter.run(agent('e'), 'new')
      expect(state.closed).toEqual([state.launched[0], state.launched[2]])
    } finally {
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not close an active runtime and releases it after a failed run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      const held = adapter.run(agent('a'), 'hold')
      for (const name of ['b', 'c', 'd']) await adapter.run(agent(name), name)
      expect(state.closed).toContain(state.launched[1])
      expect(state.closed).not.toContain(state.launched[0])
      state.release?.()
      await held
      await expect(adapter.run(agent('a'), 'fail')).rejects.toThrow('run failed')
      await adapter.run(agent('e'), 'new')
      expect(state.closed).toContain(state.launched[2])
    } finally {
      state.release?.()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('deletes only unreferenced app-owned homes after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      await adapter.run(agent('kept'), 'first')
      await adapter.run(agent('orphan'), 'second')
      await adapter.shutdownAll()
      const [keptHome, orphanHome] = state.launched
      db.getOrCreateRuntimeSession('private:kept', agent('kept'), 'session', getAgentCapabilityHash(agent('kept')))
      mkdirSync(join(directory, 'harness', 'manual'), { recursive: true })
      mkdirSync(join(directory, 'harness', 'aaaaaaaaaaaa'), { recursive: true })

      adapter.cleanupUnusedHomes(db.referencedCapabilityHashes())

      expect(existsSync(keptHome)).toBe(true)
      expect(existsSync(orphanHome)).toBe(false)
      expect(readdirSync(join(directory, 'harness'))).toContain('manual')
      expect(readdirSync(join(directory, 'harness'))).toContain('aaaaaaaaaaaa')
    } finally {
      await adapter.shutdownAll()
      db.close()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })
})
