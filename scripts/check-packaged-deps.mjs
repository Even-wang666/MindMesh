import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packaged = join(root, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules')
const queue = [realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'))]
const seen = new Map()
const unresolved = new Set()

function packageRoot(file) {
  let directory = dirname(file)
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory
    directory = dirname(directory)
  }
  throw new Error(`无法定位 package.json: ${file}`)
}

while (queue.length) {
  const directory = queue.pop()
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (!manifest.name) { unresolved.add(`unnamed package: ${directory}`); continue }
  if (seen.has(manifest.name)) continue
  seen.set(manifest.name, directory)
  const requireFromPackage = createRequire(join(directory, 'package.json'))
  for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
    try {
      let file
      try { file = requireFromPackage.resolve(`${name}/package.json`) }
      catch { file = requireFromPackage.resolve(name) }
      queue.push(realpathSync(packageRoot(file)))
    } catch {
      unresolved.add(`${manifest.name} -> ${name}`)
    }
  }
}

const missing = [...seen.keys()].filter((name) => !existsSync(join(packaged, name, 'package.json')))
console.log(`Runtime packages: ${seen.size}; missing from unpacked app: ${missing.length}`)
missing.forEach((name) => console.log(`${name}@${JSON.parse(readFileSync(join(seen.get(name), 'package.json'), 'utf8')).version}`))
if (unresolved.size) console.log(`Unresolved locally: ${[...unresolved].join(', ')}`)
if (missing.length) process.exitCode = 1
