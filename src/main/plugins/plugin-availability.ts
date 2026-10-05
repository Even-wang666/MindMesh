import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getDshRuntimeInfo } from '../dsh-runtime'
import { validatePluginSpec, type InstalledPlugin } from './plugin-set'

// Metadata only. Opening Marketplace must never load third-party JavaScript.
export async function pluginAvailable(
  packageName: string,
  version: string,
  installed: readonly InstalledPlugin[],
  signal: AbortSignal,
  registry = 'https://registry.npmjs.org/'
): Promise<boolean> {
  validatePluginSpec(packageName, version)
  if (registry !== 'https://registry.npmjs.org/' && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(registry))
    throw new Error('Invalid plugin metadata registry')
  const response = await fetch(`${registry}${encodeURIComponent(packageName)}/${version}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    redirect: 'error',
  })
  if (!response.ok || !response.body) throw new Error('Plugin metadata unavailable')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) throw new Error('Plugin metadata too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return pluginMetadataAvailable(manifest, packageName, version, installed)
}

export type PluginPackageMetadata = {
  name?: unknown
  version?: unknown
  dsh?: { bundle?: { patch?: unknown } }
  scripts?: Record<string, unknown>
  os?: unknown
  cpu?: unknown
  engines?: { node?: unknown }
  peerDependencies?: Record<string, unknown>
  peerDependenciesMeta?: Record<string, { optional?: unknown }>
}

export function pluginMetadataAvailable(
  manifest: PluginPackageMetadata,
  packageName: string,
  version: string,
  installed: readonly InstalledPlugin[]
): boolean {
  return !pluginMetadataError(manifest, packageName, version, installed)
}

export function pluginMetadataError(
  manifest: PluginPackageMetadata,
  packageName: string,
  version: string,
  installed: readonly InstalledPlugin[]
): string | undefined {
  validatePluginSpec(packageName, version)
  if (
    manifest?.name !== packageName ||
    manifest.version !== version ||
    typeof manifest.dsh?.bundle?.patch !== 'string' ||
    !manifest.dsh.bundle.patch
  )
    return '插件包名称、确切版本或 DSH bundle 声明无效。'
  if (['preinstall', 'install', 'postinstall', 'prepare'].some((name) => manifest.scripts?.[name]))
    return '插件需要执行安装或构建脚本，请提供已构建的插件。'
  for (const [field, target] of [
    ['os', process.platform],
    ['cpu', process.arch],
  ] as const) {
    const values = manifest[field]
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    )
      return `插件 ${field} 平台要求格式无效。`
    if (
      values?.includes(`!${target}`) ||
      (values?.some((value: string) => !value.startsWith('!')) &&
        !values.includes(target) &&
        !values.includes('any'))
    )
      return `插件不支持当前 ${field}：${target}。`
  }
  const require = createRequire(getDshRuntimeInfo().dshBin)
  const { satisfies } = require('semver') as {
    satisfies(version: string, range: string, options: { includePrerelease: boolean }): boolean
  }
  const matches = (actual: string, range: unknown) =>
    typeof range === 'string' && satisfies(actual, range, { includePrerelease: true })
  if (
    manifest.engines?.node !== undefined &&
    !matches(process.versions.node, manifest.engines.node)
  )
    return `Node 版本不兼容：插件要求 ${String(manifest.engines.node)}，当前 ${process.versions.node}。`
  const peers = manifest.peerDependencies ?? {}
  if (!peers || typeof peers !== 'object' || Array.isArray(peers))
    return '插件 peerDependencies 格式无效。'
  for (const [name, range] of Object.entries(peers)) {
    validatePluginSpec(name, '0.0.0')
    let selected = installed.find(
      (plugin) => plugin.enabled && plugin.packageName === name
    )?.version
    if (!selected) {
      for (const directory of require.resolve.paths(name) ?? []) {
        const file = join(directory, name, 'package.json')
        if (existsSync(file)) {
          selected = JSON.parse(readFileSync(file, 'utf8')).version
          break
        }
      }
    }
    if (!selected && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
    if (!selected || !matches(selected, range))
      return `依赖不兼容：${name} 要求 ${String(range)}，当前 ${selected ?? '未安装或未启用'}。`
  }
  return undefined
}
