import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { BundledPackageManager, DshCliRunner, stagingEnvironment } from '../src/main/plugins/dsh-cli-runner'

test('controlled process environment excludes credentials and user bootstrap overrides', () => {
  const env = stagingEnvironment('/staging')
  expect(env.DEEPSEEK_API_KEY).toBe('mindmesh-staging-placeholder')
  for (const name of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'MINDMESH_CUSTOM_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN']) expect(env[name]).toBeUndefined()
  expect(env.HOME).toBe('/staging')
})

test('timeout and active cancellation stop the owned process and do not accept partial initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-runner-'))
  try {
    const bin = join(root, 'bin.mjs')
    writeFileSync(bin, 'export async function runCli() { setInterval(() => {}, 1000); await new Promise(() => {}) }')
    mkdirSync(join(root, 'tmp'))
    const runner = new DshCliRunner(bin, new BundledPackageManager())
    const options = { args: [], cwd: root, env: stagingEnvironment(root), log: join(root, 'logs', 'timeout.log'), timeoutMs: 300 }
    await expect(runner.run(options)).rejects.toThrow('timed out')
    const controller = new AbortController()
    const pending = runner.run({ ...options, timeoutMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toThrow('cancelled')
    writeFileSync(bin, 'export async function runCli() { console.log("output"); setInterval(() => {}, 1000); await new Promise(() => {}) }')
    const invalidLog = join(root, 'logs', 'directory.log'); mkdirSync(invalidLog)
    await expect(runner.run({ ...options, log: invalidLog, timeoutMs: 10_000 })).rejects.toThrow('diagnostic log write failed')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15_000)
