import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const root = resolve(import.meta.dirname, '..')
const dshHome = resolve(root, '.runtime', 'harness-smoke')
await mkdir(dshHome, { recursive: true })

const harness = new DeepSeekHarness({
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: root,
  processCwd: root,
  dshHome,
  initializeTimeoutMs: 30_000,
  env: { ...process.env, DSH_HOME: dshHome },
})

try {
  await harness.start()
  console.log('DeepSeek Harness SDK handshake: OK')
} finally {
  await harness.close()
  console.log('DeepSeek Harness subprocess shutdown: OK')
}
