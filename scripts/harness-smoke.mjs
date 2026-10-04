import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
// Point at the unpacked node_modules to exercise the shipped client and runtime together.
const runtimeRoot = process.env.MINDMESH_SMOKE_RUNTIME_ROOT
const { DeepSeekHarness } = await import(
  runtimeRoot
    ? pathToFileURL(join(runtimeRoot, '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')).href
    : '@deepseek-ai/dsh-sdk-client'
)
const dshHome = await mkdtemp(join(tmpdir(), 'mindmesh-harness-smoke-'))
const systemNames = new Set([
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'OS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
])
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && systemNames.has(name.toUpperCase())
  )
)

const harness = new DeepSeekHarness({
  ...(runtimeRoot ? { dshBin: join(runtimeRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js') } : {}),
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: root,
  processCwd: root,
  dshHome,
  initializeTimeoutMs: 30_000,
  // Initialize needs a configured route, but this smoke never sends a model request.
  env: {
    ...env,
    DEEPSEEK_API_KEY: 'mindmesh-keyless-smoke',
    DSH_HOME: dshHome,
    ELECTRON_RUN_AS_NODE: '1',
  },
})

try {
  await harness.start()
  console.log('DeepSeek Harness SDK handshake: OK')
} finally {
  await harness.close()
  console.log('DeepSeek Harness subprocess shutdown: OK')

  if (!resolve(dshHome).startsWith(resolve(tmpdir()) + sep)) {
    // biome-ignore lint/correctness/noUnsafeFinally: Refuse recursive cleanup outside the verified temporary directory, even after an earlier failure.
    throw new Error('Unexpected smoke directory')
  }
  await rm(dshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
