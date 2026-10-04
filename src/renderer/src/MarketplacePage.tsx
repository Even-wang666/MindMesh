import { useEffect, useState } from 'react'
import {
  marketplaceKinds,
  type MarketplaceCatalog,
  type MarketplaceKind,
  type MarketplaceItem,
} from '../../shared/marketplace'

const labels: Record<MarketplaceKind, string> = { agents: '智能体', teams: '团队', plugins: '插件' }

export function MarketplacePage({
  onOpenAgent = () => {},
  onOpenSpace = () => {},
}: {
  onOpenAgent?: (id: string) => void | Promise<void>
  onOpenSpace?: (id: string) => void | Promise<void>
}): React.JSX.Element {
  const [kind, setKind] = useState<MarketplaceKind>('agents')
  const [catalog, setCatalog] = useState<MarketplaceCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [operation, setOperation] = useState<{
    key: string
    pending: boolean
    error?: string
  } | null>(null)
  async function install(item: MarketplaceItem): Promise<void> {
    const { key, revision } = item
    const isTeam = item.kind === 'teams'
    setOperation({ key, pending: true })
    try {
      const installed = await (isTeam
        ? window.mindmesh.marketplace.installTeam(key, revision!)
        : window.mindmesh.marketplace.installAgent(key, revision!))
      setCatalog((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      ...(isTeam
                        ? { installedSpaceId: installed.id }
                        : { installedAgentId: installed.id }),
                    }
                  : item
              ),
            }
          : current
      )
      setOperation(null)
    } catch {
      setOperation({
        key,
        pending: false,
        error: `安装${isTeam ? '团队' : '智能体'}失败，请刷新目录后重试。`,
      })
    }
  }
  async function open(item: MarketplaceItem): Promise<void> {
    const { key } = item
    const isTeam = item.kind === 'teams'
    setOperation({ key, pending: true })
    try {
      if (isTeam) await onOpenSpace(item.installedSpaceId!)
      else await onOpenAgent(item.installedAgentId!)
      setOperation(null)
    } catch {
      setOperation({
        key,
        pending: false,
        error: `打开${isTeam ? '团队' : '智能体'}失败，请刷新目录后重试。`,
      })
    }
  }
  useEffect(() => {
    let active = true
    setLoading(true)
    setCatalog(null)
    void window.mindmesh.marketplace
      .list(kind, refresh > 0)
      .then((result) => {
        if (active) setCatalog(result)
      })
      .catch(() => {
        if (active)
          setCatalog({
            kind,
            items: [],
            state: 'error',
            fetchedAt: null,
            error: '目录暂时无法加载，请重试。',
          })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [kind, refresh])

  return (
    <div className="page management-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MARKETPLACE</span>
          <h1>市场</h1>
          <p>发现智能体、协作团队与插件。</p>
        </div>
        <button
          className="secondary-button compact"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新目录
        </button>
      </header>
      <div className="marketplace-tabs" role="tablist" aria-label="市场目录">
        {marketplaceKinds.map((tab) => (
          <button
            key={tab}
            id={`marketplace-${tab}`}
            role="tab"
            aria-selected={kind === tab}
            aria-controls="marketplace-panel"
            tabIndex={kind === tab ? 0 : -1}
            className="secondary-button compact"
            onKeyDown={(event) => {
              const index = marketplaceKinds.indexOf(tab)
              const next =
                event.key === 'ArrowRight'
                  ? marketplaceKinds[(index + 1) % marketplaceKinds.length]
                  : event.key === 'ArrowLeft'
                    ? marketplaceKinds[
                        (index + marketplaceKinds.length - 1) % marketplaceKinds.length
                      ]
                    : event.key === 'Home'
                      ? marketplaceKinds[0]
                      : event.key === 'End'
                        ? marketplaceKinds[2]
                        : null
              if (!next) return
              event.preventDefault()
              setKind(next)
              setRefresh(0)
              document.getElementById(`marketplace-${next}`)?.focus()
            }}
            onClick={() => {
              setKind(tab)
              setRefresh(0)
            }}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      <section
        id="marketplace-panel"
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`marketplace-${kind}`}
        aria-busy={loading}
      >
        {loading && <p role="status">正在加载目录…</p>}
        {!loading && catalog?.error && (
          <p className="form-error" role="alert">
            {catalog.error}
          </p>
        )}
        {!loading && catalog?.fetchedAt && (
          <p className="marketplace-cache">
            {catalog.state === 'stale' ? '缓存时间' : '更新时间'}：
            {new Date(catalog.fetchedAt).toLocaleString()}
          </p>
        )}
        {!loading && catalog?.state !== 'error' && catalog?.items.length === 0 && (
          <div className="empty-state">
            <h2>暂无{labels[kind]}</h2>
            <p>此目录尚无条目，请稍后刷新。</p>
          </div>
        )}
        {!loading && (
          <div className="catalog-grid">
            {catalog?.items.map((item) => (
              <article key={item.key}>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <small>来源：{item.source}</small>
                {item.revision && <small>版本：{item.revision}</small>}
                {item.license && <small>许可：{item.license}</small>}
                {((item.kind === 'agents' && item.source === 'agency') ||
                  (item.kind === 'teams' && item.source === 'mindmesh-curated')) &&
                  item.revision && (
                    <>
                      <button
                        className="secondary-button compact marketplace-install"
                        disabled={operation?.pending === true}
                        onClick={() =>
                          item.installedAgentId || item.installedSpaceId
                            ? void open(item)
                            : void install(item)
                        }
                      >
                        {operation?.key === item.key && operation.pending
                          ? '处理中…'
                          : item.installedAgentId || item.installedSpaceId
                            ? '已安装 · 打开'
                            : item.kind === 'teams'
                              ? '安装团队'
                              : '安装智能体'}
                      </button>
                      {operation?.key === item.key && operation.error && (
                        <p className="form-error" role="alert">
                          {operation.error}
                        </p>
                      )}
                    </>
                  )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
