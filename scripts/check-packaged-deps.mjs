import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshDirectDependencies, inspectRuntimeDependencies, resolvePackageManifest } from './runtime-dependencies.mjs'

const root = resolve(import.meta.dirname, '..')
const packaged = join(root, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules')
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const roots = []
const installedRoots = []
const failures = []
// Browser MCP is inserted by MindMesh, so it is outside DSH's own dependency tree.
for (const [name, expected] of [...dshDirectDependencies(project), ['@playwright/mcp', project.dependencies['@playwright/mcp']]]) {
  const manifestPath = resolvePackageManifest(name, join(packaged, '__check__.cjs'), packaged)
  if (!manifestPath) { failures.push(`Missing packaged direct dependency: ${name}@${expected}`); continue }
  const installedPath = resolvePackageManifest(name, join(root, 'package.json'))
  if (installedPath) installedRoots.push(installedPath)
  const bundledVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version
  const installedVersion = installedPath && JSON.parse(readFileSync(installedPath, 'utf8')).version
  if (bundledVersion !== installedVersion) failures.push(`${name}: packaged ${bundledVersion}, installed ${installedVersion}`)
  roots.push(manifestPath)
}
// Native payloads are npm-optional across platforms but required on this machine.
const installedGraph = inspectRuntimeDependencies(installedRoots)
failures.push(...installedGraph.errors)
const graph = inspectRuntimeDependencies(roots, packaged, installedGraph.installedOptional)
failures.push(...graph.errors)
console.log(`Packaged runtime instances: ${graph.packages.size}; required failures: ${failures.length}; absent optional dependencies: ${graph.optionalMissing.length}`)
failures.forEach((failure) => console.error(failure))
graph.optionalMissing.forEach((dependency) => console.log(`Optional, not shipped: ${dependency}`))
if (failures.length) process.exitCode = 1
