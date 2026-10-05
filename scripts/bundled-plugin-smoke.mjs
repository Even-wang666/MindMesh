import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { startPluginModelFixture } from './plugin-model-fixture.mjs'

const root = mkdtempSync(join(tmpdir(), 'mindmesh-bundled-smoke-'))
const exe =
  process.env.MINDMESH_PLUGIN_SMOKE_EXE ?? resolve('node_modules/electron/dist/electron.exe')
const packaged = Boolean(process.env.MINDMESH_PLUGIN_SMOKE_EXE)
const model = await startPluginModelFixture({
  toolName: 'curl_parse',
  toolArguments: { curl: 'curl https://example.com', execute: false },
})
let count = 0
async function run(change, permission) {
  const requestFile = join(root, `request-${++count}.json`),
    resultFile = join(root, `result-${count}.json`)
  writeFileSync(
    requestFile,
    JSON.stringify({
      dataDirectory: join(root, 'data'),
      resultFile,
      change,
      ...(permission ? { runtime: { permission, baseUrl: model.url } } : {}),
    })
  )
  await new Promise((done, reject) => {
    const env = { ...process.env, PATH: join(process.env.SystemRoot, 'System32') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(
      exe,
      [
        ...(packaged ? [] : ['.']),
        `--user-data-dir=${join(root, 'electron-profile')}`,
        `--plugin-dev=${requestFile}`,
      ],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let tail = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        tail = (tail + data).slice(-8192)
      })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Bundled plugin smoke timed out'))
    }, 180_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? done() : reject(new Error(tail))
    })
  })
  return JSON.parse(readFileSync(resultFile, 'utf8'))
}
try {
  const installed = await run({ kind: 'install', packageName: 'dsh-http-tools', version: '0.1.5' })
  assert.equal(installed.ok, true)
  assert.equal(installed.plugins.length, 1)
  const full = await run(undefined, 'full')
  assert.equal(full.ok, true)
  assert.match(full.runtime.text, /example\.com/)
  assert.ok(
    model.requests.some((request) => JSON.stringify(request.messages).includes('example.com'))
  )
  assert.equal((await run(undefined, 'full')).runtime.key, full.runtime.key)
  const core = await run(undefined, 'workspace')
  assert.equal(core.runtime.text, 'core-without-plugin')
  assert.equal(
    existsSync(
      join(
        root,
        'data',
        'runtime-v2',
        core.runtime.key,
        'profiles',
        'sdk',
        'node_modules',
        'dsh-http-tools'
      )
    ),
    false
  )
  await run({ kind: 'disable', packageName: 'dsh-http-tools' })
  assert.equal((await run(undefined, 'full')).runtime.text, 'core-without-plugin')
  await run({ kind: 'enable', packageName: 'dsh-http-tools' })
  assert.match((await run(undefined, 'full')).runtime.text, /example\.com/)
  await run({ kind: 'remove', packageName: 'dsh-http-tools' })
  assert.equal((await run()).plugins.length, 0)
  console.log(
    JSON.stringify({
      bundledOfflineInstall: 'passed',
      realCurlParse: 'passed',
      restart: 'passed',
      coreIsolation: 'passed',
      disableEnableRemove: 'passed',
    })
  )
} finally {
  await model.close()
  const delta = relative(tmpdir(), root)
  if (!delta.startsWith('mindmesh-bundled-smoke-') || delta.includes('..') || isAbsolute(delta))
    // biome-ignore lint/correctness/noUnsafeFinally: Refuse cleanup outside the owned temporary directory.
    throw new Error('Unsafe bundled smoke cleanup path')
  rmSync(root, { recursive: true, force: true })
}
