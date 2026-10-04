import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import {
  BundledPackageManager,
  DshCliRunner,
  stagingEnvironment,
} from '../src/main/plugins/dsh-cli-runner'

test('controlled process environment excludes credentials and user bootstrap overrides', () => {
  const env = stagingEnvironment('/staging')
  expect(env.DEEPSEEK_API_KEY).toBe('mindmesh-staging-placeholder')
  for (const name of [
    'OPENAI_API_KEY',
    'NODE_OPTIONS',
    'MINDMESH_CUSTOM_API_KEY',
    'ANTHROPIC_API_KEY',
    'NPM_TOKEN',
  ])
    expect(env[name]).toBeUndefined()
  expect(env.HOME).toBe('/staging')
})

test('redacts split credentials from diagnostics and rejected errors while retaining useful output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-runner-'))
  try {
    const bin = join(root, 'bin.mjs'),
      log = join(root, 'logs', 'redacted.log')
    writeFileSync(
      bin,
      `export async function runCli() {
      process.stdout.write('failure sk-fixture');
      await new Promise(resolve => setTimeout(resolve, 50));
      process.stdout.write('-credential\\n');
      process.stderr.write(JSON.stringify({apiKey: 'json-fixture', token: 'token-fixture'}) + '\\nBearer bearer-fixture\\n' + process.env.CUSTOM_API_KEY);
      process.exitCode = 1;
    }`
    )
    const runner = new DshCliRunner(bin, new BundledPackageManager())
    const error = await runner
      .run({
        args: [],
        cwd: root,
        env: { ...stagingEnvironment(root), CUSTOM_API_KEY: 'env-fixture' },
        log,
      })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    const diagnostics = readFileSync(log, 'utf8') + String(error)
    for (const secret of [
      'sk-fixture-credential',
      'json-fixture',
      'token-fixture',
      'bearer-fixture',
      'env-fixture',
    ]) {
      expect(diagnostics).not.toContain(secret)
    }
    expect(diagnostics).toContain('failure')
    expect(diagnostics).toContain('[REDACTED]')
    writeFileSync(
      bin,
      `export async function runCli() { console.log('{"apiKey":"success-fixture"}'); }`
    )
    const successLog = join(root, 'logs', 'success.log')
    const output = await runner.run({
      args: [],
      cwd: root,
      env: stagingEnvironment(root),
      log: successLog,
    })
    expect(JSON.parse(output)).toEqual({ apiKey: 'success-fixture' })
    expect(readFileSync(successLog, 'utf8')).not.toContain('success-fixture')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('timeout and active cancellation stop the owned process and do not accept partial initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-runner-'))
  try {
    const bin = join(root, 'bin.mjs')
    writeFileSync(
      bin,
      'export async function runCli() { setInterval(() => {}, 1000); await new Promise(() => {}) }'
    )
    mkdirSync(join(root, 'tmp'))
    const runner = new DshCliRunner(bin, new BundledPackageManager())
    const options = {
      args: [],
      cwd: root,
      env: stagingEnvironment(root),
      log: join(root, 'logs', 'timeout.log'),
      timeoutMs: 300,
    }
    await expect(runner.run(options)).rejects.toThrow('timed out')
    const controller = new AbortController()
    const pending = runner.run({ ...options, timeoutMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toThrow('cancelled')
    writeFileSync(
      bin,
      'export async function runCli() { console.log("output"); setInterval(() => {}, 1000); await new Promise(() => {}) }'
    )
    const invalidLog = join(root, 'logs', 'directory.log')
    mkdirSync(invalidLog)
    await expect(runner.run({ ...options, log: invalidLog, timeoutMs: 10_000 })).rejects.toThrow(
      'diagnostic log write failed'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
