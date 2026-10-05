import { useEffect, useRef, useState } from 'react'
import { marketplaceKey, type MarketplaceItem } from '../../shared/marketplace'
import type { PluginAction, PluginPhase, PluginState } from '../../shared/plugins'

const phases: Record<PluginPhase, string> = {
  queued: '等待处理',
  preparing: '准备安装',
  installing: '安装插件',
  checking: '整理插件依赖',
  booting: '加载插件',
  sealing: '保存安装信息',
  committing: '完成安装',
  succeeded: '操作完成',
  failed: '操作失败',
  cancelled: '已取消',
}
const done = new Set<PluginPhase>(['succeeded', 'failed', 'cancelled'])

export function PluginMarketplace({ items }: { items: MarketplaceItem[] }): React.JSX.Element {
  const [state, setState] = useState<PluginState>({ installed: [], results: [], operation: null })
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const [githubUrl, setGithubUrl] = useState('')
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
      if (operation.action === 'check') {
        if (done.has(operation.phase)) void readState()
        return
      }
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
  }, [items])
  const busy =
    !!state.operation && state.operation.action !== 'check' && !done.has(state.operation.phase)
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
  async function importGitHub(): Promise<void> {
    const request = { requestId: crypto.randomUUID(), url: githubUrl.trim() }
    setGithubDialogOpen(false)
    ++readRevision.current
    setState((current) => ({
      ...current,
      operation: {
        requestId: request.requestId,
        key: '["plugins","dsh","github"]',
        action: 'install',
        phase: 'queued',
        message: '正在下载并验证 GitHub 插件…',
      },
    }))
    setError('')
    try {
      await window.mindmesh.plugins.importGitHub(request)
      if (active.current) await readState()
    } catch (caught) {
      if (active.current) {
        await readState()
        setError(caught instanceof Error ? caught.message : 'GitHub 插件导入失败。')
      }
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
  const visible = allItems.filter(
    (item) =>
      state.installed.some(
        (plugin) => plugin.packageName === item.sourceId && item.source === 'dsh'
      ) ||
      state.available?.some((row) => row.key === item.key && row.version === item.plugin?.version)
  )
  const matches = visible.filter((item) =>
    `${item.name} ${item.plugin?.packageName ?? ''} ${item.description}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())
  )
  return (
    <div className="plugin-marketplace">
      <p className="form-error">
        请只安装你信任的第三方插件。插件仅在“完全访问”模式下使用，安装不会改变当前对话权限。
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
      <button
        className="secondary-button compact"
        disabled={!ready || busy}
        onClick={() => setGithubDialogOpen(true)}
      >
        GitHub 导入
      </button>
      {githubDialogOpen && (
        <div className="modal-backdrop confirm-backdrop">
          <form
            className="confirm-dialog github-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-plugin-title"
            onSubmit={(event) => {
              event.preventDefault()
              void importGitHub()
            }}
          >
            <h2 id="github-plugin-title">从 GitHub 导入插件</h2>
            <p>粘贴公开仓库或插件目录地址，系统验证通过后自动安装。</p>
            <label className="field">
              <span>GitHub 插件地址</span>
              <input
                type="url"
                autoFocus
                value={githubUrl}
                onChange={(event) => setGithubUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                required
              />
            </label>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setGithubDialogOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="primary-button" disabled={!githubUrl.trim()}>
                验证并安装
              </button>
            </footer>
          </form>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button className="secondary-button compact" onClick={() => void readState()}>
            重试插件状态
          </button>
        </p>
      )}
      {!ready && !error && <p role="status">正在读取已安装插件…</p>}
      {state.preparing && <p role="status">正在准备可安装插件…</p>}
      {ready && !state.preparing && matches.length === 0 && <p>没有找到可安装的插件。</p>}
      {state.operation && state.operation.action !== 'check' && (
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
          const canInstall = !!state.available?.some(
            (row) => row.key === item.key && row.version === item.plugin?.version
          )
          return (
            <article key={item.key} data-plugin-key={item.key}>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
              <small>来源：{item.source}</small>
              <small>包：{item.plugin?.packageName ?? installed?.packageName ?? '无 npm 包'}</small>
              <small>目录版本：{item.plugin?.version ?? '无确切版本'}</small>
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
              {canInstall && (
                <>
                  {(!installed || installed.version !== item.plugin!.version) && (
                    <button
                      className="secondary-button compact"
                      disabled={!ready || busy}
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
