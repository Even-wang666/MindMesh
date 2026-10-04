import { useEffect, useState } from 'react'
import { Plus, Sparkles, Wrench, X } from 'lucide-react'
import type { CatalogItem, SkillInstallProgress } from '../../shared/contracts'
import { DirectoryConfirm } from './FilePicker'
import { Field } from './Ui'

export function CatalogPage({ kind }: { kind: 'skills' | 'tools' }): React.JSX.Element {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [installing, setInstalling] = useState<'local' | 'github' | null>(null)
  const [progress, setProgress] = useState<SkillInstallProgress | null>(null)
  const [notice, setNotice] = useState('')
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false)
  const [githubUrl, setGitHubUrl] = useState('')
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setItems([])
    setLoadError('')
    setLoading(true)
    void window.mindmesh.catalog[kind]()
      .then((catalog) => {
        if (active) setItems(catalog)
      })
      .catch((cause: unknown) => {
        if (active)
          setLoadError(
            cause instanceof Error && cause.message ? cause.message : '目录加载失败，请重试。'
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [kind, retry])
  useEffect(() => {
    if (kind !== 'skills') return undefined
    return window.mindmesh.catalog.onInstallProgress(setProgress)
  }, [kind])
  async function pickSkillDir(): Promise<void> {
    if (installing) return
    setError('')
    setNotice('')
    try {
      const selected = await window.mindmesh.catalog.pickSkillDir()
      if (selected) setPendingDir(selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法选择技能目录')
    }
  }
  async function installSkill(path: string): Promise<void> {
    if (installing) return
    setError('')
    setNotice('')
    setInstalling('local')
    try {
      setItems(await window.mindmesh.catalog.installSkill(path))
      setLoadError('')
      setNotice('本地技能导入完成，技能库已刷新。')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '技能安装失败'
      throw new Error(message)
    } finally {
      setInstalling(null)
      setProgress(null)
    }
  }
  async function installGitHubSkill(rawUrl: string): Promise<void> {
    if (installing) return
    const url = rawUrl.trim()
    if (!url) return
    setGitHubDialogOpen(false)
    setGitHubUrl('')
    setError('')
    setNotice('')
    setProgress(null)
    setInstalling('github')
    try {
      setItems(await window.mindmesh.catalog.installSkillFromGitHub(url))
      setLoadError('')
      setNotice('GitHub 技能安装完成，技能库已刷新。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'GitHub 技能安装失败')
    } finally {
      setInstalling(null)
      setProgress(null)
    }
  }
  const progressLabel =
    installing === 'local'
      ? '正在导入本地技能…'
      : progress
        ? formatSkillInstallProgress(progress)
        : installing === 'github'
          ? '正在准备 GitHub 技能安装…'
          : ''
  return (
    <div className="page management-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">{kind.toUpperCase()}</span>
          <h1>{kind === 'skills' ? '技能库' : '工具'}</h1>
          <p>
            {kind === 'skills'
              ? '为智能体添加可复用的工作方法。'
              : '连接智能体可以使用的实际能力。'}
          </p>
        </div>
        {kind === 'skills' && (
          <div className="space-header-actions">
            <button
              className="secondary-button compact"
              disabled={installing !== null}
              onClick={() => void pickSkillDir()}
            >
              <Plus size={17} />
              {installing === 'local' ? '导入中…' : '本地导入'}
            </button>
            <button
              className="primary-button compact"
              disabled={installing !== null}
              onClick={() => setGitHubDialogOpen(true)}
            >
              {installing === 'github' ? '导入中…' : 'GitHub 导入'}
            </button>
          </div>
        )}
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {progressLabel && (
        <div className="skill-install-progress" role="status">
          <span>{progressLabel}</span>
          {progress?.phase === 'downloading' && progress.totalBytes !== undefined && (
            <progress
              aria-label="GitHub 技能下载进度"
              value={progress.receivedBytes ?? 0}
              max={progress.totalBytes}
            />
          )}
        </div>
      )}
      {notice && (
        <p className="form-success" role="status">
          {notice}
        </p>
      )}
      {loadError && (
        <div className="form-error" role="alert">
          {loadError}
          <button
            className="secondary-button compact"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">正在加载目录…</p>
      ) : loadError && items.length === 0 ? null : items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-mark">
            {kind === 'skills' ? <Sparkles size={19} /> : <Wrench size={19} />}
          </span>
          <h1>{kind === 'skills' ? '还没有可用技能' : '还没有可用工具'}</h1>
          <p>安装后会自动出现在这里，并可绑定到智能体。</p>
        </div>
      ) : (
        <div className="catalog-grid">
          {items.map((item) => (
            <article key={item.id}>
              <div className="catalog-icon">
                {kind === 'skills' ? <Sparkles size={20} /> : <Wrench size={20} />}
              </div>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
              {item.diagnostic && <small>{item.diagnostic}</small>}
              {kind === 'skills' && item.source && (
                <small>
                  {item.integrity === 'untracked' ? '未托管来源' : '可信来源'}：{item.source}
                  {item.license
                    ? ` · ${item.license}${item.licenseSpdx === false ? '（非 SPDX）' : ''}`
                    : ''}
                  {item.integrity === 'modified' ? ' · 内容已变更' : ''}
                </small>
              )}
              {item.limitations?.map((limitation) => (
                <small key={limitation}>{limitation}</small>
              ))}
              <span className="status-tag">{item.status}</span>
              {kind === 'skills' && item.status === '仅手动调用' && (
                <small className="skill-invoke-hint">
                  在对话中键入 <code>/{item.id}</code> 手动触发
                </small>
              )}
            </article>
          ))}
        </div>
      )}
      {pendingDir && (
        <DirectoryConfirm
          key={pendingDir}
          title="导入本地技能"
          path={pendingDir}
          confirmLabel="确认导入"
          onReselect={pickSkillDir}
          onConfirm={() => installSkill(pendingDir)}
          onClose={() => setPendingDir(null)}
        />
      )}
      {githubDialogOpen && (
        <div className="modal-backdrop confirm-backdrop">
          <form
            className="confirm-dialog github-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-import-title"
            onSubmit={(event) => {
              event.preventDefault()
              void installGitHubSkill(githubUrl)
            }}
          >
            <header>
              <div>
                <h2 id="github-import-title">从 GitHub 导入技能</h2>
                <p>粘贴公开 GitHub 仓库或其中的 skill 目录地址。</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setGitHubDialogOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <Field label="GitHub 地址">
              <input
                autoFocus
                value={githubUrl}
                onChange={(event) => setGitHubUrl(event.target.value)}
                placeholder="https://github.com/owner/repo/tree/main/path/to/skill"
              />
            </Field>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setGitHubDialogOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="primary-button" disabled={!githubUrl.trim()}>
                导入
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}

function formatSkillInstallProgress(progress: SkillInstallProgress): string {
  if (progress.phase === 'resolving') return '正在解析 GitHub 地址…'
  if (progress.phase === 'extracting') return '正在解压归档…'
  if (progress.phase === 'installing') return '正在安装技能…'
  if (progress.phase === 'done') return '安装完成'
  if (progress.receivedBytes === undefined) return '下载仓库归档…'
  const receivedKiB = Math.ceil(progress.receivedBytes / 1024)
  const size =
    progress.totalBytes === undefined
      ? `${receivedKiB} KiB`
      : `${receivedKiB} / ${Math.ceil(progress.totalBytes / 1024)} KiB`
  return `下载仓库归档… ${size}`
}
