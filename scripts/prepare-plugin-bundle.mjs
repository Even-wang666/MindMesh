import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { extract } from 'tar'
import checkPluginBundle from './check-plugin-bundle.cjs'

const root = resolve('.runtime', `plugin-build-${randomUUID()}`)
const output = join(root, 'bundle')
mkdirSync(output, { recursive: true })
const candidates = JSON.parse(readFileSync('resources/plugins/candidates.json', 'utf8'))
if (!Array.isArray(candidates) || !candidates.length || candidates.length > 4)
  throw new Error('Plugin bundle requires 1–4 pinned candidates')
const exe = resolve('node_modules/electron/dist/electron.exe')
let sequence = 0
async function validate(dataDirectory, candidate, offline) {
  const requestFile = join(root, `request-${++sequence}.json`)
  const resultFile = join(root, `result-${sequence}.json`)
  writeFileSync(
    requestFile,
    JSON.stringify({
      dataDirectory,
      resultFile,
      packageCache: { directory: output, offline },
      change: { kind: 'install', packageName: candidate.packageName, version: candidate.version },
    })
  )
  await new Promise((done, reject) => {
    const env = { ...process.env, PATH: join(process.env.SystemRoot, 'System32') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(
      exe,
      ['.', `--user-data-dir=${join(root, 'electron-profile')}`, `--plugin-dev=${requestFile}`],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let tail = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        tail = (tail + data).slice(-8192)
      })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Plugin release validation timed out'))
    }, 180_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? done() : reject(new Error(`Plugin release validation failed: ${tail}`))
    })
  })
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  if (!result.ok) throw new Error(result.error)
  const lock = parse(readFileSync(join(result.artifact.directory, 'pnpm-lock.yaml'), 'utf8'))
  const entry = lock.packages[`${candidate.packageName}@${candidate.version}`]
  if (entry?.resolution?.integrity !== candidate.integrity)
    throw new Error(`Pinned tarball integrity mismatch: ${candidate.packageName}`)
  return result
}

if (process.platform !== 'win32')
  throw new Error('Release plugin verification requires Windows Electron')
const plugins = []
let runtime
for (const candidate of candidates) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(candidate.packageName)}/${candidate.version}`,
    { signal: AbortSignal.timeout(10_000), redirect: 'error' }
  )
  if (!response.ok) throw new Error(`Candidate metadata unavailable: ${candidate.packageName}`)
  const metadata = await response.json()
  if (
    metadata.name !== candidate.packageName ||
    metadata.version !== candidate.version ||
    metadata.license !== candidate.license ||
    metadata.dist?.integrity !== candidate.integrity
  )
    throw new Error(`Candidate identity/license/integrity mismatch: ${candidate.packageName}`)
  runtime = await validate(join(root, `individual-${plugins.length}`), candidate, false)
  const payload = Buffer.from(
    await (
      await fetch(metadata.dist.tarball, {
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      })
    ).arrayBuffer()
  )
  if (`sha512-${createHash('sha512').update(payload).digest('base64')}` !== candidate.integrity)
    throw new Error('Plugin license payload integrity mismatch')
  const archive = join(root, `license-${plugins.length}.tgz`)
  writeFileSync(archive, payload)
  const licenseRoot = join(output, 'licenses', candidate.packageName.replaceAll('/', '__'))
  mkdirSync(licenseRoot, { recursive: true })
  await extract({
    file: archive,
    cwd: licenseRoot,
    strip: 1,
    filter: (path) => /^package\/(LICENSE(?:\.md|\.txt)?|THIRD_PARTY_NOTICES\.md)$/i.test(path),
  })
  if (!existsSync(join(licenseRoot, 'LICENSE'))) throw new Error('Bundled plugin license missing')
  plugins.push({ ...candidate, metadata })
  console.log(`Release SDK validation passed: ${candidate.packageName}@${candidate.version}`)
}
const checkedSets = []
for (let mask = 1; mask < 2 ** plugins.length; mask++) {
  const selected = plugins.filter((_, i) => mask & (1 << i))
  for (const plugin of selected)
    runtime = await validate(join(root, `offline-set-${mask}`), plugin, true)
  checkedSets.push(selected.map((plugin) => plugin.packageName))
  console.log(`Offline complete-set SDK validation passed: ${checkedSets.at(-1).join(', ')}`)
}
mkdirSync(join(output, 'cache'), { recursive: true })
if (!existsSync(join(output, 'store'))) throw new Error('Offline dependency store missing')
writeFileSync(
  join(output, 'catalog.json'),
  JSON.stringify(
    {
      schema: 1,
      validationHash: checkPluginBundle.validationHash(process.cwd()),
      electronVersion: JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8'))
        .version,
      runtimeVersion: runtime.runtimeVersion,
      nodeVersion: runtime.nodeVersion,
      platform: process.platform,
      arch: process.arch,
      plugins,
      checkedSets,
    },
    null,
    2
  )
)
const destination = resolve('.runtime', 'verified-plugins')
if (existsSync(destination))
  renameSync(destination, resolve('.runtime', `previous-plugins-${randomUUID()}`))
renameSync(output, destination)
console.log(`Verified offline plugin bundle ready: ${destination}`)
