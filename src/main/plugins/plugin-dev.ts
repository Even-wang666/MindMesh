import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MindMeshDatabase } from '../database'
import { PluginSetManager } from './plugin-set'
import { PluginManager, PluginStaging, type PluginChange } from './plugin-manager'
import { DeepSeekHarnessAdapter } from '../harness-adapter'
import type { ModelProviderRuntimeConfig } from '../model-provider-settings'
import { redactPluginDiagnostic } from './plugin-diagnostics'

/** Explicit developer CLI only; there is no renderer IPC for plugin mutation in PR4. */
export async function runPluginDeveloperRequest(file: string, signal: AbortSignal): Promise<void> {
  if (!isAbsolute(file)) throw new Error('Plugin developer request path must be absolute')
  const input = readFileSync(file, 'utf8')
  if (input.length > 16_384) throw new Error('Plugin developer request too large')
  const request = JSON.parse(input)
  if (!request || typeof request.dataDirectory !== 'string' || !isAbsolute(request.dataDirectory)
    || typeof request.resultFile !== 'string' || !isAbsolute(request.resultFile)) throw new Error('Developer dataDirectory and resultFile must be absolute')
  const change = request.change
  if (change && (!['install', 'update', 'remove', 'enable', 'disable'].includes(change.kind)
    || typeof change.packageName !== 'string'
    || ['install', 'update'].includes(change.kind) && typeof change.version !== 'string')) throw new Error('Invalid plugin change')
  if (request.fixtureRegistry !== undefined && typeof request.fixtureRegistry !== 'string') throw new Error('Invalid fixture registry')
  if (request.runtime && (!['chat', 'workspace', 'full'].includes(request.runtime.permission)
    || typeof request.runtime.baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(request.runtime.baseUrl))) throw new Error('Runtime smoke requires a loopback model fixture and explicit permission')
  const db = new MindMeshDatabase(join(request.dataDirectory, 'mindmesh.sqlite'))
  try {
    const set = new PluginSetManager(db)
    const manager = new PluginManager(set, new PluginStaging(request.dataDirectory, process.resourcesPath, request.fixtureRegistry))
    const result = change ? await manager.change(change as PluginChange, signal) : manager.snapshot()
    let runtime
    if (request.runtime) {
      const provider: ModelProviderRuntimeConfig = { id: 'custom', name: 'Fixture', apiKey: 'fixture-key', baseUrl: request.runtime.baseUrl, model: 'fixture-model' }
      const settings = { getProvider: (id: string) => id === provider.id ? provider : undefined, configuredProviders: () => [provider] }
      const workspace = join(request.dataDirectory, 'runtime-smoke-workspace')
      mkdirSync(workspace, { recursive: true })
      const adapter = new DeepSeekHarnessAdapter(workspace, request.dataDirectory, settings, set)
      const abort = (): void => { void adapter.shutdownAll().catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        const agent = { id: 'plugin-smoke', name: 'Plugin smoke', role: '', persona: '', provider: 'custom', model: 'fixture-model', tools: ['Shell'], skills: [], createdAt: '' }
        const snapshot = adapter.prepareRun(agent, request.runtime.permission)
        const reply = await adapter.run(agent, 'call the fixture tool', undefined, undefined, [], snapshot)
        runtime = { text: reply.text, key: snapshot.identity.key, flavor: snapshot.identity.flavor }
      } finally { signal.removeEventListener('abort', abort); await adapter.shutdownAll() }
    }
    writeFileSync(request.resultFile, JSON.stringify({ ok: true, ...result, ...(runtime ? { runtime } : {}) }, null, 2))
  } catch (error) {
    const message = redactPluginDiagnostic(error)
    writeFileSync(request.resultFile, JSON.stringify({ ok: false, error: message }, null, 2))
    throw new Error(message, { cause: error })
  } finally { db.close() }
}
