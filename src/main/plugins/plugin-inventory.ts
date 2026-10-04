import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export function pluginPackageDigests(modules: string): Array<{ name: string; version: string; manifestDigest: string }> {
  const packages: Array<{ name: string; version: string; manifestDigest: string }> = []
  const seen = new Set<string>()
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.dsh-module-fallback') continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('@') || entry.name === '.pnpm') { visit(path); continue }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const actual = realpathSync(path)
      if (seen.has(actual)) continue
      seen.add(actual)
      const manifestPath = join(actual, 'package.json')
      if (existsSync(manifestPath)) {
        const text = readFileSync(manifestPath, 'utf8'), manifest = JSON.parse(text)
        // Install scripts must never run automatically; reject even if ignore-scripts allowed installation.
        if (['preinstall', 'install', 'postinstall', 'prepare'].some((name) => manifest.scripts?.[name]) || existsSync(join(actual, 'binding.gyp'))) throw new Error(`Plugin build script requires approval: ${manifest.name}`)
        packages.push({ name: manifest.name, version: manifest.version, manifestDigest: createHash('sha256').update(text).digest('hex') })
      }
      visit(join(actual, 'node_modules'))
    }
  }
  visit(modules)
  return packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}
