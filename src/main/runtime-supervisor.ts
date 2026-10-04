import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RuntimeRequest } from './runtime-revision'
import { RuntimeHomeMaterializer } from './runtime-home-materializer'
import { classifyRuntimeFailure, RuntimeFailure, type RuntimeFailureKind } from './runtime-errors'
import { getModelProviderDefinition } from '../shared/model-providers'

const MAX_IDLE_RUNTIMES = 8
const IDLE_RUNTIME_TTL_MS = 10 * 60_000
const SYSTEM_ENVIRONMENT = new Set([
  'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'OS', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PSMODULEPATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
])

export type RuntimeOwner = { agentId: string; contextKey: string; requestId: string }
type RuntimeState = 'preparing' | 'starting' | 'ready' | 'busy' | 'stale' | 'failed' | 'stopped'
export type RuntimeDiagnostic = {
  key: string; state: RuntimeState; activeLeaseCount: number; stale: boolean; lastUsedAt: number
  lastError?: { kind: RuntimeFailureKind; at: number }
}
type RuntimeEntry = {
  request: RuntimeRequest; state: RuntimeState; stale: boolean; lastUsedAt: number
  harness?: DeepSeekHarness; start: Promise<void>; closing?: Promise<void>
  prepareAbort: AbortController
  retired: Promise<void>; finishRetirement: () => void
  leases: Map<symbol, RuntimeOwner>; owners: Map<string, string>; sessions: Set<string>
  lastError?: RuntimeDiagnostic['lastError']
}
export type RuntimeLease = {
  harness: DeepSeekHarness; sessions: Set<string>; release: (error?: unknown) => Promise<void>
}

/** Owns every process, including its starting/closing interval, until exit is proved. */
export class RuntimeSupervisor {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly homes: RuntimeHomeMaterializer
  private shuttingDown = false
  private shutdownTask?: Promise<void>

  constructor(dataDirectory: string) { this.homes = new RuntimeHomeMaterializer(dataDirectory) }

  listStatus(): RuntimeDiagnostic[] {
    return [...this.entries].map(([key, entry]) => ({ key, state: entry.state, stale: entry.stale,
      activeLeaseCount: entry.leases.size, lastUsedAt: entry.lastUsedAt, lastError: entry.lastError }))
  }

  cleanupHomes(references: string[]): void { this.homes.cleanupExpired(references, [...this.entries.keys()]) }

  async acquire(request: RuntimeRequest, owner: RuntimeOwner): Promise<RuntimeLease> {
    if (this.shuttingDown) throw new RuntimeFailure('transport-closed')
    const key = request.identity.key
    // Move this context's ownership when its live capability revision changes.
    // Other contexts may still legitimately use the previous persona/capability snapshot.
    for (const [previousKey, previous] of this.entries) if (previousKey !== key && previous.owners.has(owner.contextKey)) {
      previous.owners.delete(owner.contextKey)
      if (previous.owners.size === 0) {
        previous.stale = true
        if (previous.state !== 'failed') previous.state = 'stale'
        if (previous.leases.size === 0) void this.retire(previous)
      }
    }
    let entry = this.entries.get(key)
    if (entry?.stale) {
      await entry.retired
      if (this.entries.get(key) === entry) throw new RuntimeFailure('transport-closed')
      return this.acquire(request, owner)
    }
    if (!entry) {
      let finishRetirement!: () => void
      entry = { request, state: 'preparing', stale: false, lastUsedAt: Date.now(),
        start: Promise.resolve(), retired: new Promise<void>((done) => { finishRetirement = done }),
        finishRetirement, prepareAbort: new AbortController(), leases: new Map(), owners: new Map(), sessions: new Set() }
      this.entries.set(key, entry)
      const starting = entry
      entry.start = Promise.resolve().then(async () => {
        let home
        try { home = await this.homes.ensure(request, starting.prepareAbort.signal) }
        catch (error) { throw new RuntimeFailure('materialization', error) }
        starting.state = 'starting'
        const environment = Object.fromEntries(Object.entries(process.env).filter(
          (value): value is [string, string] => value[1] !== undefined && SYSTEM_ENVIRONMENT.has(value[0].toUpperCase()),
        ))
        const credentials = Object.fromEntries(request.providers.map((provider) => [
          provider.id === 'custom' ? 'MINDMESH_CUSTOM_API_KEY' : getModelProviderDefinition(provider.id)?.environmentKey,
          provider.apiKey,
        ]).filter((value): value is [string, string] => Boolean(value[0])))
        try {
          starting.harness = new DeepSeekHarness({ dshBin: request.dshBin, profile: 'sdk', patches: [home.capabilityPatch],
            provider: request.agent.provider, model: request.agent.model, cwd: request.workspace, processCwd: request.workspace,
            dshHome: home.dshHome, env: { ...environment, ...credentials, DSH_HOME: home.dshHome, ELECTRON_RUN_AS_NODE: '1' },
            maxTokens: 8192, initializeTimeoutMs: 30_000,
            ...(request.agent.reasoningEffort ? { reasoningEffort: request.agent.reasoningEffort as ReasoningEffortId } : {}) })
          await starting.harness.start()
        } catch (error) { throw new RuntimeFailure('startup', error) }
        starting.state = starting.stale ? 'stale' : 'busy'
      })
    }
    const token = Symbol(owner.requestId)
    entry.leases.set(token, owner)
    entry.owners.set(owner.contextKey, owner.agentId)
    entry.lastUsedAt = Date.now()
    this.entries.delete(key)
    this.entries.set(key, entry)
    try {
      await entry.start
      if (this.shuttingDown || entry.closing) throw new RuntimeFailure('transport-closed')
    } catch (error) {
      this.fail(entry, classifyRuntimeFailure(error))
      entry.leases.delete(token)
      if (entry.leases.size === 0) await this.retire(entry)
      throw error
    }
    const acquired = entry
    acquired.state = acquired.stale ? 'stale' : 'busy'
    let released = false
    return { harness: acquired.harness!, sessions: acquired.sessions, release: async (error?: unknown) => {
      if (released) return
      released = true
      acquired.leases.delete(token)
      acquired.lastUsedAt = Date.now()
      if (error !== undefined) {
        const kind = classifyRuntimeFailure(error)
        acquired.lastError = { kind, at: Date.now() }
        // Timeouts may leave the server working; retire once all other leases finish.
        if (['transport-closed', 'protocol', 'request-timeout'].includes(kind)) this.fail(acquired, kind)
      }
      if (!acquired.stale && !acquired.closing) acquired.state = acquired.leases.size ? 'busy' : 'ready'
      try { this.homes.markLastUsed(key) } catch { /* Maintenance must not replace a reply. */ }
      await this.evictIdle()
    } }
  }

  async invalidateProvider(id: string): Promise<void> {
    await this.markStale((entry) => entry.request.providers.some((provider) => provider.id === id))
  }

  async invalidateWorkspace(): Promise<void> { await this.markStale(() => true) }
  async invalidatePlugins(): Promise<void> { await this.markStale((entry) => entry.request.identity.flavor === 'extended') }

  async forgetOwner(agentId?: string, contextPrefix?: string): Promise<void> {
    for (const entry of this.entries.values()) {
      for (const [context, agent] of entry.owners) {
        if (agentId === agent || contextPrefix && context.startsWith(contextPrefix)) entry.owners.delete(context)
      }
    }
    await this.markStale((entry) => entry.owners.size === 0)
  }

  async stop(agentId: string, requestId?: string): Promise<boolean> {
    const candidates = [...this.entries.values()].filter((entry) => entry.leases.size === 1
      && [...entry.leases.values()].some((owner) => owner.agentId === agentId && (!requestId || owner.requestId === requestId)))
    if (candidates.length !== 1) return false
    const entry = candidates[0]
    entry.stale = true
    entry.prepareAbort.abort()
    await this.retire(entry)
    return this.entries.get(entry.request.identity.key) !== entry
  }

  shutdownAll(): Promise<void> {
    this.shuttingDown = true
    this.shutdownTask ??= Promise.all([...this.entries.values()].map((entry) => this.retire(entry))).then(() => undefined)
    return this.shutdownTask
  }

  private fail(entry: RuntimeEntry, kind: RuntimeFailureKind): void {
    entry.stale = true
    entry.state = 'failed'
    entry.lastError = { kind, at: Date.now() }
  }

  private async markStale(predicate: (entry: RuntimeEntry) => boolean): Promise<void> {
    for (const entry of this.entries.values()) if (predicate(entry)) {
      entry.stale = true
      if (entry.state !== 'failed') entry.state = 'stale'
    }
    await this.evictIdle()
  }

  private async evictIdle(): Promise<void> {
    const now = Date.now()
    let poolSize = this.entries.size
    for (const entry of [...this.entries.values()]) {
      if (entry.leases.size !== 0) continue
      if (entry.stale || poolSize > MAX_IDLE_RUNTIMES || now - entry.lastUsedAt >= IDLE_RUNTIME_TTL_MS) {
        poolSize--
        await this.retire(entry)
      }
    }
  }

  private retire(entry: RuntimeEntry): Promise<void> {
    entry.stale = true
    entry.prepareAbort.abort()
    entry.closing ??= (async () => {
      await entry.start.catch(() => undefined)
      try {
        await entry.harness?.close()
        entry.state = 'stopped'
        if (this.entries.get(entry.request.identity.key) === entry) this.entries.delete(entry.request.identity.key)
      } catch { this.fail(entry, 'transport-closed') }
      finally { entry.finishRetirement() }
    })()
    return entry.closing
  }
}
