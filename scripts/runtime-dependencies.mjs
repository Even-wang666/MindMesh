import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, isAbsolute, sep } from 'node:path'

// Reuse electron-builder's version validator; no extra runtime dependency is needed.
const require = createRequire(import.meta.url)
const { satisfies, valid } = createRequire(require.resolve('electron-builder/package.json'))('semver')

export { valid }

export function resolvePackageManifest(name, fromFile, boundary) {
  // Reading manifests directly also supports import-only/exports-restricted packages.
  for (const searchPath of createRequire(fromFile).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name, 'package.json')
    if (!existsSync(candidate)) continue
    const path = realpathSync(candidate)
    if (boundary) {
      const inside = relative(realpathSync(boundary), path)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (manifest.name === name) return path
  }
  return undefined
}

export function inspectRuntimeDependencies(roots, boundary, requiredOptional = new Set()) {
  const queue = [...roots]
  const packages = new Map()
  const errors = new Set()
  const optionalMissing = new Set()
  const installedOptional = new Set()
  while (queue.length) {
    const path = queue.pop()
    if (packages.has(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    packages.set(path, manifest)
    // A dependency and a peer can constrain the same package independently.
    const dependencies = Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
      .map(([name, range]) => [name, range, name in (manifest.optionalDependencies ?? {})])
    const peers = Object.entries(manifest.peerDependencies ?? {})
      .map(([name, range]) => [name, range, manifest.peerDependenciesMeta?.[name]?.optional === true])
    for (const [name, range, optional] of [...dependencies, ...peers]) {
      const dependency = resolvePackageManifest(name, path, boundary)
      if (!dependency) {
        const failures = optional && !requiredOptional.has(name) ? optionalMissing : errors
        failures.add(`${manifest.name}@${manifest.version} -> ${name}@${range}`)
        continue
      }
      const installed = JSON.parse(readFileSync(dependency, 'utf8'))
      if (name in (manifest.optionalDependencies ?? {})) installedOptional.add(name)
      if (!satisfies(installed.version, range)) errors.add(`${manifest.name}@${manifest.version} -> ${name}@${range}; installed ${installed.version}`)
      queue.push(dependency)
    }
  }
  return { packages, errors: [...errors], optionalMissing: [...optionalMissing], installedOptional }
}

export function dshDirectDependencies(manifest) {
  return Object.entries(manifest.dependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh') || name.startsWith('@deepseek-ai/cordis'))
}
