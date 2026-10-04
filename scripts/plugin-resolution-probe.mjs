import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Executed in the controlled staging child, not in the application process.
const [dshBin, profileDir, home] = process.argv.slice(2)
const anchor = join(dirname(dshBin), '..', 'package.json')
const require = createRequire(anchor)
const { satisfies } = require('semver') // Already carried by the exact DSH installation.
const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const profile = boot.loadProfileDirectory('mindmesh', profileDir, anchor)
if (profile.skippedBundles.length) throw new Error(`Skipped bundle: ${JSON.stringify(profile.skippedBundles)}`)
const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home })
const fallback = new Map(resolution.entries.map((entry) => [entry.name, entry.packageDir]))
const visited = new Set(), packages = [], peers = []
function resolvePeer(name, from) {
  for (const search of createRequire(from).resolve.paths(name) ?? []) {
    const candidate = join(search, name, 'package.json')
    if (existsSync(candidate)) return candidate
  }
  const directory = fallback.get(name)
  return directory && join(directory, 'package.json')
}
function inspect(directory) {
  if (!existsSync(directory)) return
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.name === '.bin') continue
    const path = join(directory, item.name)
    if (item.name.startsWith('@') || item.name === '.pnpm') { inspect(path); continue }
    if (!item.isDirectory() && !item.isSymbolicLink()) continue
    const actual = realpathSync(path)
    if (visited.has(actual)) continue
    visited.add(actual)
    const file = join(actual, 'package.json')
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      packages.push({ name: manifest.name, version: manifest.version })
      for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        const selected = resolvePeer(name, file)
        if (!selected && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
        const version = selected && JSON.parse(readFileSync(selected, 'utf8')).version
        if (!version || !satisfies(version, range, { includePrerelease: true })) throw new Error(`Plugin peer conflict: ${manifest.name} requires ${name}@${range}, selected ${version ?? 'missing'}`)
        peers.push({ declarer: `${manifest.name}@${manifest.version}`, name, range, version })
      }
    }
    inspect(join(actual, 'node_modules'))
  }
}
inspect(join(profileDir, 'node_modules'))
process.stdout.write(JSON.stringify({ packages: packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)), peers,
  resolution: resolution.entries.map(({ name, version, scope }) => ({ name, version, scope })) }) + '\n')
