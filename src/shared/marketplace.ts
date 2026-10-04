export const marketplaceKinds = ['agents', 'teams', 'plugins'] as const
export type MarketplaceKind = (typeof marketplaceKinds)[number]
export type MarketplaceIdentity = { kind: MarketplaceKind; source: string; sourceId: string }
export type MarketplaceItem = MarketplaceIdentity & {
  key: string
  name: string
  description: string
  revision?: string
  license?: string
  installedAgentId?: string
}
export type MarketplaceCatalog = {
  kind: MarketplaceKind
  items: MarketplaceItem[]
  state: 'fresh' | 'stale' | 'error'
  fetchedAt: string | null
  error?: string
}

export function isMarketplaceKind(value: unknown): value is MarketplaceKind {
  return marketplaceKinds.includes(value as MarketplaceKind)
}

export function marketplaceKey(identity: MarketplaceIdentity): string {
  return JSON.stringify([identity.kind, identity.source, identity.sourceId])
}

export function parseMarketplaceKey(key: string): MarketplaceIdentity {
  const value: unknown = JSON.parse(key)
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !isMarketplaceKind(value[0]) ||
    typeof value[1] !== 'string' ||
    !value[1] ||
    typeof value[2] !== 'string' ||
    !value[2]
  ) {
    throw new Error('Marketplace key 无效')
  }
  return { kind: value[0], source: value[1], sourceId: value[2] }
}
