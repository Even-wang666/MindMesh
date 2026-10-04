import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { MindMeshDatabase } from '../database'
import { PluginSetManager } from './plugin-set'
import { PluginManager, PluginStaging, type PluginChange } from './plugin-manager'

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
  const db = new MindMeshDatabase(join(request.dataDirectory, 'mindmesh.sqlite'))
  try {
    const manager = new PluginManager(new PluginSetManager(db), new PluginStaging(request.dataDirectory, process.resourcesPath, request.fixtureRegistry))
    const result = change ? await manager.change(change as PluginChange, signal) : manager.snapshot()
    writeFileSync(request.resultFile, JSON.stringify({ ok: true, ...result }, null, 2))
  } catch (error) {
    writeFileSync(request.resultFile, JSON.stringify({ ok: false, error: String(error) }, null, 2))
    throw error
  } finally { db.close() }
}
