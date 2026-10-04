import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceCatalogService, normalizeMarketplaceItems, type MarketplaceProvider } from '../src/main/marketplace'
import { marketplaceKey, parseMarketplaceKey } from '../src/shared/marketplace'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mindmesh-marketplace-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const row = { sourceId: 'same:id/中文', name: 'Writer', description: 'Helps write', command: 'do not execute' }

describe('Marketplace foundation', () => {
  it('round trips arbitrary source IDs without source or kind collisions', () => {
    const identity = { kind: 'agents' as const, source: 'source:one', sourceId: 'same:id/中文' }
    expect(parseMarketplaceKey(marketplaceKey(identity))).toEqual(identity)
    expect(marketplaceKey(identity)).not.toBe(marketplaceKey({ ...identity, source: 'source' }))
    expect(marketplaceKey(identity)).not.toBe(marketplaceKey({ ...identity, kind: 'teams' }))
    expect(() => parseMarketplaceKey('["bad","x","y"]')).toThrow()
  })

  it('normalizes untrusted fields, drops malformed rows and deduplicates per source', () => {
    const items = normalizeMarketplaceItems([row, row, null, { sourceId: 'bad' }, { ...row, sourceId: 3 },
      { ...row, sourceId: 'second', name: '  Name\u0000 ', description: 'x'.repeat(3_000), kind: 'plugins', source: 'spoof' }], 'agents', 'trusted')
    expect(items).toHaveLength(2)
    expect(items[0]).not.toHaveProperty('command')
    expect(items[1]).toMatchObject({ name: 'Name', kind: 'agents', source: 'trusted' })
    expect(items[1].description).toHaveLength(2_000)
    expect(() => normalizeMarketplaceItems({}, 'agents', 'trusted')).toThrow()
  })

  it('persists normalized multi-source content, reuses cache on restart and recovers after stale failures', async () => {
    const path = directory()
    let time = Date.parse('2026-10-04T00:00:00Z')
    const load = vi.fn(async (): Promise<unknown> => [row])
    const providers: MarketplaceProvider[] = [{ kind: 'agents', source: 'one', load }, { kind: 'agents', source: 'two', load }]
    const service = new MarketplaceCatalogService(path, providers, () => time)
    const first = await service.list('agents')
    expect(first.items).toHaveLength(2)
    expect(new Set(first.items.map((item) => item.key)).size).toBe(2)
    expect(readFileSync(join(path, 'marketplace-cache', 'agents.json'), 'utf8')).not.toContain('command')
    const restarted = new MarketplaceCatalogService(path, providers, () => time)
    expect(await restarted.list('agents')).toEqual(first)
    expect(load).toHaveBeenCalledTimes(2)
    time += 16 * 60_000
    load.mockRejectedValue(new Error('secret raw message'))
    const stale = await restarted.list('agents')
    expect(stale).toMatchObject({ state: 'stale', items: first.items, fetchedAt: first.fetchedAt })
    expect(JSON.stringify(stale)).not.toContain('secret')
    load.mockResolvedValue([])
    expect(await restarted.list('agents', true)).toMatchObject({ state: 'fresh', items: [] })
  })

  it('deduplicates in-flight refreshes and rejects renderer query input', async () => {
    let finish!: (value: unknown) => void
    const load = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve }))
    const service = new MarketplaceCatalogService(directory(), [{ kind: 'plugins', source: 'one', load }])
    const first = service.list('plugins', true)
    const second = service.list('plugins', true)
    expect(load).toHaveBeenCalledOnce()
    finish([row])
    expect(await first).toEqual(await second)
    await expect(service.list('../escape')).rejects.toThrow()
    await expect(service.list('plugins', 'true')).rejects.toThrow()
  })

  it('ignores corrupt cache and returns a safe error without a prior snapshot', async () => {
    const path = directory()
    mkdirSync(join(path, 'marketplace-cache'))
    writeFileSync(join(path, 'marketplace-cache', 'teams.json'), '{broken')
    const load = vi.fn(async () => { throw new Error('sensitive') })
    const service = new MarketplaceCatalogService(path, [{ kind: 'teams', source: 'one', load }])
    expect(await service.list('teams')).toMatchObject({ state: 'error', items: [], fetchedAt: null })
    expect(() => new MarketplaceCatalogService(path, [
      { kind: 'teams', source: 'one', load }, { kind: 'teams', source: 'one', load },
    ])).toThrow('重复')
  })
})
