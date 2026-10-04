import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { redactPluginDiagnostic } from '../src/main/plugins/plugin-diagnostics'
import { DshCliRunner } from '../src/main/plugins/dsh-cli-runner'
import { runPluginDeveloperRequest } from '../src/main/plugins/plugin-dev'

test('redacts JSON, quoted and unquoted credentials and explicit secret values', () => {
  const message = `failed {"apiKey":"json-fixture", "access_token":"token-fixture"} api_key='quoted-fixture' password=plain-fixture Bearer bearer-fixture sk-key-fixture known-fixture`
  const redacted = redactPluginDiagnostic(message, ['known-fixture'])
  for (const secret of [
    'json-fixture',
    'token-fixture',
    'quoted-fixture',
    'plain-fixture',
    'bearer-fixture',
    'sk-key-fixture',
    'known-fixture',
  ]) {
    expect(redacted).not.toContain(secret)
  }
  expect(redacted).toContain('failed')
  expect(redactPluginDiagnostic('ordinary package failure')).toBe('ordinary package failure')
})

test('staging and developer failures persist only redacted diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-diagnostics-'))
  const dataDirectory = join(root, 'data'),
    resultFile = join(root, 'result.json'),
    requestFile = join(root, 'request.json')
  writeFileSync(
    requestFile,
    JSON.stringify({
      dataDirectory,
      resultFile,
      change: { kind: 'install', packageName: 'mindmesh-fixture-plugin', version: '1.0.0' },
    })
  )
  const run = vi
    .spyOn(DshCliRunner.prototype, 'run')
    .mockRejectedValue(new Error('fixture failed sk-key-fixture {"apiKey":"json-fixture"}'))
  try {
    const failure = await runPluginDeveloperRequest(
      requestFile,
      new AbortController().signal
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const staging = join(dataDirectory, 'plugin-staging')
    const records = readdirSync(staging).map((name) =>
      readFileSync(join(staging, name, 'result.json'), 'utf8')
    )
    expect(records).toHaveLength(1)
    const diagnostics = [...records, readFileSync(resultFile, 'utf8'), String(failure)].join('\n')
    expect(diagnostics).toContain('fixture failed')
    expect(diagnostics).toContain('[REDACTED]')
    expect(diagnostics).not.toContain('sk-key-fixture')
    expect(diagnostics).not.toContain('json-fixture')
  } finally {
    run.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
