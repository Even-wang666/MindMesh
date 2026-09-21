import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Bot, Boxes, Check, ChevronRight, CircleHelp, Command, Eye, EyeOff, HardDrive,
  KeyRound, Library, MessageCircle, MoreHorizontal, Plus, Search, Send, Settings,
  ShieldCheck, Sparkles, Trash2, Users, Wrench, X,
} from 'lucide-react'
import type {
  Agent, CreateAgentInput, Message, ModelProviderId, ModelProviderStatus, RuntimeStatus,
  SaveModelProviderInput, Space,
} from '../../shared/contracts'
import {
  getModelProviderApiKeyError, getModelProviderDefinition, MODEL_PROVIDER_DEFINITIONS,
} from '../../shared/model-providers'
import { BrandLogo } from './BrandLogo'
import anthropicLogo from './assets/providers/anthropic.svg'
import deepseekLogo from './assets/providers/deepseek.svg'
import kimiLogo from './assets/providers/kimi.png'
import openaiLogo from './assets/providers/openai.svg'

type View = 'chats' | 'spaces' | 'agents' | 'skills' | 'tools' | 'settings'
type ModelOption = { provider: string; id: string; name: string }

const providerLogos: Partial<Record<ModelProviderId, string>> = {
  'deepseek-official': deepseekLogo,
  'moonshotai-cn': kimiLogo,
  openai: openaiLogo,
  anthropic: anthropicLogo,
}

const defaultAgent: CreateAgentInput = {
  name: '', role: '', persona: '', provider: 'deepseek-official', model: 'deepseek-v4-flash', skills: [], tools: [],
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chats')
  const [agents, setAgents] = useState<Agent[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [agentWizard, setAgentWizard] = useState(false)
  const [spaceWizard, setSpaceWizard] = useState(false)
  const [detailAgentId, setDetailAgentId] = useState<string>('')
  const [editingAgentId, setEditingAgentId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId)

  async function refresh(): Promise<void> {
    const [nextAgents, nextSpaces, status] = await Promise.all([
      window.mindmesh.agents.list(), window.mindmesh.spaces.list(), window.mindmesh.runtime.status(),
    ])
    setAgents(nextAgents)
    setSpaces(nextSpaces)
    setRuntime(status)
    setSelectedAgentId((current) => current || nextAgents[0]?.id || '')
    setSelectedSpaceId((current) => current || nextSpaces[0]?.id || '')
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    const scope = view === 'spaces' ? 'space' : 'private'
    const id = view === 'spaces' ? selectedSpaceId : selectedAgentId
    if (!id || (view !== 'chats' && view !== 'spaces')) return
    void window.mindmesh.chat.messages(scope, id).then(setMessages)
  }, [view, selectedAgentId, selectedSpaceId])

  async function send(content: string): Promise<void> {
    if (!content.trim() || busy) return
    setBusy(true)
    try {
      if (view === 'chats' && selectedAgentId) {
        setMessages(await window.mindmesh.chat.sendPrivate(selectedAgentId, content.trim()))
      } else if (view === 'spaces' && selectedSpaceId) {
        setMessages(await window.mindmesh.chat.sendSpace(selectedSpaceId, content.trim()))
      }
      setRuntime(await window.mindmesh.runtime.status())
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell">
      <PrimaryNav view={view} onView={setView} runtime={runtime} />
      {(view === 'chats' || view === 'spaces') && (
        <ObjectList
          view={view}
          agents={agents}
          spaces={spaces}
          selectedId={view === 'chats' ? selectedAgentId : selectedSpaceId}
          onSelect={view === 'chats' ? setSelectedAgentId : setSelectedSpaceId}
          onCreate={() => view === 'chats' ? setAgentWizard(true) : setSpaceWizard(true)}
        />
      )}
      <section className="content">
        {view === 'chats' && (
          selectedAgent
            ? <ChatPanel title={selectedAgent.name} subtitle={selectedAgent.role} messages={messages} busy={busy} onSend={send} onDetail={() => setDetailAgentId(selectedAgent.id)} />
            : <EmptyState onCreate={() => setAgentWizard(true)} />
        )}
        {view === 'spaces' && selectedSpace && (
          <SpacePanel space={selectedSpace} agents={agents} messages={messages} busy={busy} onSend={send} />
        )}
        {view === 'agents' && <AgentsPage agents={agents} onCreate={() => setAgentWizard(true)} onDetail={setDetailAgentId} />}
        {view === 'skills' && <CatalogPage kind="skills" />}
        {view === 'tools' && <CatalogPage kind="tools" />}
        {view === 'settings' && <SettingsPage runtime={runtime} onRuntimeChange={setRuntime} />}
      </section>
      {agentWizard && <AgentWizard onClose={() => setAgentWizard(false)} onSaved={async () => { setAgentWizard(false); await refresh() }} />}
      {editingAgentId && <AgentWizard initialAgent={agents.find((item) => item.id === editingAgentId)} onClose={() => setEditingAgentId('')} onSaved={async () => { setEditingAgentId(''); await refresh() }} />}
      {spaceWizard && <SpaceWizard agents={agents} onClose={() => setSpaceWizard(false)} onCreated={async () => { setSpaceWizard(false); await refresh() }} />}
      {detailAgentId && <AgentDrawer agent={agents.find((item) => item.id === detailAgentId)} onClose={() => setDetailAgentId('')} onChat={(id) => { setSelectedAgentId(id); setView('chats'); setDetailAgentId('') }} onEdit={(id) => { setDetailAgentId(''); setEditingAgentId(id) }} />}
    </main>
  )
}

function PrimaryNav({ view, onView, runtime }: { view: View; onView: (view: View) => void; runtime: RuntimeStatus | null }): React.JSX.Element {
  const items: Array<{ id: View; label: string; icon: React.ElementType }> = [
    { id: 'chats', label: '对话', icon: MessageCircle },
    { id: 'spaces', label: '协作空间', icon: Boxes },
    { id: 'agents', label: '智能体', icon: Bot },
    { id: 'skills', label: '技能', icon: Library },
    { id: 'tools', label: '工具', icon: Wrench },
  ]
  return (
    <aside className="primary-nav">
      <BrandLogo wordmark inverse size={36} />
      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => onView(id)}>
            <Icon size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="nav-bottom">
        <div className="runtime-pill"><i className={runtime?.state === 'error' ? 'danger' : ''} />{runtime?.label ?? '检查中'}</div>
        <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onView('settings')}>
          <Settings size={18} /><span>设置</span>
        </button>
      </div>
    </aside>
  )
}

function ObjectList(props: {
  view: 'chats' | 'spaces'; agents: Agent[]; spaces: Space[]; selectedId: string;
  onSelect: (id: string) => void; onCreate: () => void
}): React.JSX.Element {
  const rows = props.view === 'chats' ? props.agents : props.spaces
  return (
    <aside className="object-list">
      <div className="list-heading">
        <div><span className="eyebrow">{props.view === 'chats' ? 'CHATS' : 'SPACES'}</span><h2>{props.view === 'chats' ? '对话' : '协作空间'}</h2></div>
        <button className="icon-button" onClick={props.onCreate} aria-label="新建"><Plus size={18} /></button>
      </div>
      <label className="search"><Search size={16} /><input placeholder="搜索" /></label>
      <div className="list-rows">
        {rows.map((row) => (
          <button key={row.id} className={props.selectedId === row.id ? 'object-row selected' : 'object-row'} onClick={() => props.onSelect(row.id)}>
            <Avatar name={row.name} /><span><strong>{row.name}</strong><small>{'role' in row ? row.role : row.description}</small></span>
          </button>
        ))}
      </div>
      <button className="list-create" onClick={props.onCreate}><Plus size={16} />{props.view === 'chats' ? '创建智能体' : '新建空间'}</button>
    </aside>
  )
}

function ChatPanel({ title, subtitle, messages, busy, onSend, onDetail }: {
  title: string; subtitle: string; messages: Message[]; busy: boolean
  onSend: (content: string) => Promise<void>; onDetail: () => void
}): React.JSX.Element {
  return (
    <div className="page chat-page">
      <header className="chat-header"><div><h1>{title}</h1><p>{subtitle}</p></div><button className="ghost-button" onClick={onDetail}>查看详情 <ChevronRight size={15} /></button></header>
      <MessageList messages={messages} emptyText="开始一段新的对话" />
      <Composer busy={busy} placeholder={`给 ${title} 发送消息…`} onSend={onSend} />
    </div>
  )
}

function SpacePanel({ space, agents, messages, busy, onSend }: {
  space: Space; agents: Agent[]; messages: Message[]; busy: boolean; onSend: (content: string) => Promise<void>
}): React.JSX.Element {
  const members = agents.filter((agent) => space.memberIds.includes(agent.id))
  return (
    <div className="page space-page">
      <header className="chat-header"><div><h1>{space.name}</h1><p>{members.length} 个智能体 · {space.description}</p></div><button className="ghost-button"><Users size={16} /> 成员与背景</button></header>
      <div className="space-layout">
        <div className="space-chat"><MessageList messages={messages} emptyText="使用 @智能体 开始协作" /><Composer busy={busy} placeholder="@智能体 输入消息…" members={members} onSend={onSend} /></div>
        <aside className="context-drawer"><span className="eyebrow">成员</span>{members.map((agent) => <div className="member" key={agent.id}><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span><i /></div>)}<hr /><span className="eyebrow">背景信息</span><p>{space.context}</p><button className="text-button">编辑背景</button></aside>
      </div>
    </div>
  )
}

function MessageList({ messages, emptyText }: { messages: Message[]; emptyText: string }): React.JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [messages])
  if (!messages.length) return <div className="conversation-empty"><BrandLogo size={54} /><h3>{emptyText}</h3><p>消息仅保存在这台设备上。</p></div>
  return <div className="messages">{messages.map((message) => <article key={message.id} className={`message ${message.authorType}`}><Avatar name={message.authorName} /><div><header><strong>{message.authorName}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header><p>{message.content}</p></div></article>)}<div ref={end} /></div>
}

function Composer({ busy, placeholder, members = [], onSend }: { busy: boolean; placeholder: string; members?: Agent[]; onSend: (value: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const showMentions = members.length > 0 && /(^|\s)@[\w-]*$/.test(value)
  async function submit(): Promise<void> { const current = value; if (!current.trim()) return; setValue(''); await onSend(current) }
  return (
    <div className="composer-wrap">
      {showMentions && <div className="mention-menu"><span className="eyebrow">选择智能体</span>{members.map((agent) => <button key={agent.id} onClick={() => setValue(value.replace(/@[\w-]*$/, `@${agent.name} `))}><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></button>)}</div>}
      <div className="composer"><textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={placeholder} /><div className="composer-actions"><span><Command size={14} /> Enter 发送</span><button disabled={busy || !value.trim()} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <Send size={17} />}</button></div></div>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return <div className="empty-state"><BrandLogo size={76} /><h1>还没有智能体</h1><p>创建第一个智能体，开始你的 Multi-Agent 工作空间。</p><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></div>
}

function AgentsPage({ agents, onCreate, onDetail }: { agents: Agent[]; onCreate: () => void; onDetail: (id: string) => void }): React.JSX.Element {
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">AGENTS</span><h1>智能体</h1><p>管理身份、模型、技能和工具。</p></div><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></header><div className="table-card"><div className="table-head"><span>智能体</span><span>模型</span><span>能力</span><span>状态</span><span /></div>{agents.map((agent) => <button className="agent-table-row" key={agent.id} onClick={() => onDetail(agent.id)}><span className="agent-cell"><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></span><span><em>{agent.model}</em></span><span className="tags">{agent.skills.slice(0, 2).map((skill) => <i key={skill}>{skill}</i>)}</span><span className="online"><i /> 可用</span><MoreHorizontal size={18} /></button>)}</div></div>
}

function CatalogPage({ kind }: { kind: 'skills' | 'tools' }): React.JSX.Element {
  const [items, setItems] = useState<Array<{ id: string; name: string; description: string; status: string }>>([])
  useEffect(() => { void window.mindmesh.catalog[kind]().then(setItems) }, [kind])
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">{kind.toUpperCase()}</span><h1>{kind === 'skills' ? '技能库' : '工具'}</h1><p>{kind === 'skills' ? '为智能体添加可复用的工作方法。' : '连接智能体可以使用的实际能力。'}</p></div></header><div className="catalog-grid">{items.map((item) => <article key={item.id}><div className="catalog-icon">{kind === 'skills' ? <Sparkles size={20} /> : <Wrench size={20} />}</div><h3>{item.name}</h3><p>{item.description}</p><span className="status-tag">{item.status}</span></article>)}</div></div>
}

function SettingsPage({ runtime, onRuntimeChange }: {
  runtime: RuntimeStatus | null
  onRuntimeChange: (runtime: RuntimeStatus) => void
}): React.JSX.Element {
  const [providers, setProviders] = useState<ModelProviderStatus[]>([])
  const [editing, setEditing] = useState<ModelProviderId | null>(null)
  const [form, setForm] = useState<SaveModelProviderInput>({ id: 'deepseek-official', apiKey: '' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void window.mindmesh.settings.modelProviders().then(setProviders) }, [])

  async function refreshStatus(nextProviders: ModelProviderStatus[]): Promise<void> {
    setProviders(nextProviders)
    onRuntimeChange(await window.mindmesh.runtime.status())
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
    if (!window.confirm(`移除当前设备上保存的 ${provider.name} API 配置？`)) return
    setSaving(true)
    setError('')
    try {
      await refreshStatus(await window.mindmesh.settings.removeModelProvider(provider.id))
      closeEditor()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  function openEditor(provider: ModelProviderStatus | { id: 'custom' }): void {
    setEditing(provider.id)
    setForm(provider.id === 'custom'
      ? {
          id: 'custom',
          apiKey: '',
          name: 'name' in provider ? provider.name : '自定义服务',
          baseUrl: 'baseUrl' in provider ? provider.baseUrl : 'https://api.example.com/v1',
          model: 'model' in provider ? provider.model : 'your-model-id',
        }
      : { id: provider.id, apiKey: '' })
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
      <header className="page-header"><div><span className="eyebrow">SETTINGS</span><h1>设置</h1><p>连接模型服务，管理应用状态与本地数据。</p></div></header>
      <section className="settings-section">
        <h2>模型服务</h2>
        {providers.map((provider) => (
          <div className="provider-entry" key={provider.id}>
            <div className="setting-row provider-row">
              <ProviderLogo provider={provider.id} />
              <div><strong>{provider.name}</strong><p>{provider.configured ? `${provider.description} 已连接，可以用于智能体对话。` : provider.description}</p></div>
              <span className={`state-badge ${provider.configured ? '' : 'inactive'}`}>{provider.configured ? '已配置' : '需要配置'}</span>
              <button className={provider.configured ? 'secondary-button compact' : 'primary-button compact'} onClick={() => openEditor(provider)}>
                <KeyRound size={15} />{provider.configured ? '编辑' : '连接'}
              </button>
            </div>
            {editing === provider.id && renderProviderForm(provider)}
          </div>
        ))}
        {!customConfigured && (
          <button className="add-provider-row" onClick={() => openEditor({ id: 'custom' })}>
            <span className="provider-add-icon"><Plus size={18} /></span>
            <span><strong>添加自定义服务</strong><small>连接其他兼容 OpenAI API 的模型服务</small></span>
            <ChevronRight size={17} />
          </button>
        )}
        {editing === 'custom' && !customConfigured && renderProviderForm()}
      </section>
      <section className="settings-section"><h2>运行状态</h2><div className="setting-row"><div className="runtime-icon"><Activity size={19} /></div><div><strong>{runtime?.label ?? '检查中'}</strong><p>{runtime?.detail}</p></div><span className={`state-badge ${runtime?.state === 'demo' ? 'inactive' : ''}`}>{runtime?.state === 'demo' ? '等待连接' : '正常'}</span></div></section>
      <section className="settings-section"><h2>本地数据</h2><div className="setting-row"><div className="data-icon"><HardDrive size={19} /></div><div><strong>保存在这台设备上</strong><p>智能体、协作空间和消息不会自动上传到云端。</p></div></div></section>
    </div>
  )

  function renderProviderForm(provider?: ModelProviderStatus): React.JSX.Element {
    return (
      <div className="provider-form">
        <div className="secure-note"><ShieldCheck size={17} /><span><strong>安全保存</strong><small>API Key 经过系统加密，仅保存在这台设备上。</small></span></div>
        {form.id === 'custom' && (
          <div className="custom-provider-fields">
            <Field label="服务名称"><input value={form.name ?? ''} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司内部模型" maxLength={50} /></Field>
            <Field label="API Base URL"><input value={form.baseUrl ?? ''} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="例如：https://api.example.com/v1" /></Field>
            <Field label="模型 ID"><input value={form.model ?? ''} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="例如：my-chat-model" maxLength={100} /></Field>
          </div>
        )}
        <label className="field api-key-field">
          <span>{provider?.name ?? '自定义服务'} API Key</span>
          <div className="secret-input">
            <input autoFocus type={showKey ? 'text' : 'password'} value={form.apiKey} onChange={(event) => { setForm({ ...form, apiKey: event.target.value }); setError('') }} placeholder={`例如：${definition?.apiKeyExample ?? 'your-api-key-0123456789'}`} maxLength={maxLength} autoComplete="off" spellCheck={false} />
            <button type="button" className="icon-button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
          <span className="field-hint"><span>{definition?.apiKeyHint ?? '请输入服务商提供的完整 API Key'}</span><span className={validationError ? 'invalid' : ''}>{form.apiKey.trim().length}/{maxLength}</span></span>
        </label>
        {(validationError || error) && <p className="form-error">{validationError || error}</p>}
        <div className="provider-actions">
          {provider?.source === 'saved' && <button className="danger-button" disabled={saving} onClick={() => void remove(provider)}><Trash2 size={15} />移除</button>}
          <span />
          <button className="secondary-button compact" disabled={saving} onClick={closeEditor}>取消</button>
          <button className="primary-button compact" disabled={saving || !form.apiKey.trim() || validationError !== null} onClick={() => void save()}>{saving ? <span className="spinner" /> : <Check size={15} />}保存</button>
        </div>
      </div>
    )
  }
}

function ProviderLogo({ provider }: { provider: ModelProviderId }): React.JSX.Element {
  const logo = providerLogos[provider]
  return logo
    ? <span className={`provider-logo ${provider}`}><img src={logo} alt="" /></span>
    : <span className="provider-logo custom"><Plus size={19} /></span>
}

function AgentWizard({ initialAgent, onClose, onSaved }: {
  initialAgent?: Agent; onClose: () => void; onSaved: () => Promise<void>
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<CreateAgentInput>(initialAgent ? {
    name: initialAgent.name,
    role: initialAgent.role,
    persona: initialAgent.persona,
    provider: initialAgent.provider,
    model: initialAgent.model,
    skills: initialAgent.skills,
    tools: initialAgent.tools,
  } : defaultAgent)
  const [models, setModels] = useState<ModelOption[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const steps = ['身份', '模型', '技能', '工具']
  const options = step === 2 ? ['研究分析', '报告撰写', '代码审查'] : ['网页搜索', '文件', 'Shell']
  useEffect(() => { void window.mindmesh.catalog.models().then(setModels) }, [])
  const providerIds = [...new Set(models.map((model) => model.provider))]
  const providerModels = models.filter((model) => model.provider === form.provider)
  function selectProvider(provider: string): void {
    const firstModel = models.find((model) => model.provider === provider)
    setForm({ ...form, provider, model: firstModel?.id ?? '' })
  }
  function toggle(value: string): void { const key = step === 2 ? 'skills' : 'tools'; setForm((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value] })) }
  async function next(): Promise<void> {
    if (step < 3) { setStep(step + 1); return }
    setSaving(true)
    setError('')
    try {
      if (initialAgent) await window.mindmesh.agents.update(initialAgent.id, form)
      else await window.mindmesh.agents.create(form)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存智能体失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="wizard">
        <header><div><span className="eyebrow">{initialAgent ? 'EDIT AGENT' : 'CREATE AGENT'}</span><h2>{initialAgent ? '编辑智能体' : '创建你的智能体'}</h2><p>定义它是谁、会什么，以及可以使用哪些工具。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="stepper">{steps.map((label, index) => <div key={label} className={index === step ? 'current' : index < step ? 'done' : ''}><i>{index < step ? '✓' : index + 1}</i><span>{label}</span></div>)}</div>
        <div className="wizard-body">
          {step === 0 && <><h3>它是谁？</h3><div className="avatar-picker"><Avatar name={form.name || 'M'} large /><button className="secondary-button">选择头像</button><small>MVP 使用默认头像</small></div><Field label="名称"><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 Researcher" /></Field><Field label="角色定位"><input value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} placeholder="例如 研究分析专家" /></Field><Field label="身份设定"><textarea value={form.persona} onChange={(event) => setForm({ ...form, persona: event.target.value })} placeholder="描述它是谁、擅长什么，以及应该如何回答。" /></Field></>}
          {step === 1 && <><h3>选择模型</h3><Field label="模型服务商"><select value={form.provider} onChange={(event) => selectProvider(event.target.value)}>{providerIds.map((provider) => <option key={provider} value={provider}>{provider === 'custom' ? '自定义服务' : getModelProviderDefinition(provider)?.name ?? provider}</option>)}</select></Field><Field label="模型"><select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>{providerModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field><div className="info-box"><CircleHelp size={18} /><p>不同模型在推理、编程、创作和速度方面各有特点。</p></div></>}
          {(step === 2 || step === 3) && <><h3>{step === 2 ? '它会什么？' : '它可以使用哪些工具？'}</h3><div className="choice-list">{options.map((option) => { const checked = (step === 2 ? form.skills : form.tools).includes(option); return <button key={option} className={checked ? 'checked' : ''} onClick={() => toggle(option)}><i>{checked ? '✓' : '+'}</i><span><strong>{option}</strong><small>{step === 2 ? '为智能体添加可复用能力' : '允许智能体调用此工具'}</small></span></button> })}</div></>}
        </div>
        <footer>{error && <p className="form-error" role="alert">{error}</p>}<button className="secondary-button" disabled={saving} onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? '取消' : '上一步'}</button><button className="primary-button" disabled={saving || (step === 0 && (!form.name.trim() || !form.persona.trim()))} onClick={() => void next()}>{step === 3 ? (initialAgent ? '保存修改' : '创建智能体') : '下一步'} <ChevronRight size={16} /></button></footer>
      </div>
    </div>
  )
}

function SpaceWizard({ agents, onClose, onCreated }: { agents: Agent[]; onClose: () => void; onCreated: () => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [context, setContext] = useState('')
  const [members, setMembers] = useState<string[]>([])
  async function create(): Promise<void> { await window.mindmesh.spaces.create({ name, description, context, memberIds: members }); await onCreated() }
  return <div className="modal-backdrop"><div className="wizard compact"><header><div><span className="eyebrow">NEW SPACE</span><h2>创建协作空间</h2><p>让多个智能体共享背景并一起协作。</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header><div className="wizard-body"><Field label="空间名称"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 AI Product Research" /></Field><Field label="简介"><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个空间用来做什么？" /></Field><Field label="背景信息"><textarea value={context} onChange={(event) => setContext(event.target.value)} placeholder="当前目标、项目背景、主要限制和关键规则" /></Field><label className="field"><span>添加智能体</span><div className="member-choices">{agents.map((agent) => <button key={agent.id} className={members.includes(agent.id) ? 'selected' : ''} onClick={() => setMembers((items) => items.includes(agent.id) ? items.filter((id) => id !== agent.id) : [...items, agent.id])}><Avatar name={agent.name} />{agent.name}</button>)}</div></label></div><footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name} onClick={() => void create()}>创建空间</button></footer></div></div>
}

function AgentDrawer({ agent, onClose, onChat, onEdit }: {
  agent?: Agent; onClose: () => void; onChat: (id: string) => void; onEdit: (id: string) => void
}): React.JSX.Element | null {
  if (!agent) return null
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="agent-drawer" onMouseDown={(event) => event.stopPropagation()}><header><Avatar name={agent.name} large /><div><h2>{agent.name}</h2><p>{agent.role}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><section><span className="eyebrow">身份设定</span><p>{agent.persona}</p></section><section><span className="eyebrow">模型</span><p><em>{agent.model}</em></p></section><section><span className="eyebrow">技能</span><div className="tags">{agent.skills.map((item) => <i key={item}>{item}</i>)}</div></section><section><span className="eyebrow">工具</span><div className="tags">{agent.tools.map((item) => <i key={item}>{item}</i>)}</div></section><footer><button className="primary-button" onClick={() => onChat(agent.id)}>开始对话</button><button className="secondary-button" onClick={() => onEdit(agent.id)}>编辑智能体</button></footer></aside></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <label className="field"><span>{label}</span>{children}</label> }
function Avatar({ name, large = false }: { name: string; large?: boolean }): React.JSX.Element { const initials = name.trim().slice(0, 2).toUpperCase() || 'M'; return <span className={large ? 'avatar large' : 'avatar'}>{initials}</span> }
