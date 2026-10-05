import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { MarketplaceCatalogService, normalizeMarketplaceItems } from '../src/main/marketplace'
import {
  DshPluginCatalogProvider,
  PluginMarketplaceService,
} from '../src/main/plugins/plugin-marketplace'
import { PluginManager, PluginStaging } from '../src/main/plugins/plugin-manager'
import { PluginSetManager, pluginSetRevision } from '../src/main/plugins/plugin-set'
import { marketplaceKey } from '../src/shared/marketplace'
import type { PluginAction } from '../src/shared/plugins'

const roots: string[] = []
const key = marketplaceKey({ kind: 'plugins', source: 'dsh', sourceId: 'fixture-plugin' })
function setup() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            name: 'fixture-plugin',
            version: url.split('/').at(-1),
            dsh: { bundle: { patch: './patch.yml' } },
          })
        )
    )
  )
  const path = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-market-test-'))
  roots.push(path)
  const db = new MindMeshDatabase(join(path, 'db.sqlite'))
  const set = new PluginSetManager(db),
    staging = new PluginStaging(path)
  const validate = vi
    .spyOn(staging, 'validate')
    .mockImplementation(async (plugins, signal, progress) => {
      signal?.throwIfAborted()
      progress?.('preparing')
      progress?.('booting')
      return { revision: pluginSetRevision(plugins), directory: path, digest: 'a'.repeat(64) }
    })
  let version = '1.0.0'
  const load = vi.fn(async () => [
    {
      sourceId: 'fixture-plugin',
      name: 'Fixture',
      plugin: { packageName: 'fixture-plugin', version, warnings: [] },
    },
  ])
  const catalog = new MarketplaceCatalogService(path, [{ kind: 'plugins', source: 'dsh', load }])
  const manager = new PluginManager(set, staging),
    notify = vi.fn()
  const service = new PluginMarketplaceService(path, catalog, manager, notify, '0.2.0-rc.2')
  const request = (action: PluginAction, target = version) => ({
    requestId: randomUUID(),
    key,
    action,
    ...(['check', 'install', 'update'].includes(action) ? { version: target } : {}),
  })
  return {
    path,
    db,
    set,
    validate,
    catalog,
    manager,
    service,
    notify,
    request,
    updateCatalog: async () => {
      version = '1.0.1'
      await catalog.list('plugins', true)
    },
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture path')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('plugin catalog and controlled Marketplace actions', () => {
  it('caches hidden unsupported entries and does not rescan or notify in a loop', async () => {
    const { db, path, service, manager, catalog, validate, notify } = setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              name: 'fixture-plugin',
              version: '1.0.0',
              dsh: { bundle: { patch: './patch.yml' } },
              scripts: { install: 'must-not-execute' },
            })
          )
      )
    )
    try {
      await service.prepareCatalog()
      await vi.waitFor(() => expect(service.state().preparing).toBe(false))
      expect(service.state().available).toEqual([])
      expect(validate).not.toHaveBeenCalled()
      const count = notify.mock.calls.length
      await service.prepareCatalog()
      expect(notify).toHaveBeenCalledTimes(count)
      const restarted = new PluginMarketplaceService(
        path,
        catalog,
        manager,
        undefined,
        '0.2.0-rc.2'
      )
      const fetch = vi.mocked(globalThis.fetch)
      fetch.mockClear()
      await restarted.prepareCatalog()
      await vi.waitFor(() => expect(restarted.state().preparing).toBe(false))
      expect(fetch).not.toHaveBeenCalled()
      expect(restarted.state().available).toEqual([])
      await restarted.shutdown()
      await service.shutdown()
    } finally {
      db.close()
    }
  })
  it('normalizes the real discovery schema without carrying commands, URLs or remote authorization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plugins: [
                {
                  name: 'Fixture',
                  npm: 'fixture-plugin',
                  version: '1.0.0',
                  description: { zh: '<script>text</script>' },
                  capabilities: ['fs-write'],
                  install: 'touch-secret',
                  localCompatibility: 'compatible',
                },
                { name: 'Manual', url: 'https://github.com/owner/plugin', install: 'curl | sh' },
                { name: 'Unsafe', npm: 'fixture-plugin; cmd', version: 'latest' },
              ],
            })
          )
      )
    )
    const provider = new DshPluginCatalogProvider()
    const rows = normalizeMarketplaceItems(await provider.load(), 'plugins', 'dsh')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      description: '<script>text</script>',
      plugin: { packageName: 'fixture-plugin', version: '1.0.0' },
    })
    expect(rows[0]).not.toHaveProperty('install')
    expect(rows[0]).not.toHaveProperty('localCompatibility')
    expect(rows[1].plugin?.packageName).toBeUndefined()
    expect(rows[2].plugin?.version).toBeUndefined()
    expect(() => new DshPluginCatalogProvider('https://arbitrary.invalid/catalog')).toThrow()
    expect(
      normalizeMarketplaceItems(
        [
          {
            sourceId: 'fixture-plugin',
            name: 'bad',
            plugin: { packageName: 'fixture-plugin', version: '1.0.0' + 'x'.repeat(200) },
          },
        ],
        'plugins',
        'dsh'
      )[0].plugin?.version
    ).toBeUndefined()
  })

  it('bounds catalog bytes and preserves more than 2000 normalized plugin entries in the summary cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)))
    )
    await expect(new DshPluginCatalogProvider().load()).rejects.toThrow('too large')
    const path = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-market-test-'))
    roots.push(path)
    const rows = Array.from({ length: 2200 }, (_, index) => ({
      sourceId: `fixture-${index}`,
      name: `Fixture ${index}`,
      plugin: { packageName: `fixture-${index}`, version: '1.0.0', warnings: [] },
    }))
    const load = vi.fn(async () => rows)
    const providers = [{ kind: 'plugins' as const, source: 'dsh', load }]
    expect(
      (await new MarketplaceCatalogService(path, providers).list('plugins')).items
    ).toHaveLength(2200)
    load.mockRejectedValue(new Error('offline'))
    expect(
      (await new MarketplaceCatalogService(path, providers).list('plugins')).items
    ).toHaveLength(2200)
  })

  it('prepares availability without executing plugins and installs in one action with full validation', async () => {
    const { db, service, request, validate, set, updateCatalog, notify } = setup()
    try {
      await service.prepareCatalog()
      await vi.waitFor(() => expect(service.state().preparing).toBe(false))
      expect(service.state().available).toEqual([{ key, version: '1.0.0' }])
      expect(validate).not.toHaveBeenCalled()
      expect(set.snapshot().plugins).toHaveLength(0)
      expect((await service.change(request('install'))).phase).toBe('succeeded')
      expect(validate).toHaveBeenCalledTimes(1)
      expect(service.state().installed).toEqual([
        {
          packageName: 'fixture-plugin',
          version: '1.0.0',
          enabled: true,
          configuration: 'default',
        },
      ])
      expect(service.state()).not.toHaveProperty('artifact')
      await updateCatalog()
      expect((await service.change(request('update', '1.0.0'))).phase).toBe('failed')
      expect((await service.change(request('update', '1.0.1'))).phase).toBe('succeeded')
      expect(set.snapshot().plugins[0].version).toBe('1.0.1')
      expect(notify.mock.calls.some(([operation]) => operation.phase === 'booting')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('persists context-bound checks, invalidates changed runtime/set results and boots a disabled target during check', async () => {
    const { path, db, service, request, validate, manager, catalog } = setup()
    try {
      await service.change(request('check'))
      expect(
        new PluginMarketplaceService(path, catalog, manager, undefined, '0.2.0-rc.2').state()
          .results
      ).toHaveLength(1)
      expect(
        new PluginMarketplaceService(path, catalog, manager, undefined, '0.3.0').state().results
      ).toHaveLength(0)
      await service.change(request('install'))
      await service.change(request('disable'))
      expect(service.state().results).toHaveLength(0)
      await service.change(request('check'))
      expect(validate.mock.calls.at(-1)![0][0].enabled).toBe(true)
      expect(service.state().installed[0].enabled).toBe(false)
      await service.change(request('enable'))
      expect(service.state().installed[0].enabled).toBe(true)
    } finally {
      db.close()
    }
  })

  it('reports incompatible/build approval and dependency remove failure without changing desired state', async () => {
    const { db, service, request, validate, set } = setup()
    try {
      validate.mockRejectedValueOnce(
        new Error('Plugin build script requires approval: fixture-plugin token=secret')
      )
      expect((await service.change(request('check'))).phase).toBe('failed')
      expect(service.state().results[0]).toMatchObject({ compatibility: 'needs-approval' })
      expect(service.state().results[0].diagnostics).not.toContain('token=secret')
      validate.mockRejectedValueOnce(new Error('Invalid SDK stdout framing'))
      await service.change(request('check'))
      expect(service.state().results[0].compatibility).toBe('incompatible')
      await service.change(request('check'))
      await service.change(request('install'))
      const before = set.snapshot()
      validate.mockRejectedValueOnce(new Error('Required peer dependency missing'))
      expect((await service.change(request('remove'))).phase).toBe('failed')
      expect(set.snapshot()).toEqual(before)
      await service.change(request('remove'))
      expect(service.state().installed).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('cancels the owned operation and drains it before shutdown, rejects injection and concurrent actions', async () => {
    const { db, service, request, validate, set } = setup()
    try {
      expect(() =>
        service.change({ ...request('check'), key: '["plugins","dsh","fixture; cmd"]' })
      ).toThrow()
      expect(() => service.change({ ...request('check'), version: ['1.0.0'] })).toThrow()
      expect(() =>
        service.change({ ...request('check'), key: '["agents","dsh","fixture-plugin"]' })
      ).toThrow()
      let started!: () => void
      const ready = new Promise<void>((resolveReady) => {
        started = resolveReady
      })
      validate.mockImplementationOnce(async (_plugins, signal) => {
        started()
        await new Promise<void>((resolveDone) =>
          signal!.addEventListener('abort', () => resolveDone(), { once: true })
        )
        signal!.throwIfAborted()
        throw new Error('unreachable')
      })
      const input = request('check'),
        operation = service.change(input)
      await ready
      expect(() => service.change(request('check'))).toThrow('正在进行')
      expect(service.cancel(randomUUID())).toBe(false)
      expect(service.cancel(input.requestId)).toBe(true)
      await service.shutdown()
      expect((await operation).phase).toBe('cancelled')
      expect(set.snapshot().plugins).toHaveLength(0)
      expect(service.cancel(input.requestId)).toBe(false)
      expect(() => service.change(request('check'))).toThrow()
    } finally {
      db.close()
    }
  })
})
