import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isMarketplaceKind,
  marketplaceKey,
  type MarketplaceCatalog,
  type MarketplaceItem,
  type MarketplaceKind,
} from '../shared/marketplace'

export type MarketplaceProvider = {
  kind: MarketplaceKind
  source: string
  load(): Promise<unknown>
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit)
  return result || undefined
}

// Provider payloads are data only: commands, HTML, URLs and installation input never cross IPC.
export function normalizeMarketplaceItems(
  payload: unknown,
  kind: MarketplaceKind,
  source: string
): MarketplaceItem[] {
  if (!Array.isArray(payload) || payload.length > 2_000) throw new Error('目录格式无效')
  const items = new Map<string, MarketplaceItem>()
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const sourceId =
      typeof row.sourceId === 'string' && row.sourceId.length <= 512 ? row.sourceId.trim() : ''
    const name = text(row.name, 160)
    if (!sourceId || /[\u0000-\u001f\u007f]/.test(sourceId) || !name) continue
    const identity = { kind, source, sourceId }
    const key = marketplaceKey(identity)
    if (items.has(key)) continue
    items.set(key, {
      ...identity,
      key,
      name,
      description: text(row.description, 2_000) ?? '',
      revision: text(row.revision, 160),
      license: text(row.license, 160),
    })
  }
  return [...items.values()]
}

// Concrete pinned Agent/Team/Plugin adapters arrive in PR7–9; no sample entries masquerade as installable content.
const defaultProviders: MarketplaceProvider[] = [
  { kind: 'agents', source: 'agency', load: async () => [] },
  { kind: 'teams', source: 'mindmesh-curated', load: async () => [] },
  { kind: 'plugins', source: 'dsh', load: async () => [] },
]

export class MarketplaceCatalogService {
  private readonly cache = new Map<MarketplaceKind, MarketplaceCatalog>()
  private readonly pending = new Map<MarketplaceKind, Promise<MarketplaceCatalog>>()
  private readonly directory: string

  constructor(
    dataDir: string,
    private readonly providers = defaultProviders,
    private readonly now = Date.now
  ) {
    this.directory = join(dataDir, 'marketplace-cache')
    const sources = new Set<string>()
    for (const provider of providers) {
      const key = JSON.stringify([provider.kind, provider.source])
      if (!isMarketplaceKind(provider.kind) || !provider.source || sources.has(key))
        throw new Error('目录来源无效或重复')
      sources.add(key)
    }
  }

  async list(kind: unknown, refresh: unknown = false): Promise<MarketplaceCatalog> {
    if (!isMarketplaceKind(kind) || typeof refresh !== 'boolean')
      throw new Error('Marketplace 查询无效')
    const pending = this.pending.get(kind)
    if (pending) return pending
    const cached = this.cache.get(kind) ?? this.readCache(kind)
    if (
      !refresh &&
      cached?.fetchedAt &&
      this.now() - Date.parse(cached.fetchedAt) < 15 * 60_000 &&
      this.now() >= Date.parse(cached.fetchedAt)
    )
      return { ...cached, state: 'fresh' }
    const task = this.load(kind, cached)
    this.pending.set(kind, task)
    try {
      return await task
    } finally {
      this.pending.delete(kind)
    }
  }

  private readCache(kind: MarketplaceKind): MarketplaceCatalog | undefined {
    try {
      const providers = this.providers.filter((provider) => provider.kind === kind)
      const raw = JSON.parse(readFileSync(join(this.directory, `${kind}.json`), 'utf8'))
      if (
        raw.kind !== kind ||
        typeof raw.fetchedAt !== 'string' ||
        !Number.isFinite(Date.parse(raw.fetchedAt)) ||
        !Array.isArray(raw.items) ||
        raw.items.length > 2_000 * providers.length
      )
        return undefined
      const items = providers.flatMap((provider) =>
        normalizeMarketplaceItems(
          raw.items.filter((row: MarketplaceItem) => row?.source === provider.source),
          kind,
          provider.source
        )
      )
      const cached: MarketplaceCatalog = { kind, items, state: 'fresh', fetchedAt: raw.fetchedAt }
      this.cache.set(kind, cached)
      return cached
    } catch {
      return undefined
    }
  }

  private async load(
    kind: MarketplaceKind,
    cached?: MarketplaceCatalog
  ): Promise<MarketplaceCatalog> {
    try {
      const groups = await Promise.all(
        this.providers
          .filter((provider) => provider.kind === kind)
          .map(async (provider) =>
            normalizeMarketplaceItems(await provider.load(), kind, provider.source)
          )
      )
      const result: MarketplaceCatalog = {
        kind,
        items: groups.flat(),
        state: 'fresh',
        fetchedAt: new Date(this.now()).toISOString(),
      }
      mkdirSync(this.directory, { recursive: true })
      const path = join(this.directory, `${kind}.json`)
      writeFileSync(`${path}.tmp`, JSON.stringify(result), 'utf8')
      renameSync(`${path}.tmp`, path)
      this.cache.set(kind, result)
      return result
    } catch {
      return {
        kind,
        items: cached?.items ?? [],
        state: cached ? 'stale' : 'error',
        fetchedAt: cached?.fetchedAt ?? null,
        error: cached ? '目录刷新失败，正在显示上次缓存。' : '目录暂时无法加载，请重试。',
      }
    }
  }
}
