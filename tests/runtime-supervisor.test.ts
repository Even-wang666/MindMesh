import { mockProviderSettings } from './service-mocks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/contracts'

const sdk = vi.hoisted(() => ({
  homes: [] as string[],
  closed: [] as string[],
  finish: undefined as undefined | (() => void),
  startGate: undefined as undefined | Promise<void>,
  closeGate: undefined as undefined | Promise<void>,
  startFailure: false,
  closeFailure: false,
  cancelOnClose: false,
  canceled: new Map<string, (error: Error) => void>(),
  finishers: new Map<string, () => void>(),
}))
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    constructor(private options: { dshHome: string }) {
      sdk.homes.push(options.dshHome)
    }
    async start() {
      await sdk.startGate
      if (sdk.startFailure) {
        sdk.startFailure = false
        throw new Error('invalid initialize')
      }
    }
    async run(prompt: string, options?: { sessionId?: string }) {
      if (prompt.split('\n').at(-1)?.includes('hold'))
        await new Promise<void>((done, reject) => {
          sdk.finish = done
          sdk.finishers.set(prompt, done)
          sdk.canceled.set(this.options.dshHome, reject)
        })
      if (prompt === 'transport')
        throw Object.assign(new Error('closed'), { name: 'TransportClosedError' })
      if (prompt === 'protocol')
        throw Object.assign(new Error('bad wire'), { name: 'SdkProtocolError' })
      if (prompt === 'timeout')
        throw Object.assign(new Error('late'), { name: 'RequestTimeoutError' })
      if (prompt === 'provider') throw Object.assign(new Error('rate limited'), { status: 429 })
      return { finalResponse: 'done', sessionId: options?.sessionId ?? 'session' }
    }
    async close() {
      await sdk.closeGate
      if (sdk.closeFailure) throw new Error('exit unproved')
      sdk.closed.push(this.options.dshHome)
      if (sdk.cancelOnClose)
        sdk.canceled.get(this.options.dshHome)?.(
          Object.assign(new Error('closed'), { name: 'TransportClosedError' })
        )
    }
  },
  JsonRpcResponseError: class extends Error {},
}))
import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  sdk.finish?.()
  for (const finish of sdk.finishers.values()) finish()
  sdk.finishers.clear()
  sdk.canceled.clear()
  sdk.finish = undefined
  sdk.startGate = sdk.closeGate = undefined
  sdk.startFailure = sdk.closeFailure = sdk.cancelOnClose = false
  sdk.homes.length = sdk.closed.length = 0
  for (const dir of dirs.splice(0))
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep))
      rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-supervisor-'))
  dirs.push(directory)
  const settings = mockProviderSettings({
    getProvider: (id: string) =>
      id === 'deepseek-official' || id === 'openai'
        ? { id, name: id, apiKey: 'secret' }
        : undefined,
    configuredProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek', apiKey: 'secret' },
      { id: 'openai', name: 'OpenAI', apiKey: 'secret' },
    ],
  })
  const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
  const agent: Agent = {
    id: 'a',
    name: 'A',
    role: '',
    persona: 'A',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    skills: [],
    tools: [],
    createdAt: '',
  }
  return { adapter, agent }
}

it('shares one starting promise for concurrent turns and reserves both leases before initialization', async () => {
  const { adapter, agent } = fixture()
  let initialized!: () => void
  sdk.startGate = new Promise<void>((done) => {
    initialized = done
  })
  const first = adapter.run(agent, 'first')
  const second = adapter.run({ ...agent, id: 'b' }, 'second')
  try {
    await vi.waitFor(() => expect(sdk.homes).toHaveLength(1))
    expect(adapter.runtimeDiagnostics()[0]).toMatchObject({
      state: 'starting',
      activeLeaseCount: 2,
    })
    initialized()
    await Promise.all([first, second])
    expect(adapter.runtimeDiagnostics()[0]).toMatchObject({ state: 'ready', activeLeaseCount: 0 })
  } finally {
    initialized()
    await adapter.shutdownAll()
  }
})

it('cleans failed startup before retrying the same home', async () => {
  const { adapter, agent } = fixture()
  sdk.startFailure = true
  try {
    await expect(adapter.run(agent, 'first')).rejects.toMatchObject({ kind: 'startup' })
    expect(sdk.closed).toEqual([sdk.homes[0]])
    await expect(adapter.run(agent, 'retry')).resolves.toMatchObject({ text: 'done' })
    expect(sdk.homes).toHaveLength(2)
  } finally {
    await adapter.shutdownAll()
  }
})

it.each(['transport', 'protocol', 'timeout'])(
  'retires a %s failure and allows a clean retry',
  async (failure) => {
    const { adapter, agent } = fixture()
    try {
      await expect(adapter.run(agent, failure)).rejects.toThrow()
      expect(sdk.closed).toHaveLength(1)
      await adapter.run(agent, 'retry')
      expect(sdk.homes).toHaveLength(2)
    } finally {
      await adapter.shutdownAll()
    }
  }
)

it('keeps provider failures retryable in the same runtime and records safe diagnostics', async () => {
  const { adapter, agent } = fixture()
  try {
    await expect(adapter.run(agent, 'provider')).rejects.toThrow()
    expect(adapter.runtimeDiagnostics()[0]).toMatchObject({
      state: 'ready',
      activeLeaseCount: 0,
      lastError: { kind: 'provider' },
    })
    await adapter.run(agent, 'retry')
    expect(sdk.homes).toHaveLength(1)
    expect(JSON.stringify(adapter.runtimeDiagnostics())).not.toContain('secret')
  } finally {
    await adapter.shutdownAll()
  }
})

it('does not start a replacement writer until close finishes', async () => {
  const { adapter, agent } = fixture()
  let closed!: () => void
  const held = adapter.run(agent, 'hold')
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    sdk.closeGate = new Promise<void>((done) => {
      closed = done
    })
    const stopping = adapter.stop(agent)
    const replacement = adapter.run(agent, 'replacement')
    await new Promise((done) => setTimeout(done, 20))
    expect(sdk.homes).toHaveLength(1)
    closed()
    await stopping
    sdk.finish?.()
    await held
    await replacement
    expect(sdk.homes).toHaveLength(2)
  } finally {
    closed?.()
    sdk.finish?.()
    await adapter.shutdownAll()
  }
})

it('reports successful cancellation even when close rejects the active SDK turn', async () => {
  const { adapter, agent } = fixture()
  sdk.cancelOnClose = true
  const held = adapter.run(agent, 'hold')
  const rejected = expect(held).rejects.toMatchObject({ name: 'TransportClosedError' })
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    expect(await adapter.stop(agent)).toBe(true)
    await rejected
    await adapter.run(agent, 'retry')
    expect(sdk.homes).toHaveLength(2)
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
  }
})

it('blocks replacement when process exit could not be proved', async () => {
  const { adapter, agent } = fixture()
  try {
    await adapter.run(agent, 'first')
    sdk.closeFailure = true
    await adapter.invalidateProvider(agent.provider)
    expect(adapter.runtimeDiagnostics()[0]).toMatchObject({
      state: 'failed',
      lastError: { kind: 'transport-closed' },
    })
    expect(adapter.status()).toMatchObject({ state: 'error' })
    expect(adapter.status().detail).toContain('重新启动应用')
    await expect(adapter.run(agent, 'replacement')).rejects.toMatchObject({
      kind: 'transport-closed',
    })
    expect(sdk.homes).toHaveLength(1)
  } finally {
    sdk.closeFailure = false
    await adapter.shutdownAll()
  }
})

it('invalidates only runtimes using the changed provider, including its web-search dependency', async () => {
  const { adapter, agent } = fixture()
  try {
    await adapter.run(agent, 'native')
    const openai = { ...agent, id: 'openai', provider: 'openai', model: 'gpt-4.1' }
    await adapter.run(openai, 'plain')
    const web = { ...openai, id: 'web', tools: ['网页搜索'] }
    await adapter.run(web, 'web', undefined, undefined, [], adapter.prepareRun(web, 'full'))
    await adapter.invalidateProvider('deepseek-official')
    expect(sdk.closed).toEqual([sdk.homes[0], sdk.homes[2]])
    await adapter.run(openai, 'still available')
    expect(sdk.homes).toHaveLength(3)
  } finally {
    await adapter.shutdownAll()
  }
})

it('cancels the requested sole lease without closing another generation of the same Agent', async () => {
  const { adapter, agent } = fixture()
  const run = (persona: string, requestId: string) =>
    adapter.run(
      { ...agent, persona },
      `hold-${requestId}`,
      undefined,
      undefined,
      [],
      adapter.prepareRun({ ...agent, persona }, 'chat'),
      false,
      { contextKey: `private:${requestId}`, requestId, recoveryPrompt: () => '', conversationId: `private:${requestId}`, executionId: 'e1', triggerMessageId: 'm1' }
    )
  const first = run('first', 'one')
  const second = run('second', 'two')
  try {
    await vi.waitFor(() => expect(sdk.finishers.size).toBe(2))
    expect(await adapter.stop(agent, 'one')).toBe(true)
    expect(sdk.closed).toEqual([sdk.homes[0]])
    expect(adapter.runtimeDiagnostics()[0].activeLeaseCount).toBe(1)
    sdk.finishers.get('hold-one')?.()
    sdk.finishers.get('hold-two')?.()
    await Promise.all([first, second])
  } finally {
    for (const finish of sdk.finishers.values()) finish()
    await adapter.shutdownAll()
  }
})

it('closes a starting runtime during shutdown and rejects future acquisitions', async () => {
  const { adapter, agent } = fixture()
  let initialized!: () => void
  sdk.startGate = new Promise<void>((done) => {
    initialized = done
  })
  const starting = adapter.run(agent, 'first')
  const rejected = expect(starting).rejects.toMatchObject({ kind: 'transport-closed' })
  await vi.waitFor(() => expect(sdk.homes).toHaveLength(1))
  const shutdown = adapter.shutdownAll()
  initialized()
  await Promise.all([rejected, shutdown])
  expect(sdk.closed).toHaveLength(1)
  await expect(adapter.run(agent, 'next')).rejects.toMatchObject({ kind: 'transport-closed' })
})

function servicesFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-supervisor-services-'))
  dirs.push(directory)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [] }) }))
  )
  let apiKey = 'first'
  const settings = mockProviderSettings({
    getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey }),
    configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey }],
    save: (input: { apiKey: string }) => {
      apiKey = input.apiKey
      return []
    },
    remove: () => [],
    statuses: () => [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        description: '',
        source: 'saved',
        configured: true,
      },
    ],
  })
  const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
  const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
  const service = new MindMeshServices(db, adapter, settings, () => undefined)
  const initial = service.listAgents()[0]
  const agent = service.updateAgent(initial.id, { ...initial, skills: [], tools: [] })
  return { db, adapter, service, agent, directory }
}

it('provider saves preserve an active answer and prevent its late Session ID from replacing the new generation', async () => {
  const { db, adapter, service, agent } = servicesFixture()
  const held = service.sendPrivate(agent.id, 'hold')
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    await service.saveModelProvider({ id: 'deepseek-official', apiKey: 'second' })
    expect(sdk.closed).toEqual([])
    await service.sendPrivate(agent.id, 'next')
    const current = db.getOrCreateRuntimeSession(
      runtimeContextKey(`private:${agent.id}`, agent.id),
      agent,
      'unused',
      adapter.capabilityHash(agent)
    )
    sdk.finish?.()
    await held
    const after = db.getOrCreateRuntimeSession(
      runtimeContextKey(`private:${agent.id}`, agent.id),
      agent,
      'unused',
      adapter.capabilityHash(agent)
    )
    expect(after.harnessSessionId).toBe(current.harnessSessionId)
    expect(
      service.messages('private', agent.id).filter((message) => message.authorType === 'agent')
    ).toHaveLength(2)
    expect(sdk.closed).toEqual([sdk.homes[0]])
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
    db.close()
  }
})

it('workspace changes preserve active turns and route the next request through a fresh Session', async () => {
  const { db, adapter, service, agent, directory } = servicesFixture()
  const held = service.sendPrivate(agent.id, 'hold')
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    await service.changeWorkspace(join(directory, 'new-workspace'))
    expect(sdk.closed).toEqual([])
    expect(db.referencedCapabilityHashes()).toEqual([])
    sdk.finish?.()
    await held
    expect(db.referencedCapabilityHashes()).toEqual([])
    await service.sendPrivate(agent.id, 'next')
    expect(sdk.homes[1]).not.toBe(sdk.homes[0])
    expect(
      service.messages('private', agent.id).filter((message) => message.authorType === 'agent')
    ).toHaveLength(2)
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
    db.close()
  }
})

it('removing one owner neither kills a shared runtime nor resurrects deleted messages', async () => {
  const { db, adapter, service, agent } = servicesFixture()
  const other = service.createAgent({ ...agent, name: 'Other' })
  const held = service.sendPrivate(agent.id, 'hold')
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    await service.sendPrivate(other.id, 'first')
    await service.removeAgent(agent.id)
    expect(sdk.closed).toEqual([])
    sdk.finish?.()
    await held
    expect(
      service.messages('private', agent.id).filter((message) => message.authorType === 'agent')
    ).toEqual([])
    await service.sendPrivate(other.id, 'next')
    expect(sdk.homes).toHaveLength(1)
    expect(
      service.messages('private', other.id).filter((message) => message.authorType === 'agent')
    ).toHaveLength(2)
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
    db.close()
  }
})

it('removing an active Space drains its sole lease and keeps unrelated private chat usable', async () => {
  const { db, adapter, service, agent } = servicesFixture()
  const space = service.createSpace({
    name: 'Space',
    description: '',
    context: '',
    memberIds: [agent.id],
  })
  const held = service.sendSpace(space.id, `@${agent.name} hold`)
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    await service.removeSpace(space.id)
    expect(sdk.closed).toEqual([])
    sdk.finish?.()
    await held
    expect(service.messages('space', space.id)).toEqual([])
    expect(sdk.closed).toHaveLength(1)
    await service.sendPrivate(agent.id, 'next')
    expect(service.messages('private', agent.id).at(-1)?.content).toBe('done')
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
    db.close()
  }
})

it('retires a context’s previous live capability only after its active turn finishes', async () => {
  const { adapter, agent } = fixture()
  const held = adapter.run(agent, 'hold')
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    await adapter.run({ ...agent, reasoningEffort: 'high' }, 'next')
    expect(sdk.closed).toEqual([])
    expect(adapter.runtimeDiagnostics().find((entry) => entry.stale)?.activeLeaseCount).toBe(1)
    sdk.finish?.()
    await held
    expect(sdk.closed).toEqual([sdk.homes[0]])
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
  }
})

it('can return to a previous identity while a newer identity still has an active lease', async () => {
  const { adapter, agent } = fixture()
  await adapter.run(agent, 'first')
  const held = adapter.run({ ...agent, persona: 'B' }, 'hold')
  let returning: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    let finished = false
    returning = adapter.run(agent, 'return').then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 })
    expect(sdk.closed).toContain(sdk.homes[0])
  } finally {
    sdk.finish?.()
    await held
    await returning
    await adapter.shutdownAll()
  }
})

it('retires the previous idle identity even when its replacement fails startup', async () => {
  const { adapter, agent } = fixture()
  try {
    await adapter.run(agent, 'first')
    sdk.startFailure = true
    await expect(adapter.run({ ...agent, persona: 'B' }, 'replacement')).rejects.toMatchObject({
      kind: 'startup',
    })
    expect(sdk.closed).toContain(sdk.homes[0])
    expect(adapter.runtimeDiagnostics()).toEqual([])
  } finally {
    await adapter.shutdownAll()
  }
})

it('keeps an active provider generation alive, routes new turns to a new home, and retires after release', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-supervisor-'))
  dirs.push(directory)
  let apiKey = 'first'
  const settings = mockProviderSettings({
    getProvider: () => ({ id: 'deepseek-official', name: 'DeepSeek', apiKey }),
    configuredProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', apiKey }],
  })
  const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
  const agent = {
    id: 'a',
    name: 'A',
    role: '',
    persona: 'A',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    skills: [],
    tools: [],
    createdAt: '',
  }
  try {
    const held = adapter.run(agent, 'hold')
    await vi.waitFor(() => expect(sdk.finish).toBeTypeOf('function'))
    apiKey = 'second'
    await adapter.invalidateProvider('deepseek-official')
    expect(sdk.closed).toEqual([])
    await adapter.run(agent, 'next')
    expect(sdk.homes[1]).not.toBe(sdk.homes[0])
    sdk.finish?.()
    await held
    expect(sdk.closed).toEqual([sdk.homes[0]])
  } finally {
    sdk.finish?.()
    await adapter.shutdownAll()
  }
})
