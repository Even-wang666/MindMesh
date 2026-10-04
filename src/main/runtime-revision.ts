import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Agent, ChatPermission } from '../shared/contracts'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import type { PluginArtifact } from './plugins/plugin-set'

export const RUNTIME_SCHEMA_VERSION = 2
export type RuntimeFlavor = 'core' | 'extended'
export type RuntimeIdentity = {
  key: string
  capabilityHash: string
  schemaVersion: number
  dshVersion: string
  flavor: RuntimeFlavor
  permission: ChatPermission
  workspaceIdentity: string
  skillRevision: string
  pluginRevision?: string
}
export type RuntimePlugins = {
  revision: string; desiredRevision: string; artifact: Readonly<PluginArtifact> | null
  packages: readonly Readonly<{ packageName: string; version: string; configJson: string }>[]
}
export type RuntimeRequest = {
  agent: Agent
  workspace: string
  identity: RuntimeIdentity
  providers: readonly ModelProviderRuntimeConfig[]
  skillIds: readonly string[]
  dshBin: string
  plugins?: Readonly<RuntimePlugins>
}

export function providerRuntimeRevision(providers: readonly ModelProviderRuntimeConfig[], dataDirectory: string): string {
  if (providers.length === 0) return 'unconfigured'
  const root = join(dataDirectory, 'runtime-v2')
  mkdirSync(root, { recursive: true })
  const path = join(root, 'provider-revision.key')
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  const secret = readFileSync(path)
  if (secret.length !== 32) throw new Error('Provider revision key is invalid')
  // Keyed opaque revision: stable across restart without persisting credentials or plain key hashes.
  return createHmac('sha256', secret).update(JSON.stringify(providers)).digest('hex')
}

export function getRuntimeIdentity(input: {
  baseHash: string; skillRevision: string; workspace: string; permission: ChatPermission
  providerRevision: string; dshVersion: string; schemaVersion?: number; pluginRevision?: string
}): RuntimeIdentity {
  if (!['chat', 'workspace', 'full'].includes(input.permission)) throw new Error('权限级别无效')
  const schemaVersion = input.schemaVersion ?? RUNTIME_SCHEMA_VERSION
  const flavor: RuntimeFlavor = input.permission === 'full' ? 'extended' : 'core'
  const path = existsSync(input.workspace) ? realpathSync(input.workspace) : resolve(input.workspace)
  const workspaceIdentity = process.platform === 'win32' ? path.toLowerCase() : path
  const environment = createHash('sha256').update(JSON.stringify([
    schemaVersion, input.dshVersion, flavor, input.permission, input.providerRevision, workspaceIdentity,
    ...(flavor === 'extended' ? [input.pluginRevision ?? 'none'] : []),
  ])).digest('hex')
  const capabilityHash = `${input.baseHash}:${input.skillRevision}:${environment}`
  const key = createHash('sha256').update(JSON.stringify([schemaVersion, input.dshVersion, flavor, capabilityHash, workspaceIdentity])).digest('hex')
  return Object.freeze({ key, capabilityHash, schemaVersion, dshVersion: input.dshVersion, flavor,
    permission: input.permission, workspaceIdentity, skillRevision: input.skillRevision,
    ...(flavor === 'extended' ? { pluginRevision: input.pluginRevision ?? 'none' } : {}) })
}
