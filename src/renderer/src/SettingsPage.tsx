import { useEffect, useState } from 'react'
import {
  Activity,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type {
  ModelProviderId,
  ModelProviderStatus,
  RuntimeStatus,
  SaveModelProviderInput,
  UserProfile,
} from '../../shared/contracts'
import {
  getModelProviderApiKeyError,
  getModelProviderDefinition,
} from '../../shared/model-providers'
import { useConfirm } from './ConfirmDialog'
import { DirectoryConfirm, ImagePicker } from './FilePicker'
import { Avatar, Field } from './Ui'
import { getProviderLogo } from './ProviderLogos'

function ProfileSettings({
  profile,
  onSaved,
}: {
  profile: UserProfile
  onSaved: (profile: UserProfile) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(profile)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => setDraft(profile), [profile])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const changed = draft.name.trim() !== profile.name || draft.avatar !== profile.avatar

  function editDraft(update: (current: UserProfile) => UserProfile): void {
    setNotice('')
    setDraft(update)
  }

  function startEditing(): void {
    setDraft(profile)
    setError('')
    setNotice('')
    setEditing(true)
  }

  function cancelEditing(): void {
    setDraft(profile)
    setError('')
    setEditing(false)
  }

  function chooseAvatar(file?: File): Promise<string | null> {
    if (!file) return Promise.resolve('请选择一张图片')
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ||
      file.size > 1_000_000
    ) {
      const message = '请选择不超过 1 MB 的 PNG、JPEG、WebP 或 GIF 图片'
      setError(message)
      return Promise.resolve(message)
    }
    setReading(true)
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const image = reader.result
        if (typeof image === 'string') {
          editDraft((current) => ({ ...current, avatar: image }))
          setError('')
          resolve(null)
        } else {
          setError('无法读取图片，请重试')
          resolve('无法读取图片，请重试')
        }
        setReading(false)
      }
      reader.onerror = () => {
        setError('无法读取图片，请重试')
        setReading(false)
        resolve('无法读取图片，请重试')
      }
      reader.readAsDataURL(file)
    })
  }

  async function saveProfile(): Promise<void> {
    if (!draft.name.trim()) {
      setError('请输入昵称')
      return
    }
    if (!changed) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await window.mindmesh.settings.saveProfile({
        name: draft.name.trim(),
        avatar: draft.avatar,
      })
      setDraft(saved)
      onSaved(saved)
      setNotice('个人资料已保存')
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section profile-section">
      <h2>个人资料</h2>
      {editing ? (
        <>
          <div className="profile-form">
            <div className="profile-avatar">
              <Avatar name={draft.name} image={draft.avatar} large />
              <div>
                <button className="secondary-button compact" onClick={() => setPickerOpen(true)}>
                  选择头像
                </button>
                {draft.avatar && (
                  <button
                    className="text-button"
                    onClick={() => editDraft((current) => ({ ...current, avatar: null }))}
                  >
                    移除头像
                  </button>
                )}
                <small>PNG、JPEG、WebP 或 GIF，最大 1 MB</small>
              </div>
            </div>
            <div className="field">
              <label htmlFor="profile-name-input">你希望智能体怎么称呼你</label>
              <input
                id="profile-name-input"
                autoFocus
                aria-describedby="profile-name-hint"
                value={draft.name}
                maxLength={40}
                placeholder="例如：小明、王工、老板"
                onChange={(event) =>
                  editDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
              <small className="field-hint" id="profile-name-hint">
                这个名字会显示在对话里，智能体也会用它称呼你
              </small>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="profile-actions">
              <button
                className="primary-button compact"
                disabled={saving || reading || !changed}
                onClick={() => void saveProfile()}
              >
                保存个人资料
              </button>
              <button
                className="secondary-button compact"
                disabled={saving}
                onClick={cancelEditing}
              >
                取消
              </button>
            </div>
          </div>
          {pickerOpen && (
            <ImagePicker
              title="选择头像"
              hint="PNG、JPEG、WebP 或 GIF，最大 1 MB"
              multiple={false}
              confirmLabel="使用图片"
              onPick={(files) => chooseAvatar(files[0])}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      ) : (
        <div className="setting-row profile-row">
          <Avatar name={profile.name} image={profile.avatar} large />
          <div>
            <strong className="profile-name">{profile.name}</strong>
            <p>智能体在对话中会这样称呼你</p>
          </div>
          {notice && (
            <span className="form-success" role="status">
              <Check size={15} />
              {notice}
            </span>
          )}
          <button className="secondary-button compact" onClick={startEditing}>
            编辑资料
          </button>
        </div>
      )}
    </section>
  )
}

export function SettingsPage({
  runtime,
  profile,
  busy,
  onProfileChange,
  onRuntimeChange,
  onProviderChange,
}: {
  runtime: RuntimeStatus | null
  profile: UserProfile
  busy: boolean
  onProfileChange: (profile: UserProfile) => void
  onRuntimeChange: (runtime: RuntimeStatus) => void
  onProviderChange: () => Promise<void>
}): React.JSX.Element {
  const confirm = useConfirm()
  const [providers, setProviders] = useState<ModelProviderStatus[]>([])
  const [editing, setEditing] = useState<ModelProviderId | null>(null)
  const [form, setForm] = useState<SaveModelProviderInput>({ id: 'deepseek-official', apiKey: '' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null)
  const [providerLoadError, setProviderLoadError] = useState('')
  const [providerLoading, setProviderLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setProviderLoadError('')
    setProviderLoading(true)
    setWorkspaceError('')
    void window.mindmesh.settings
      .modelProviders()
      .then((items) => {
        if (active) setProviders(items)
      })
      .catch((cause: unknown) => {
        if (active)
          setProviderLoadError(
            cause instanceof Error && cause.message ? cause.message : '模型服务加载失败，请重试。'
          )
      })
      .finally(() => {
        if (active) setProviderLoading(false)
      })
    void window.mindmesh.settings
      .workspace()
      .then((path) => {
        if (active) setWorkspace(path)
      })
      .catch((cause: unknown) => {
        if (active)
          setWorkspaceError(
            cause instanceof Error && cause.message ? cause.message : '工作目录加载失败，请重试。'
          )
      })
    return () => {
      active = false
    }
  }, [loadAttempt])

  async function pickWorkspace(): Promise<void> {
    setChoosingWorkspace(true)
    setWorkspaceError('')
    try {
      const selected = await window.mindmesh.settings.pickWorkspace()
      if (selected && selected !== workspace) setPendingWorkspace(selected)
    } catch {
      setWorkspaceError('无法选择工作目录，请重试。')
    } finally {
      setChoosingWorkspace(false)
    }
  }

  async function confirmWorkspace(): Promise<void> {
    if (!pendingWorkspace) return
    setChoosingWorkspace(true)
    setWorkspaceError('')
    try {
      setWorkspace(await window.mindmesh.settings.chooseWorkspace(pendingWorkspace))
      onRuntimeChange(await window.mindmesh.runtime.status())
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message ? cause.message : '无法切换工作目录，请重试。'
      setWorkspaceError(message)
      throw new Error(message)
    } finally {
      setChoosingWorkspace(false)
    }
  }

  async function refreshStatus(nextProviders: ModelProviderStatus[]): Promise<void> {
    setProviders(nextProviders)
    onRuntimeChange(await window.mindmesh.runtime.status())
    await onProviderChange()
  }

  async function save(): Promise<void> {
    const validationError = getModelProviderApiKeyError(form.id, form.apiKey)
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError('')
    try {
      await refreshStatus(await window.mindmesh.settings.saveModelProvider(form))
      closeEditor()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  async function remove(provider: ModelProviderStatus): Promise<void> {
    await refreshStatus(await window.mindmesh.settings.removeModelProvider(provider.id))
    closeEditor()
  }

  function requestRemove(provider: ModelProviderStatus): void {
    confirm({
      title: `移除 ${provider.name} 的 API 配置？`,
      description: '这台设备上保存的 API Key 会被清除，需要重新填写才能继续使用该模型服务。',
      confirmLabel: '移除配置',
      onConfirm: () => remove(provider),
    })
  }

  function openEditor(provider: ModelProviderStatus | { id: 'custom' }): void {
    setEditing(provider.id)
    setForm(
      provider.id === 'custom'
        ? {
            id: 'custom',
            apiKey: '',
            name: 'name' in provider ? provider.name : '自定义服务',
            baseUrl: 'baseUrl' in provider ? provider.baseUrl : 'https://api.example.com/v1',
            model: 'model' in provider ? provider.model : 'your-model-id',
          }
        : { id: provider.id, apiKey: '' }
    )
    setShowKey(false)
    setError('')
  }

  function closeEditor(): void {
    setEditing(null)
    setForm({ id: 'deepseek-official', apiKey: '' })
    setShowKey(false)
    setError('')
  }

  const definition = editing ? getModelProviderDefinition(editing) : undefined
  const validationError = form.apiKey ? getModelProviderApiKeyError(form.id, form.apiKey) : null
  const maxLength = definition?.maxLength ?? 300
  const customConfigured = providers.some((provider) => provider.id === 'custom')

  return (
    <div className="page management-page narrow settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h1>设置</h1>
          <p>连接模型服务，管理应用状态与本地数据。</p>
        </div>
      </header>
      <ProfileSettings profile={profile} onSaved={onProfileChange} />
      <section className="settings-section">
        <h2>模型服务</h2>
        {providerLoading && <p role="status">正在读取模型服务…</p>}
        {providerLoadError && (
          <div className="form-error" role="alert">
            <p>{providerLoadError}</p>
            <button
              className="secondary-button compact"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              重试模型服务
            </button>
          </div>
        )}
        {providers.map((provider) => (
          <div className="provider-entry" key={provider.id}>
            <div className="setting-row provider-row">
              <ProviderLogo provider={provider.id} />
              <div>
                <strong>{provider.name}</strong>
                <p>
                  {provider.configured
                    ? `${provider.description} 已连接，可以用于智能体对话。`
                    : provider.description}
                </p>
                {provider.id === 'deepseek-official' && provider.configured && (
                  <ProviderBalance status={provider} />
                )}
              </div>
              <span className={`state-badge ${provider.configured ? '' : 'warn'}`}>
                {provider.configured ? '已配置' : '需要配置'}
              </span>
              <button
                className={
                  provider.configured ? 'secondary-button compact' : 'primary-button compact'
                }
                onClick={() => openEditor(provider)}
              >
                <KeyRound size={15} />
                {provider.configured ? '编辑' : '连接'}
              </button>
            </div>
            {editing === provider.id && renderProviderForm(provider)}
          </div>
        ))}
        {!customConfigured && !providerLoadError && !providerLoading && (
          <button className="add-provider-row" onClick={() => openEditor({ id: 'custom' })}>
            <span className="provider-add-icon">
              <Plus size={18} />
            </span>
            <span>
              <strong>添加自定义服务</strong>
              <small>连接其他兼容 OpenAI API 的模型服务</small>
            </span>
            <ChevronRight size={17} />
          </button>
        )}
        {editing === 'custom' && !customConfigured && renderProviderForm()}
      </section>
      <section className="settings-section">
        <h2>本地文件</h2>
        <div className="setting-row">
          <div className="data-icon">
            <HardDrive size={19} />
          </div>
          <div>
            <strong>Agent 工作目录</strong>
            <p className="workspace-path">
              {workspace || (workspaceError ? '读取失败' : '读取中…')}
            </p>
            <small>
              在 Agent
              编辑页启用“文件”工具后即可使用。文件写入限制在此目录；切换后模型会话重新开始，聊天消息仍保留。
            </small>
            {workspaceError && (
              <div className="form-error" role="alert">
                <p>{workspaceError}</p>
                <button
                  className="secondary-button compact"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  重试工作目录
                </button>
              </div>
            )}
          </div>
          <button
            className="secondary-button compact"
            disabled={busy || choosingWorkspace}
            onClick={() => void pickWorkspace()}
          >
            选择文件夹
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>运行状态</h2>
        <div className="setting-row">
          <div className="runtime-icon">
            <Activity size={19} />
          </div>
          <div>
            <strong>{runtime?.label ?? '检查中'}</strong>
            <p>{runtime?.detail}</p>
          </div>
          <span className={`state-badge ${runtime?.state === 'demo' ? 'warn' : ''}`}>
            {runtime?.state === 'demo' ? '等待连接' : '正常'}
          </span>
        </div>
      </section>
      <section className="settings-section">
        <h2>本地数据</h2>
        <div className="setting-row">
          <div className="data-icon">
            <HardDrive size={19} />
          </div>
          <div>
            <strong>保存在这台设备上</strong>
            <p>智能体、协作空间和消息不会自动上传到云端。</p>
          </div>
        </div>
      </section>
      {pendingWorkspace && (
        <DirectoryConfirm
          key={pendingWorkspace}
          title="切换 Agent 工作目录"
          path={pendingWorkspace}
          confirmLabel="确认切换"
          onReselect={pickWorkspace}
          onConfirm={confirmWorkspace}
          onClose={() => setPendingWorkspace(null)}
        />
      )}
    </div>
  )

  function renderProviderForm(provider?: ModelProviderStatus): React.JSX.Element {
    return (
      <div className="provider-form">
        <div className="secure-note">
          <ShieldCheck size={17} />
          <span>
            <strong>安全保存</strong>
            <small>API Key 经过系统加密，仅保存在这台设备上。</small>
          </span>
        </div>
        {form.id === 'custom' && (
          <div className="custom-provider-fields">
            <Field label="服务名称">
              <input
                value={form.name ?? ''}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="例如：公司内部模型"
                maxLength={50}
              />
            </Field>
            <Field label="API Base URL">
              <input
                value={form.baseUrl ?? ''}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="例如：https://api.example.com/v1"
              />
            </Field>
            <Field label="模型 ID">
              <input
                value={form.model ?? ''}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="例如：my-chat-model"
                maxLength={100}
              />
            </Field>
          </div>
        )}
        <label className="field api-key-field">
          <span>{provider?.name ?? '自定义服务'} API Key</span>
          <div className="secret-input">
            <input
              autoFocus
              type={showKey ? 'text' : 'password'}
              value={form.apiKey}
              onChange={(event) => {
                setForm({ ...form, apiKey: event.target.value })
                setError('')
              }}
              placeholder={`例如：${definition?.apiKeyExample ?? 'your-api-key-0123456789'}`}
              maxLength={maxLength}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowKey((current) => !current)}
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              title={showKey ? '隐藏 API Key' : '显示 API Key'}
            >
              {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          <span className="field-hint">
            <span>{definition?.apiKeyHint ?? '请输入服务商提供的完整 API Key'}</span>
            <span className={validationError ? 'invalid' : ''}>
              {form.apiKey.trim().length}/{maxLength}
            </span>
          </span>
        </label>
        {(validationError || error) && <p className="form-error">{validationError || error}</p>}
        <div className="provider-actions">
          {provider?.source === 'saved' && (
            <button
              className="danger-button"
              disabled={saving}
              onClick={() => requestRemove(provider)}
            >
              <Trash2 size={15} />
              移除
            </button>
          )}
          <span />
          <button className="secondary-button compact" disabled={saving} onClick={closeEditor}>
            取消
          </button>
          <button
            className="primary-button compact"
            disabled={saving || !form.apiKey.trim() || validationError !== null}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" /> : <Check size={15} />}保存
          </button>
        </div>
      </div>
    )
  }
}

function ProviderLogo({ provider }: { provider: ModelProviderId }): React.JSX.Element {
  const logo = getProviderLogo(provider)
  return logo ? (
    <span className={`provider-logo ${provider}`}>
      <img src={logo} alt="" />
    </span>
  ) : (
    <span className="provider-logo custom">
      <Plus size={19} />
    </span>
  )
}

function ProviderBalance({ status }: { status: ModelProviderStatus }): React.JSX.Element {
  if (status.balanceError)
    return (
      <div className="provider-balance unavailable">
        <span>余额暂时无法获取</span>
      </div>
    )
  if (!status.balance)
    return (
      <div className="provider-balance">
        <span>余额查询中…</span>
      </div>
    )
  return (
    <div className="provider-balance">
      <span className={status.balance.available ? 'balance-dot' : 'balance-dot unavailable'} />
      {status.balance.items.length > 0 ? (
        status.balance.items.map((item) => (
          <strong key={item.currency}>
            {item.currency === 'CNY' ? '¥' : '$'}
            {item.total} <small>{item.currency}</small>
          </strong>
        ))
      ) : (
        <strong>{status.balance.available ? '可用' : '余额不足'}</strong>
      )}
      <small>
        更新于{' '}
        {new Date(status.balance.updatedAt).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </small>
    </div>
  )
}
