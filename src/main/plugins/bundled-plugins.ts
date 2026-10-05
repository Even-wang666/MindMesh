import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { getDshRuntimeInfo } from '../dsh-runtime'
import type { MarketplaceProvider } from '../marketplace'
import { pluginMetadataAvailable, type PluginPackageMetadata } from './plugin-availability'
import { validatePluginSpec, type InstalledPlugin } from './plugin-set'
import { pluginSourceArchive } from './plugin-sources'

const bundleSchema = z.object({
  schema: z.literal(1),
  runtimeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  nodeVersion: z.string(),
  checkedSets: z.array(z.array(z.string())),
  plugins: z
    .array(
      z.object({
        packageName: z.string(),
        version: z.string(),
        name: z.string().min(1).max(160),
        description: z.string().max(2000),
        license: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()),
      })
    )
    .max(4),
})

export type PluginPackageCache = { directory: string; offline: boolean }

export function packageCacheEnvironment(cache: PluginPackageCache): NodeJS.ProcessEnv {
  return {
    pnpm_config_store_dir: join(cache.directory, 'store'),
    pnpm_config_cache_dir: join(cache.directory, 'cache'),
    pnpm_config_offline: String(cache.offline),
  }
}

/** Only release-time SDK-validated, mutually composable packages enter the user catalog. */
export class BundledPluginLibrary implements MarketplaceProvider {
  readonly kind = 'plugins' as const
  readonly source = 'dsh'
  readonly directory: string
  private readonly bundle: z.infer<typeof bundleSchema> | null
  private readonly digest: string

  constructor(resourcesPath = process.resourcesPath) {
    const packaged =
      resourcesPath && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp
    this.directory = packaged
      ? join(resourcesPath, 'verified-plugins')
      : join(process.cwd(), '.runtime', 'verified-plugins')
    const file = join(this.directory, 'catalog.json')
    if (!existsSync(file)) {
      if (packaged) throw new Error('Verified plugin bundle missing')
      this.bundle = null
      this.digest = ''
      return
    }
    if (statSync(file).size > 1024 * 1024) throw new Error('Verified plugin catalog too large')
    const text = readFileSync(file, 'utf8')
    this.digest = createHash('sha256').update(text).digest('hex')
    const bundle = bundleSchema.parse(JSON.parse(text))
    if (
      bundle.runtimeVersion !== getDshRuntimeInfo(resourcesPath).version ||
      bundle.platform !== process.platform ||
      bundle.arch !== process.arch ||
      bundle.nodeVersion !== process.versions.node ||
      new Set(bundle.plugins.map((plugin) => plugin.packageName)).size !== bundle.plugins.length
    )
      throw new Error('Verified plugin bundle does not match this runtime')
    for (const plugin of bundle.plugins) {
      validatePluginSpec(plugin.packageName, plugin.version)
      if (plugin.metadata.name !== plugin.packageName || plugin.metadata.version !== plugin.version)
        throw new Error('Verified plugin identity mismatch')
    }
    for (let mask = 1; mask < 2 ** bundle.plugins.length; mask++) {
      const names = bundle.plugins
        .filter((_, i) => mask & (1 << i))
        .map((p) => p.packageName)
        .sort()
      if (
        !bundle.checkedSets.some((set) => JSON.stringify([...set].sort()) === JSON.stringify(names))
      )
        throw new Error('Verified plugin combination missing')
    }
    this.bundle = bundle
  }

  async load(): Promise<unknown> {
    return (this.bundle?.plugins ?? []).map((plugin) => ({
      sourceId: plugin.packageName,
      name: plugin.name,
      description: plugin.description,
      revision: plugin.version,
      license: plugin.license,
      plugin: { packageName: plugin.packageName, version: plugin.version, warnings: [] },
    }))
  }

  available(packageName: string, version: string, installed: readonly InstalledPlugin[]): boolean {
    const plugin = this.bundle?.plugins.find(
      (row) => row.packageName === packageName && row.version === version
    )
    return (
      !!plugin &&
      pluginMetadataAvailable(
        plugin.metadata as PluginPackageMetadata,
        packageName,
        version,
        installed
      )
    )
  }

  cache(
    dataDirectory: string,
    plugins: readonly { packageName: string; version: string }[]
  ): PluginPackageCache | undefined {
    if (!this.bundle) return undefined
    let offline = true
    for (const plugin of plugins)
      if (
        !this.bundle.plugins.some(
          (row) => row.packageName === plugin.packageName && row.version === plugin.version
        )
      ) {
        if (!pluginSourceArchive(dataDirectory, plugin.packageName, plugin.version))
          throw new Error('插件不在当前安装包的已验证集合中。请先移除旧版插件。')
        offline = false
      }
    const root = join(dataDirectory, 'bundled-plugin-cache')
    const directory = join(root, this.digest)
    if (!existsSync(directory)) {
      mkdirSync(root, { recursive: true })
      const pending = join(root, randomUUID())
      mkdirSync(pending)
      for (const name of ['store', 'cache'])
        cpSync(join(this.directory, name), join(pending, name), {
          recursive: true,
          dereference: false,
        })
      renameSync(pending, directory)
    }
    return { directory, offline }
  }
}
