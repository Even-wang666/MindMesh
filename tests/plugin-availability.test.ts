import { afterEach, expect, test, vi } from 'vitest'
import { pluginAvailable } from '../src/main/plugins/plugin-availability'

afterEach(() => vi.unstubAllGlobals())
const manifest = {
  name: 'fixture-plugin',
  version: '1.0.0',
  dsh: { bundle: { patch: './patch.yml' } },
}
function response(value: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(value)))
  )
}
const inspect = () => pluginAvailable('fixture-plugin', '1.0.0', [], new AbortController().signal)
test('only exact metadata with a supported runtime, platform and no build hooks is eligible', async () => {
  response({ ...manifest, peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } })
  expect(await inspect()).toBe(true)
  for (const row of [
    { ...manifest, version: '1.0.1' },
    { ...manifest, dsh: {} },
    { ...manifest, scripts: { postinstall: 'execute-third-party-code' } },
    { ...manifest, peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.5-rc.1' } },
    { ...manifest, peerDependencies: { 'missing-required-fixture': '^1.0.0' } },
    { ...manifest, os: [`!${process.platform}`] },
    { ...manifest, cpu: ['unsupported-cpu'] },
    { ...manifest, engines: { node: '>=999' } },
  ]) {
    response(row)
    expect(await inspect()).toBe(false)
  }
})
test('enabled peer plugins satisfy requirements; disabled peers do not', async () => {
  response({ ...manifest, peerDependencies: { 'fixture-peer': '^1.0.0' } })
  const peer = {
    packageName: 'fixture-peer',
    version: '1.0.0',
    enabled: true,
    config: {},
    installedAt: '',
    updatedAt: '',
  }
  expect(
    await pluginAvailable('fixture-plugin', '1.0.0', [peer], new AbortController().signal)
  ).toBe(true)
  expect(
    await pluginAvailable(
      'fixture-plugin',
      '1.0.0',
      [{ ...peer, enabled: false }],
      new AbortController().signal
    )
  ).toBe(false)
})
test('bounds remote metadata and refuses path traversal in peer names or registry overrides', async () => {
  response({ ...manifest, peerDependencies: { '../../package': '*' } })
  await expect(inspect()).rejects.toThrow('npm package name')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1)))
  )
  await expect(inspect()).rejects.toThrow('too large')
  await expect(
    pluginAvailable(
      'fixture-plugin',
      '1.0.0',
      [],
      new AbortController().signal,
      'https://arbitrary.invalid/'
    )
  ).rejects.toThrow('registry')
})
