import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import type { Agent } from '../src/shared/contracts'
import { getRuntimeIdentity } from '../src/main/runtime-revision'
import { RuntimeHomeMaterializer } from '../src/main/runtime-home-materializer'
import { getAgentCapabilityBaseHash } from '../src/main/agent-capability'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'

const launches = vi.hoisted(() => [] as { dshHome: string; env: Record<string, string> }[])
const prompts = vi.hoisted(() => [] as string[])
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    async start() {}
    constructor(options: { dshHome: string; env: Record<string, string> }) { launches.push(options) }
    async run(prompt: string, options: { sessionId: string }) {
      prompts.push(prompt)
      return { finalResponse: '完成', sessionId: options.sessionId }
    }
    async close() {}
  },
  JsonRpcResponseError: class extends Error {},
}))
const temporaryDirectories: string[] = []
function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mindmesh-runtime-v2-'))
  temporaryDirectories.push(path)
  return path
}
afterEach(() => {
  vi.useRealTimers()
  launches.length = 0
  prompts.length = 0
  for (const directory of temporaryDirectories.splice(0)) {
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true })
  }
})

const agent: Agent = { id: 'a', name: 'A', role: '', persona: 'Test', provider: 'deepseek-official',
  model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '' }
const settings = { getProvider: () => undefined, configuredProviders: () => [] } as unknown as ModelProviderSettings

describe('Runtime V2 identity', () => {
  it('separates full from chat even when the Agent has no configured tools', () => {
    const directory = temporaryDirectory()
    try {
      const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
      const chat = adapter.prepareRun(agent, 'chat')
      const full = adapter.prepareRun(agent, 'full')
      expect(chat.identity.flavor).toBe('core')
      expect(full.identity.flavor).toBe('extended')
      expect(chat.identity.key).not.toBe(full.identity.key)
      expect(chat.identity.capabilityHash).not.toBe(full.identity.capabilityHash)
      expect(adapter.prepareRun({ ...agent, name: 'Renamed' }, 'chat').identity.key).toBe(chat.identity.key)
    } finally { /* Directory is cleaned by the shared fixture. */ }
  })

  it('versions every environment dimension and retains the legacy base-hash parser', () => {
    const directory = temporaryDirectory()
    const input = { baseHash: 'base', skillRevision: 'skills', workspace: directory,
      permission: 'chat' as const, providerRevision: 'provider', dshVersion: '0.2' }
    const original = getRuntimeIdentity(input)
    for (const change of [{ schemaVersion: 3 }, { dshVersion: '0.3' }, { skillRevision: 'new' },
      { providerRevision: 'new' }, { workspace: join(directory, 'other') }, { permission: 'workspace' as const }]) {
      expect(getRuntimeIdentity({ ...input, ...change }).key).not.toBe(original.key)
    }
    expect(getRuntimeIdentity({ ...input, workspace: join(directory, '.') }).key).toBe(original.key)
    if (process.platform === 'win32') expect(getRuntimeIdentity({ ...input, workspace: directory.toUpperCase() }).key).toBe(original.key)
    for (const hash of ['base', 'base:skills', original.capabilityHash]) expect(getAgentCapabilityBaseHash(hash)).toBe('base')
  })

  it('versions plugin composition only for full permission', () => {
    const directory = temporaryDirectory()
    const input = { baseHash: 'base', skillRevision: 'skills', workspace: directory, providerRevision: 'provider', dshVersion: '0.2' }
    for (const permission of ['chat', 'workspace'] as const) {
      expect(getRuntimeIdentity({ ...input, permission, pluginRevision: 'one' }).key).toBe(getRuntimeIdentity({ ...input, permission, pluginRevision: 'two' }).key)
    }
    expect(getRuntimeIdentity({ ...input, permission: 'full', pluginRevision: 'one' }).key).not.toBe(getRuntimeIdentity({ ...input, permission: 'full', pluginRevision: 'two' }).key)
  })

  it('captures provider configuration once, keeps revisions stable across restart, and hides credentials', async () => {
    const directory = temporaryDirectory()
    let provider = { id: 'custom', name: 'Custom', apiKey: 'secret-one', baseUrl: 'https://one.invalid', model: 'm1' }
    const configured = { getProvider: () => provider, configuredProviders: () => [provider] } as unknown as ModelProviderSettings
    const adapter = new DeepSeekHarnessAdapter(directory, directory, configured)
    const customAgent = { ...agent, provider: 'custom', model: 'm1' }
    const first = adapter.prepareRun(customAgent, 'chat')
    expect(new DeepSeekHarnessAdapter(directory, directory, configured).prepareRun(customAgent, 'chat').identity.key).toBe(first.identity.key)
    for (const change of [{ apiKey: 'secret-two' }, { baseUrl: 'https://two.invalid' }, { model: 'm2' }]) {
      provider = { ...first.providers[0], ...change } as typeof provider
      expect(adapter.prepareRun(customAgent, 'chat').identity.key).not.toBe(first.identity.key)
    }
    provider = { ...provider, apiKey: 'changed-after-prepare' }
    try {
      await adapter.run(customAgent, 'hello', undefined, undefined, [], first)
      expect(launches[0].env.MINDMESH_CUSTOM_API_KEY).toBe('secret-one')
      const home = launches[0].dshHome
      expect(readFileSync(join(home, 'provider-settings.yaml'), 'utf8')).toContain('https://one.invalid')
      expect(readFileSync(join(home, 'metadata.json'), 'utf8')).not.toMatch(/secret-one|secret-two|changed-after-prepare/)
      expect(Object.isFrozen(first.agent.tools)).toBe(true)
      expect(Object.isFrozen(first.skillIds)).toBe(true)
    } finally { await adapter.shutdownAll() }
  })

  it('reuses intact homes, rebuilds altered composition without copying sessions, and preserves legacy state', async () => {
    const directory = temporaryDirectory()
    const request = new DeepSeekHarnessAdapter(directory, directory, settings).prepareRun(agent, 'chat')
    const materializer = new RuntimeHomeMaterializer(directory)
    const legacy = join(directory, 'harness', 'old')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'session'), 'old history')
    const first = await materializer.ensure(request)
    writeFileSync(join(first.dshHome, 'session'), 'new history')
    expect((await materializer.ensure(request)).created).toBe(false)
    expect(readFileSync(join(first.dshHome, 'session'), 'utf8')).toBe('new history')
    writeFileSync(first.capabilityPatch, 'altered')
    expect((await materializer.ensure(request)).created).toBe(true)
    expect(existsSync(join(first.dshHome, 'session'))).toBe(false)
    const preserved = readdirSync(join(directory, 'runtime-v2')).find((name) => name.includes('.invalid-'))!
    expect(readFileSync(join(directory, 'runtime-v2', preserved, 'session'), 'utf8')).toBe('new history')
    expect(readFileSync(join(legacy, 'session'), 'utf8')).toBe('old history')
  })

  it('protects active, referenced and incomplete homes while removing expired unreferenced homes', async () => {
    const directory = temporaryDirectory()
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    const materializer = new RuntimeHomeMaterializer(directory)
    const requests = ['active', 'referenced', 'orphan'].map((persona) => adapter.prepareRun({ ...agent, persona }, 'chat'))
    const homes = (await Promise.all(requests.map((request) => materializer.ensure(request)))).map((home) => home.dshHome)
    const incomplete = join(directory, 'runtime-v2', 'a'.repeat(64))
    mkdirSync(incomplete)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000)
    materializer.cleanupExpired([requests[1].identity.capabilityHash], [requests[0].identity.key])
    expect(homes.map(existsSync)).toEqual([true, true, false])
    expect(existsSync(incomplete)).toBe(true)
  })

  it('checks copied Skill bytes and refuses a ready Home when the source changed after preparation', async () => {
    const directory = temporaryDirectory()
    const skill = join(directory, 'skills', 'sample')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: sample\ndescription: Sample\n---\nRun sample.')
    writeFileSync(join(skill, 'REFERENCE.md'), 'first')
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    const skilled = { ...agent, skills: ['sample'] }
    const first = adapter.prepareRun(skilled, 'chat')
    const materializer = new RuntimeHomeMaterializer(directory)
    const home = (await materializer.ensure(first)).dshHome
    expect(readFileSync(join(home, 'selected-skills', 'sample', 'REFERENCE.md'), 'utf8')).toBe('first')
    writeFileSync(join(skill, 'REFERENCE.md'), 'second')
    const second = adapter.prepareRun(skilled, 'chat')
    expect(second.identity.key).not.toBe(first.identity.key)
    writeFileSync(join(skill, 'REFERENCE.md'), 'third')
    await expect(materializer.ensure(second)).rejects.toThrow('Skill content changed')
    expect(existsSync(join(directory, 'runtime-v2', second.identity.key, 'metadata.json'))).toBe(false)
    expect((await materializer.ensure(first)).created).toBe(false)
  })

  it('recovers private and Space history when an existing session loses its home', async () => {
    const directory = temporaryDirectory()
    const provider = { id: 'deepseek-official', name: 'DeepSeek', apiKey: 'test-secret' }
    const configured = { getProvider: () => provider, configuredProviders: () => [provider] } as unknown as ModelProviderSettings
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    const adapter = new DeepSeekHarnessAdapter(directory, directory, configured)
    const services = new MindMeshServices(db, adapter, configured, () => undefined)
    try {
      const initial = services.listAgents()[0]
      const member = services.updateAgent(initial.id, { ...initial, skills: [], tools: [] })
      await services.sendPrivate(member.id, 'private remembered')
      const space = services.createSpace({ name: 'Test', description: '', context: '', memberIds: [member.id] })
      await services.sendSpace(space.id, `@${member.name} space remembered`)
      const before = db.getOrCreateRuntimeSession(`private:${member.id}`, member, 'unused', adapter.capabilityHash(member))
      await adapter.invalidateWorkspace()
      const root = resolve(directory, 'runtime-v2')
      for (const entry of readdirSync(root)) {
        if (/^[a-f0-9]{64}$/.test(entry)) {
          const target = resolve(root, entry)
          if (target.startsWith(root + sep)) rmSync(target, { recursive: true, force: true })
        }
      }
      await services.sendPrivate(member.id, 'private next')
      await services.sendSpace(space.id, `@${member.name} space next`)
      expect(prompts.at(-2)).toContain('private remembered')
      expect(prompts.at(-1)).toContain('space remembered')
      const after = db.getOrCreateRuntimeSession(`private:${member.id}`, member, 'unused', adapter.capabilityHash(member))
      expect(after.harnessSessionId).not.toBe(before.harnessSessionId)
    } finally { await adapter.shutdownAll(); db.close() }
  })
})
