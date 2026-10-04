import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { startPluginFixtureRegistry } from './plugin-fixture-registry.mjs'
import { startPluginModelFixture } from './plugin-model-fixture.mjs'

const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-smoke-'))
const registry = await startPluginFixtureRegistry(root)
const model = await startPluginModelFixture()
const exe = process.env.MINDMESH_PLUGIN_SMOKE_EXE ?? resolve('node_modules/electron/dist/electron.exe')
const packaged = Boolean(process.env.MINDMESH_PLUGIN_SMOKE_EXE)
let count = 0
async function run(change, permission) {
  const requestFile = join(root, `request-${++count}.json`), resultFile = join(root, `result-${count}.json`)
  writeFileSync(requestFile, JSON.stringify({ dataDirectory: join(root, 'data'), resultFile, fixtureRegistry: registry.url, change,
    ...(permission ? { runtime: { permission, baseUrl: model.url } } : {}) }))
  await new Promise((resolveRun, reject) => {
    const env = { ...process.env, PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exe, [...(packaged ? [] : ['.']), `--user-data-dir=${join(root, 'electron-profile')}`, `--plugin-dev=${requestFile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    child.stdout.on('data', (data) => { tail = (tail + data).slice(-8192) })
    child.stderr.on('data', (data) => { tail = (tail + data).slice(-8192) })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Plugin smoke timed out')) }, 180_000)
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error(`Plugin developer CLI exited ${code}: ${tail}`)) })
  })
  return JSON.parse(readFileSync(resultFile, 'utf8'))
}
try {
  const installed = await run({ kind: 'install', packageName: 'mindmesh-fixture-plugin', version: '1.0.0' })
  assert.equal(installed.ok, true); assert.equal(installed.generation, 1)
  assert.match(readFileSync(join(installed.artifact.directory, 'pnpm-lock.yaml'), 'utf8'), /1\.0\.0/)
  assert.equal((await run()).revision, installed.revision)
  assert.equal((await run({ kind: 'disable', packageName: 'mindmesh-fixture-plugin' })).plugins[0].enabled, false)
  assert.equal((await run({ kind: 'enable', packageName: 'mindmesh-fixture-plugin' })).plugins[0].enabled, true)
  const full = await run(undefined, 'full')
  assert.equal(full.ok, true); assert.match(full.runtime.text, /fixture:1\.0\.0/)
  assert.equal(existsSync(join(root, 'tool-called-1.0.0')), true)
  assert.equal((await run(undefined, 'full')).runtime.key, full.runtime.key)
  for (const permission of ['chat', 'workspace']) {
    const core = await run(undefined, permission)
    assert.equal(core.runtime.text, 'core-without-plugin')
    assert.equal(existsSync(join(root, 'data', 'runtime-v2', core.runtime.key, 'profiles', 'sdk', 'node_modules', 'mindmesh-fixture-plugin')), false)
  }
  await run({ kind: 'update', packageName: 'mindmesh-fixture-plugin', version: '1.0.1' })
  const updated = await run(undefined, 'full')
  assert.notEqual(updated.runtime.key, full.runtime.key); assert.match(updated.runtime.text, /fixture:1\.0\.1/)
  await run({ kind: 'remove', packageName: 'mindmesh-fixture-plugin' })
  assert.equal((await run(undefined, 'full')).runtime.text, 'core-without-plugin')
  assert.equal(existsSync(join(root, 'script-ran')), false)
  console.log(JSON.stringify({ mode: packaged ? 'packaged' : 'development', externalPnpm: false, install: 'passed', restart: 'passed', disableEnable: 'passed', realTool: 'passed', coreIsolation: 'passed', updateRemove: 'passed' }))
} finally {
  await registry.close()
  await model.close()
  const delta = relative(tmpdir(), root)
  if (!delta.startsWith('mindmesh-plugin-smoke-') || delta.includes('..') || isAbsolute(delta)) throw new Error('Unsafe smoke cleanup path')
  rmSync(root, { recursive: true, force: true })
}
