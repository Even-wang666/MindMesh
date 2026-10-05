import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { BundledPluginLibrary, packageCacheEnvironment } from '../src/main/plugins/bundled-plugins'
import { MarketplaceCatalogService } from '../src/main/marketplace'

test('only validated matching release combinations are discoverable offline; old upstream caches do not return', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-bundled-plugins-'))
  const runtimeRoot = join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh')
  const bundleRoot = join(root, 'verified-plugins')
  mkdirSync(runtimeRoot, { recursive: true })
  writeFileSync(
    join(runtimeRoot, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' })
  )
  for (const name of ['store', 'cache']) {
    mkdirSync(join(bundleRoot, name), { recursive: true })
    writeFileSync(join(bundleRoot, name, 'payload'), 'bundled')
  }
  const bundle = {
    schema: 1,
    runtimeVersion: '0.2.0-rc.2',
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    checkedSets: [['test-plugin']],
    plugins: [
      {
        packageName: 'test-plugin',
        version: '1.0.0',
        name: 'Test',
        description: '',
        license: 'MIT',
        metadata: {
          name: 'test-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: './patch.yml' } },
        },
      },
    ],
  }
  const save = () => writeFileSync(join(bundleRoot, 'catalog.json'), JSON.stringify(bundle))
  const network = vi.fn(() => {
    throw new Error('network must not run')
  })
  vi.stubGlobal('fetch', network)
  try {
    save()
    const library = new BundledPluginLibrary(root)
    const data = join(root, 'data')
    mkdirSync(join(data, 'marketplace-cache'), { recursive: true })
    writeFileSync(
      join(data, 'marketplace-cache', 'plugins.json'),
      JSON.stringify({
        kind: 'plugins',
        fetchedAt: new Date().toISOString(),
        items: [
          {
            source: 'dsh',
            sourceId: 'unverified-plugin',
            name: 'Unverified',
            plugin: { packageName: 'unverified-plugin', version: '1.0.0' },
          },
        ],
      })
    )
    expect(
      (await new MarketplaceCatalogService(data, [library]).list('plugins')).items.map(
        (row) => row.sourceId
      )
    ).toEqual(['test-plugin'])
    expect(library.available('test-plugin', '1.0.0', [])).toBe(true)
    expect(library.available('unverified-plugin', '1.0.0', [])).toBe(false)
    const cache = library.cache(data, [{ packageName: 'test-plugin', version: '1.0.0' }])!
    expect(packageCacheEnvironment(cache).pnpm_config_offline).toBe('true')
    expect(readFileSync(join(cache.directory, 'store', 'payload'), 'utf8')).toBe('bundled')
    expect(() =>
      library.cache(data, [{ packageName: 'unverified-plugin', version: '1.0.0' }])
    ).toThrow('已验证集合')
    expect(network).not.toHaveBeenCalled()
    bundle.checkedSets = []
    save()
    expect(() => new BundledPluginLibrary(root)).toThrow('combination missing')
    bundle.checkedSets = [['test-plugin']]
    bundle.nodeVersion = '1.0.0'
    save()
    expect(() => new BundledPluginLibrary(root)).toThrow('does not match')
  } finally {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  }
})
