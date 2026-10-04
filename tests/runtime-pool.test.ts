import { getAgentCapabilityHash } from '../src/main/agent-capability'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
    async start() {}
    async run(prompt: string) {
      if (prompt === 'hold') await new Promise<void>((resolveRun) => { state.release = resolveRun })
      if (prompt === 'fail') throw new Error('run failed')
      return { finalResponse: '完成', sessionId: 'session' }
    }
    async close() { state.closed.push(this.home) }
  },
  JsonRpcResponseError: class extends Error {},
}))

import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import { getAgentCapabilityBaseHash } from '../src/main/agent-capability'

const settings = {
  getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }),
  configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }],
} satisfies Pick<ModelProviderSettings, 'getProvider' | 'configuredProviders'>
const agent = (persona: string): Agent => ({
  id: persona, name: persona, role: '', persona, provider: 'deepseek-official',
  model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
})

beforeEach(() => { state.launched.length = 0; state.closed.length = 0; state.release = undefined })
afterEach(() => { state.release?.() })

describe('Harness runtime pool', () => {
  it('keeps capability identity stable across display edits and separates skill revisions', () => {
    const original = agent('identity')
    const base = getAgentCapabilityHash(original)
    expect(getAgentCapabilityHash({ ...original })).toBe(base)
    expect(getAgentCapabilityHash({ ...original, id: 'other', name: 'Renamed', role: 'New role', createdAt: 'later' })).toBe(base)
    const effective = getAgentCapabilityHash(original, 'skill-revision')
    expect(effective).not.toBe(base)
    expect(getAgentCapabilityBaseHash(effective)).toBe(base)
    expect(getAgentCapabilityHash(original, 'changed-skill-revision')).not.toBe(effective)
  })

  it.each([
    { persona: 'changed' }, { tools: ['文件'] }, { skills: ['sample'] },
    { provider: 'openai' }, { model: 'other-model' },
  ])('changes capability identity for configuration %j', (change) => {
    const original = agent('identity')
    expect(getAgentCapabilityHash({ ...original, ...change })).not.toBe(getAgentCapabilityHash(original))
  })

  it('reuses a runtime for the same capability and isolates a different workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-baseline-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      await adapter.run(agent('a'), 'first')
      await adapter.run({ ...agent('a'), id: 'renamed', name: 'Renamed' }, 'second')
      expect(state.launched).toHaveLength(1)
      adapter.setWorkspace(join(directory, 'other'))
      await adapter.run(agent('a'), 'other workspace')
      expect(state.launched).toHaveLength(2)
      expect(state.launched[0]).not.toBe(state.launched[1])
      await adapter.shutdownAll()
      expect(state.closed).toEqual(state.launched)
    } finally {
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('stops only the owned active runtime and leaves another runtime usable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-baseline-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      const held = adapter.run(agent('a'), 'hold')
      await vi.waitFor(() => expect(state.release).toBeTypeOf('function'))
      await adapter.run(agent('b'), 'first')
      await expect(adapter.stop(agent('a'))).resolves.toBe(true)
      expect(state.closed).toEqual([state.launched[0]])
      await adapter.run(agent('b'), 'second')
      expect(state.launched).toHaveLength(2)
      state.release?.()
      await held
    } finally {
      state.release?.()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses to stop a runtime shared by another active Agent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-baseline-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      const held = adapter.run(agent('a'), 'hold')
      await vi.waitFor(() => expect(state.release).toBeTypeOf('function'))
      const other = adapter.run({ ...agent('a'), id: 'other' }, 'second')
      await expect(adapter.stop(agent('a'))).resolves.toBe(false)
      expect(state.closed).toEqual([])
      await other
      state.release?.()
      await held
    } finally {
      state.release?.()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('changes the capability hash when a selected bundle resource changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-skills-'))
    try {
      const bundle = join(directory, 'skills', 'sample')
      mkdirSync(bundle, { recursive: true })
      writeFileSync(join(bundle, 'SKILL.md'), '---\nname: sample\ndescription: Sample\n---\n')
      writeFileSync(join(bundle, 'REFERENCE.md'), 'first')
      const selected = { ...agent('skills'), skills: ['skill:sample#Sample'] }
      const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
      const before = adapter.capabilityHash(selected)
      writeFileSync(join(bundle, 'REFERENCE.md'), 'second')
      expect(adapter.capabilityHash(selected)).not.toBe(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('stops the active runtime even when its selected skill changes mid-run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-stop-'))
    const bundle = join(directory, 'skills', 'sample')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'SKILL.md'), '---\nname: sample\ndescription: Sample\n---\n')
    writeFileSync(join(bundle, 'REFERENCE.md'), 'first')
    const selected = { ...agent('skills'), skills: ['skill:sample#Sample'] }
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      const held = adapter.run(selected, 'hold')
      await vi.waitFor(() => expect(state.release).toBeTypeOf('function'))
      writeFileSync(join(bundle, 'REFERENCE.md'), 'second')

      await expect(adapter.stop(selected)).resolves.toBe(true)
      expect(state.closed).toEqual([state.launched[0]])
      state.release?.()
      await held
    } finally {
      state.release?.()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps eight recent idle runtimes and closes the least recently used', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await adapter.run(agent(name), name)
      expect(state.closed).toEqual([])
      await adapter.run(agent('i'), 'new')
      expect(state.closed).toEqual([state.launched[0]])
      expect(existsSync(state.launched[0])).toBe(true)
      await adapter.run(agent('b'), 'again')
      await adapter.run(agent('j'), 'newer')
      expect(state.closed).toEqual([state.launched[0], state.launched[2]])
    } finally {
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('closes idle runtimes after ten minutes when the pool is used again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      await adapter.run(agent('old'), 'first')
      now.mockReturnValue(10 * 60_000 + 1_001)
      await adapter.run(agent('current'), 'second')
      expect(state.closed).toEqual([state.launched[0]])
    } finally {
      now.mockRestore()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not close an active runtime and releases it after a failed run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      const held = adapter.run(agent('a'), 'hold')
      for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) await adapter.run(agent(name), name)
      expect(state.closed).toContain(state.launched[1])
      expect(state.closed).not.toContain(state.launched[0])
      state.release?.()
      await held
      await expect(adapter.run(agent('a'), 'fail')).rejects.toThrow('run failed')
      await adapter.run(agent('j'), 'new')
      expect(state.closed).toContain(state.launched[2])
    } finally {
      state.release?.()
      await adapter.shutdownAll()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retains homes for seven days and protects session references and legacy homes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-pool-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      await adapter.run(agent('kept'), 'first')
      await adapter.run(agent('orphan'), 'second')
      await adapter.shutdownAll()
      const [keptHome, orphanHome] = state.launched
      db.getOrCreateRuntimeSession('private:kept', agent('kept'), 'session', adapter.capabilityHash(agent('kept')))
      mkdirSync(join(directory, 'harness', 'manual'), { recursive: true })
      mkdirSync(join(directory, 'harness', 'aaaaaaaaaaaa'), { recursive: true })

      adapter.cleanupUnusedHomes(db.referencedCapabilityHashes())
      expect(existsSync(orphanHome)).toBe(true)
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000)
      adapter.cleanupUnusedHomes(db.referencedCapabilityHashes())

      expect(existsSync(keptHome)).toBe(true)
      expect(existsSync(orphanHome)).toBe(false)
      expect(readdirSync(join(directory, 'harness'))).toContain('manual')
      expect(readdirSync(join(directory, 'harness'))).toContain('aaaaaaaaaaaa')
    } finally {
      vi.useRealTimers()
      await adapter.shutdownAll()
      db.close()
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
    }
  })
})
