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
  if (
    manifest?.name !== packageName ||
    manifest.version !== version ||
    typeof manifest.dsh?.bundle?.patch !== 'string' ||
    !manifest.dsh.bundle.patch
  )
    return false
  if (['preinstall', 'install', 'postinstall', 'prepare'].some((name) => manifest.scripts?.[name]))
    return false
  for (const [field, target] of [
    ['os', process.platform],
    ['cpu', process.arch],
  ] as const) {
    const values = manifest[field]
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    )
      return false
    if (
      values?.includes(`!${target}`) ||
      (values?.some((value: string) => !value.startsWith('!')) &&
        !values.includes(target) &&
        !values.includes('any'))
    )
      return false
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
    return false
  const peers = manifest.peerDependencies ?? {}
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return false
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
    if (!selected || !matches(selected, range)) return false
  }
  return true
}
