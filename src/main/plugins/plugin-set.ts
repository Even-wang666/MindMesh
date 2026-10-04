import { createHash } from 'node:crypto'
import type { MindMeshDatabase } from '../database'
import type { RuntimePlugins } from '../runtime-revision'

export type InstalledPlugin = {
  packageName: string
  version: string
  enabled: boolean
  config: Record<string, unknown>
  installedAt: string
  updatedAt: string
}
export type PluginArtifact = { revision: string; directory: string; digest: string }
export type PluginSetSnapshot = {
  generation: number
  revision: string
  plugins: InstalledPlugin[]
  artifact: PluginArtifact | null
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

export function pluginSetRevision(plugins: readonly InstalledPlugin[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical(
          plugins
            .map(({ packageName, version, enabled, config }) => ({
              packageName,
              version,
              enabled,
              config,
            }))
            .sort((a, b) => a.packageName.localeCompare(b.packageName))
        )
      )
    )
    .digest('hex')
}

export function validatePluginSpec(packageName: string, version: string): void {
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName) ||
    packageName.length > 214 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(
      version
    )
  )
    throw new Error('Plugin requires an npm package name and exact version')
}

/** SQLite owns desired state; validated artifacts contain no live sessions or credentials. */
export class PluginSetManager {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly database: MindMeshDatabase) {}
  snapshot(): PluginSetSnapshot {
    return this.database.readPluginSet()
  }
  runtimeSnapshot(): Readonly<RuntimePlugins> | undefined {
    const snapshot = this.snapshot()
    const enabled = snapshot.plugins.filter((plugin) => plugin.enabled)
    if (enabled.length === 0) return undefined
    return Object.freeze({
      revision: pluginSetRevision(enabled),
      desiredRevision: snapshot.revision,
      artifact: snapshot.artifact && Object.freeze({ ...snapshot.artifact }),
      packages: Object.freeze(
        enabled.map(({ packageName, version, config }) =>
          Object.freeze({ packageName, version, configJson: JSON.stringify(config) })
        )
      ),
    })
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  commit(
    generation: number,
    plugins: InstalledPlugin[],
    artifact: PluginArtifact
  ): PluginSetSnapshot {
    for (const plugin of plugins) validatePluginSpec(plugin.packageName, plugin.version)
    if (new Set(plugins.map((plugin) => plugin.packageName)).size !== plugins.length)
      throw new Error('Duplicate plugin package')
    if (artifact.revision !== pluginSetRevision(plugins))
      throw new Error('Plugin revision mismatch')
    const committed = this.database.commitPluginSet(generation, plugins, artifact)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* A committed set cannot be rolled back by an observer. */
      }
    }
    return committed
  }
}
