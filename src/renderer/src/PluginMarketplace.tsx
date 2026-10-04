import { useEffect, useRef, useState } from 'react'
import { marketplaceKey, type MarketplaceItem } from '../../shared/marketplace'
import type { PluginAction, PluginPhase, PluginState } from '../../shared/plugins'

const phases: Record<PluginPhase, string> = {
  queued: '等待验证',
  preparing: '准备隔离验证环境',
  installing: '安装完整候选集合',
  checking: '检查依赖与插件配置',
  booting: '启动 SDK 兼容验证',
  sealing: '保存验证结果',
  committing: '提交插件状态',
  succeeded: '操作完成',
  failed: '操作失败',
  cancelled: '已取消',
}
const compatibilityLabels = {
  unknown: '尚未验证',
  compatible: '本机兼容检查通过',
  incompatible: '本机验证未通过',
  'needs-approval': '需要构建批准，本版本不自动批准',
}
const done = new Set<PluginPhase>(['succeeded', 'failed', 'cancelled'])

export function PluginMarketplace({ items }: { items: MarketplaceItem[] }): React.JSX.Element {
  const [state, setState] = useState<PluginState>({ installed: [], results: [], operation: null })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(60)
  const active = useRef(true)
  const readRevision = useRef(0)
  async function readState(): Promise<void> {
    const revision = ++readRevision.current
    try {
      const result = await window.mindmesh.plugins.state()
      if (active.current && readRevision.current === revision) {
        setState(result)
        setReady(true)
        setError('')
      }
    } catch {
      if (active.current && readRevision.current === revision) {
        setReady(false)
        setError('读取插件状态失败，请重试。')
      }
    }
  }
  useEffect(() => {
    active.current = true
    const unsubscribe = window.mindmesh.plugins.onProgress((operation) => {
      ++readRevision.current
      setState((current) => ({ ...current, operation }))
      if (done.has(operation.phase)) void readState()
    })
    void readState()
    return () => {
      active.current = false
      ++readRevision.current
      unsubscribe()
    }
  }, [])
  const busy = !!state.operation && !done.has(state.operation.phase)
  async function change(item: MarketplaceItem, action: PluginAction): Promise<void> {
    const request = {
      requestId: crypto.randomUUID(),
      key: item.key,
      action,
      ...(['check', 'install', 'update'].includes(action) ? { version: item.plugin?.version } : {}),
    }
    ++readRevision.current
    setState((current) => ({ ...current, operation: { ...request, phase: 'queued' } }))
    setError('')
    try {
      await window.mindmesh.plugins.change(request)
      if (active.current) await readState()
    } catch {
      if (active.current) {
        await readState()
        setError('插件操作未能完成，请重试。')
      }
    }
  }
  async function cancel(): Promise<void> {
    try {
      if (state.operation) await window.mindmesh.plugins.cancel(state.operation.requestId)
    } catch {
      if (active.current) setError('取消操作失败，请重试。')
    }
  }
  const allItems = [...items]
  for (const installed of state.installed) {
    if (allItems.some((item) => item.sourceId === installed.packageName && item.source === 'dsh'))
      continue
    const identity = { kind: 'plugins' as const, source: 'dsh', sourceId: installed.packageName }
    allItems.unshift({
      ...identity,
      key: marketplaceKey(identity),
      name: installed.packageName,
      description: '已安装插件；当前目录无可用的更新信息。',
      plugin: { packageName: installed.packageName, warnings: [] },
    })
  }
  const matches = allItems.filter((item) =>
    `${item.name} ${item.plugin?.packageName ?? ''} ${item.description}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())
  )
  return (
    <div className="plugin-marketplace">
      <p className="form-error">
        第三方插件会在验证和运行时执行本机代码，隔离目录不是系统沙箱。请只安装你信任的插件；目录热度和兼容检查不代表安全认证。
      </p>
      <p>
        插件仅在对话选择“完全访问”时可用；安装不会改变当前权限。需要密钥或额外配置的插件可能无法通过验证。
      </p>
      <label className="field">
        <span>搜索插件或包名</span>
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setLimit(60)
          }}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button className="secondary-button compact" onClick={() => void readState()}>
            重试插件状态
          </button>
        </p>
      )}
      {!ready && !error && <p role="status">正在读取已安装插件…</p>}
      {state.operation && (
        <div
          className="plugin-operation"
          role={state.operation.phase === 'failed' ? 'alert' : 'status'}
        >
          <strong>{phases[state.operation.phase]}</strong>
          <p>{state.operation.message}</p>
          {busy && (
            <button
              className="secondary-button compact"
              disabled={state.operation.phase === 'committing'}
              onClick={() => void cancel()}
            >
              取消操作
            </button>
          )}
          {state.operation.diagnostics && (
            <details>
              <summary>查看诊断</summary>
              <pre>{state.operation.diagnostics}</pre>
            </details>
          )}
        </div>
      )}
      <p>
        已安装 {state.installed.length} 个插件 · 搜索结果 {matches.length} 项
      </p>
      <div className="catalog-grid">
        {matches.slice(0, limit).map((item) => {
          const installed = state.installed.find(
            (plugin) => item.source === 'dsh' && plugin.packageName === item.sourceId
          )
          const result = state.results.find(
            (result) => result.key === item.key && result.version === item.plugin?.version
          )
          const canInstall = !!item.plugin?.packageName && !!item.plugin.version
          const compatible = result?.compatibility === 'compatible'
          return (
            <article key={item.key} data-plugin-key={item.key}>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
              <small>来源：{item.source}</small>
              <small>包：{item.plugin?.packageName ?? installed?.packageName ?? '无 npm 包'}</small>
              <small>目录版本：{item.plugin?.version ?? '无确切版本'}</small>
              <small>兼容性：{compatibilityLabels[result?.compatibility ?? 'unknown']}</small>
              {installed && (
                <>
                  <small>
                    已安装 {installed.version} · {installed.enabled ? '已启用' : '已停用'}
                  </small>
                  <small>
                    配置：{installed.configuration === 'default' ? '默认配置' : '已有配置'}
                    （此处不编辑配置）
                  </small>
                </>
              )}
              {item.plugin?.warnings.map((warning) => (
                <small key={warning}>{warning}</small>
              ))}
              {!canInstall && !installed && (
                <small>需要手动设置；本版本只支持 npm 确切版本安装。</small>
              )}
              {canInstall && (
                <>
                  <button
                    className="secondary-button compact"
                    disabled={!ready || busy}
                    onClick={() => void change(item, 'check')}
                  >
                    检查兼容性
                  </button>
                  {(!installed || installed.version !== item.plugin!.version) && (
                    <button
                      className="secondary-button compact"
                      disabled={!ready || busy || !compatible}
                      onClick={() => void change(item, installed ? 'update' : 'install')}
                    >
                      {installed ? `更新至 ${item.plugin!.version}` : '安装插件'}
                    </button>
                  )}
                </>
              )}
              {installed && (
                <>
                  <button
                    className="secondary-button compact"
                    disabled={!ready || busy}
                    onClick={() => void change(item, installed.enabled ? 'disable' : 'enable')}
                  >
                    {installed.enabled ? '停用插件' : '启用插件'}
                  </button>
                  <button
                    className="secondary-button compact"
                    disabled={!ready || busy}
                    onClick={() => void change(item, 'remove')}
                  >
                    移除插件
                  </button>
                </>
              )}
              {result?.diagnostics && (
                <details>
                  <summary>兼容性诊断</summary>
                  <pre>{result.diagnostics}</pre>
                </details>
              )}
            </article>
          )
        })}
      </div>
      {matches.length > limit && (
        <button
          className="secondary-button compact"
          onClick={() => setLimit((value) => value + 60)}
        >
          显示更多插件
        </button>
      )}
    </div>
  )
}
