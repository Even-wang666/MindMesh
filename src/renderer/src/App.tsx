import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity, Bot, Boxes, Check, ChevronRight, CircleHelp, Command, Eye, EyeOff, HardDrive,
  KeyRound, Library, MessageCircle, MoreHorizontal, Plus, Search, Send, Settings,
  ShieldCheck, Sparkles, Trash2, Wrench, X,
} from 'lucide-react'
import type {
  Agent, ChatProgress, CreateAgentInput, Message, ModelProviderId, ModelProviderStatus, RuntimeStatus,
  SaveModelProviderInput, Space, UserProfile,
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
const defaultProfile: UserProfile = { name: '你', avatar: null }

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chats')
  const [agents, setAgents] = useState<Agent[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [profile, setProfile] = useState<UserProfile>(defaultProfile)
  const [agentWizard, setAgentWizard] = useState(false)
  const [spaceWizard, setSpaceWizard] = useState(false)
  const [editingSpaceId, setEditingSpaceId] = useState('')
  const [detailAgentId, setDetailAgentId] = useState<string>('')
  const [editingAgentId, setEditingAgentId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ChatProgress | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const liveReplyIds = useRef(new Set<string>())

  const conversation = view === 'chats' ? `private:${selectedAgentId}` : view === 'spaces' ? `space:${selectedSpaceId}` : ''
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId)

  async function refresh(): Promise<void> {
    const [nextAgents, nextSpaces, status, nextProfile] = await Promise.all([
      window.mindmesh.agents.list(), window.mindmesh.spaces.list(), window.mindmesh.runtime.status(), window.mindmesh.settings.profile(),
    ])
    setAgents(nextAgents)
    setSpaces(nextSpaces)
    setRuntime(status)
    setProfile(nextProfile)
    setSelectedAgentId((current) => nextAgents.some((agent) => agent.id === current) ? current : nextAgents[0]?.id || '')
    setSelectedSpaceId((current) => nextSpaces.some((space) => space.id === current) ? current : nextSpaces[0]?.id || '')
  }

  useEffect(() => { void refresh() }, [])
  function showLiveMessages(next: Message[]): void {
    setMessages((current) => {
      const known = new Set(current.map((message) => message.id))
      for (const message of next) {
        if (message.authorType === 'agent' && !known.has(message.id)) liveReplyIds.current.add(message.id)
      }
      return next
    })
  }
  useEffect(() => {
    const offProgress = window.mindmesh.chat.onProgress((event) => {
      setProgress(event)
      setStreamingText('')
      if (event.scope === 'space') {
        void window.mindmesh.chat.messages(event.scope, event.scopeId).then((next) => {
          if (conversationRef.current === `${event.scope}:${event.scopeId}`) showLiveMessages(next)
        })
      }
    })
    const offDelta = window.mindmesh.chat.onDelta((event) => {
      if (conversationRef.current === `${event.scope}:${event.scopeId}`) {
        setStreamingText((current) => current + event.text)
      }
    })
    return () => { offProgress(); offDelta() }
  }, [])
  useEffect(() => {
    const scope = view === 'spaces' ? 'space' : 'private'
    const id = view === 'spaces' ? selectedSpaceId : selectedAgentId
    if (!id || (view !== 'chats' && view !== 'spaces')) return
    let active = true
    setMessages([])
    setStreamingText('')
    liveReplyIds.current.clear()
    void window.mindmesh.chat.messages(scope, id).then((next) => { if (active) setMessages(next) })
    return () => { active = false }
  }, [view, selectedAgentId, selectedSpaceId])

  async function send(content: string): Promise<void> {
    if (!content.trim() || busy) return
    const scope = view === 'chats' ? 'private' : 'space'
    const id = view === 'chats' ? selectedAgentId : selectedSpaceId
    if (!id || (view !== 'chats' && view !== 'spaces')) return
    const requestConversation = `${scope}:${id}`
    setBusy(true)
    setStreamingText('')
    setMessages((current) => [...current, {
      id: crypto.randomUUID(), scope, scopeId: id, authorType: 'user', authorName: profile.name,
      content: content.trim(), sequence: 0, createdAt: new Date().toISOString(),
    }])
    if (scope === 'private' && selectedAgent) {
      setProgress({ scope, scopeId: id, agentName: selectedAgent.name })
    }
    try {
      const result = scope === 'private'
        ? await window.mindmesh.chat.sendPrivate(id, content.trim())
        : await window.mindmesh.chat.sendSpace(id, content.trim())
      if (conversationRef.current === requestConversation) {
        showLiveMessages(result)
        setStreamingText('')
      }
      setRuntime(await window.mindmesh.runtime.status())
    } finally {
      setProgress(null)
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
            ? <ChatPanel title={selectedAgent.name} subtitle={selectedAgent.role} messages={messages} profile={profile} busy={busy} streamingText={streamingText} liveReplyIds={liveReplyIds.current} progress={progress?.scope === 'private' && progress.scopeId === selectedAgent.id ? progress.agentName : undefined} onSend={send} onDetail={() => setDetailAgentId(selectedAgent.id)} />
            : <EmptyState onCreate={() => setAgentWizard(true)} />
        )}
        {view === 'spaces' && (selectedSpace ? (
          <SpacePanel key={selectedSpace.id} space={selectedSpace} agents={agents} messages={messages} profile={profile} busy={busy} streamingText={streamingText} liveReplyIds={liveReplyIds.current} progress={progress?.scope === 'space' && progress.scopeId === selectedSpace.id ? progress.agentName : undefined} onSend={send} onEdit={() => setEditingSpaceId(selectedSpace.id)} onRemove={async (id) => { await window.mindmesh.spaces.remove(id); await refresh() }} onUpdateContext={async (id, context) => {
            const updated = await window.mindmesh.spaces.updateContext(id, context)
            setSpaces((current) => current.map((space) => space.id === id ? updated : space))
          }} />
        ) : <div className="empty-state"><BrandLogo size={76} /><h1>还没有协作空间</h1><p>创建空间，邀请智能体一起讨论。</p><button className="primary-button" onClick={() => setSpaceWizard(true)}><Plus size={17} />创建空间</button></div>)}
        {view === 'agents' && <AgentsPage agents={agents} onCreate={() => setAgentWizard(true)} onDetail={setDetailAgentId} />}
        {view === 'skills' && <CatalogPage kind="skills" />}
        {view === 'tools' && <CatalogPage kind="tools" />}
        {view === 'settings' && <SettingsPage runtime={runtime} profile={profile} busy={busy} onProfileChange={setProfile} onRuntimeChange={setRuntime} />}
      </section>
      {agentWizard && <AgentWizard onClose={() => setAgentWizard(false)} onSaved={async () => { setAgentWizard(false); await refresh() }} />}
      {editingAgentId && <AgentWizard initialAgent={agents.find((item) => item.id === editingAgentId)} onClose={() => setEditingAgentId('')} onSaved={async () => { setEditingAgentId(''); await refresh() }} />}
      {spaceWizard && <SpaceWizard agents={agents} onClose={() => setSpaceWizard(false)} onSaved={async () => { setSpaceWizard(false); await refresh() }} />}
      {editingSpaceId && <SpaceWizard agents={agents} initialSpace={spaces.find((item) => item.id === editingSpaceId)} onClose={() => setEditingSpaceId('')} onSaved={async () => { setEditingSpaceId(''); await refresh() }} />}
      {detailAgentId && <AgentDrawer agent={agents.find((item) => item.id === detailAgentId)} onClose={() => setDetailAgentId('')} onChat={(id) => { setSelectedAgentId(id); setView('chats'); setDetailAgentId('') }} onEdit={(id) => { setDetailAgentId(''); setEditingAgentId(id) }} onRemove={async (id) => { await window.mindmesh.agents.remove(id); setDetailAgentId(''); await refresh() }} />}
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

function ChatPanel({ title, subtitle, messages, profile, busy, progress, streamingText, liveReplyIds, onSend, onDetail }: {
  title: string; subtitle: string; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; liveReplyIds: Set<string>
  onSend: (content: string) => Promise<void>; onDetail: () => void
}): React.JSX.Element {
  return (
    <div className="page chat-page">
      <header className="chat-header"><div><h1>{title}</h1><p>{subtitle}</p></div><button className="ghost-button" onClick={onDetail}>查看详情 <ChevronRight size={15} /></button></header>
      <MessageList messages={messages} profile={profile} emptyText="开始一段新的对话" progress={progress} streamingText={streamingText} liveReplyIds={liveReplyIds} />
      <Composer busy={busy} placeholder={`给 ${title} 发送消息…`} onSend={onSend} />
    </div>
  )
}

function SpacePanel({ space, agents, messages, profile, busy, progress, streamingText, liveReplyIds, onSend, onEdit, onRemove, onUpdateContext }: {
  space: Space; agents: Agent[]; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; liveReplyIds: Set<string>
  onSend: (content: string) => Promise<void>; onEdit: () => void; onRemove: (id: string) => Promise<void>; onUpdateContext: (id: string, context: string) => Promise<void>
}): React.JSX.Element {
  const members = agents.filter((agent) => space.memberIds.includes(agent.id))
  const [editingContext, setEditingContext] = useState(false)
  const [contextDraft, setContextDraft] = useState(space.context)
  const [savingContext, setSavingContext] = useState(false)
  const [contextError, setContextError] = useState('')
  const [removeError, setRemoveError] = useState('')
  const [removing, setRemoving] = useState(false)
  async function remove(): Promise<void> {
    if (!window.confirm(`确定删除协作空间「${space.name}」吗？空间及其聊天消息会从应用中删除。`)) return
    setRemoving(true)
    setRemoveError('')
    try { await onRemove(space.id) }
    catch { setRemoveError('删除失败，请重试。'); setRemoving(false) }
  }
  async function saveContext(): Promise<void> {
    setSavingContext(true)
    setContextError('')
    try {
      await onUpdateContext(space.id, contextDraft.trim())
      setEditingContext(false)
    } catch {
      setContextError('保存失败，请重试。')
    } finally {
      setSavingContext(false)
    }
  }
  return (
    <div className="page space-page">
      <header className="chat-header"><div><h1>{space.name}</h1><p>{members.length} 个智能体 · {space.description}</p>{removeError && <p className="form-error" role="alert">{removeError}</p>}</div><div className="space-header-actions"><button className="ghost-button" disabled={busy || removing} onClick={onEdit}>编辑空间 <ChevronRight size={15} /></button><button className="danger-button" disabled={busy || removing} onClick={() => void remove()}><Trash2 size={15} />删除空间</button></div></header>
      <div className="space-layout">
        <div className="space-chat"><MessageList messages={messages} profile={profile} emptyText="使用 @智能体 开始协作" progress={progress} streamingText={streamingText} liveReplyIds={liveReplyIds} /><Composer busy={busy} placeholder="@智能体 输入消息…" members={members} onSend={onSend} /></div>
        <aside className="context-drawer"><span className="eyebrow">成员</span>{members.map((agent) => <div className="member" key={agent.id}><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span><i /></div>)}<hr /><span className="eyebrow">背景信息</span>{editingContext ? <div className="context-editor"><textarea aria-label="背景信息" autoFocus value={contextDraft} onChange={(event) => setContextDraft(event.target.value)} />{contextError && <p className="form-error" role="alert">{contextError}</p>}<div><button className="secondary-button" disabled={savingContext} onClick={() => setEditingContext(false)}>取消</button><button className="primary-button" disabled={savingContext} onClick={() => void saveContext()}>保存背景</button></div></div> : <><p>{space.context || '暂无背景信息。'}</p><button className="text-button" onClick={() => { setContextDraft(space.context); setContextError(''); setEditingContext(true) }}>编辑背景</button></>}</aside>
      </div>
    </div>
  )
}

function MessageList({ messages, profile, emptyText, progress, streamingText, liveReplyIds }: { messages: Message[]; profile: UserProfile; emptyText: string; progress?: string; streamingText: string; liveReplyIds: Set<string> }): React.JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, progress, streamingText])
  if (!messages.length && !progress && !streamingText) return <div className="conversation-empty"><BrandLogo size={54} /><h3>{emptyText}</h3><p>消息仅保存在这台设备上。</p></div>
  return <div className="messages">{messages.map((message) => <article key={message.id} className={`message ${message.authorType}`}><Avatar name={message.authorType === 'user' ? profile.name : message.authorName} image={message.authorType === 'user' ? profile.avatar : null} /><div><header><strong>{message.authorType === 'user' ? profile.name : message.authorName}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header><MessageBody content={message.content} animated={liveReplyIds.has(message.id)} /></div></article>)}{(progress || streamingText) && <article className="message agent"><Avatar name={progress ?? '智能体'} /><div><header><strong>{progress ?? '智能体'}</strong></header>{streamingText ? <MessageBody content={streamingText} animated /> : <div className="chat-progress" role="status"><span className="chat-progress-dot" />思考中…</div>}</div></article>}<div ref={end} /></div>
}

function MessageBody({ content, animated = false }: { content: string; animated?: boolean }): React.JSX.Element {
  const [visible, setVisible] = useState(animated ? '' : content)
  useEffect(() => {
    if (!animated || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setVisible(content); return }
    const characters = Array.from(content)
    const perFrame = Math.max(1, Math.ceil(characters.length / 60))
    let count = content.startsWith(visible) ? Array.from(visible).length : 0
    const timer = window.setInterval(() => {
      count = Math.min(count + perFrame, characters.length)
      setVisible(characters.slice(0, count).join(''))
      if (count === characters.length) window.clearInterval(timer)
    }, 25)
    return () => window.clearInterval(timer)
  }, [animated, content])
  return <div className="message-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{visible}</ReactMarkdown></div>
}

function Composer({ busy, placeholder, members = [], onSend }: { busy: boolean; placeholder: string; members?: Agent[]; onSend: (value: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const showMentions = members.length > 0 && /(^|\s)@[\w-]*$/.test(value)
  async function submit(): Promise<void> { const current = value; if (busy || !current.trim()) return; setValue(''); await onSend(current) }
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

function ProfileSettings({ profile, onSaved }: { profile: UserProfile; onSaved: (profile: UserProfile) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setDraft(profile), [profile])

  function chooseAvatar(file?: File): void {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 1_000_000) {
      setError('请选择不超过 1 MB 的 PNG、JPEG、WebP 或 GIF 图片')
      return
    }
    setReading(true)
    const reader = new FileReader()
    reader.onload = () => {
      const image = reader.result
      if (typeof image === 'string') { setDraft((current) => ({ ...current, avatar: image })); setError('') }
      else setError('无法读取图片，请重试')
      setReading(false)
    }
    reader.onerror = () => { setError('无法读取图片，请重试'); setReading(false) }
    reader.readAsDataURL(file)
  }

  async function saveProfile(): Promise<void> {
    if (!draft.name.trim()) { setError('请输入昵称'); return }
    setSaving(true)
    setError('')
    try {
      const saved = await window.mindmesh.settings.saveProfile(draft)
      setDraft(saved)
      onSaved(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return <section className="settings-section profile-section"><h2>个人资料</h2><div className="profile-form"><div className="profile-avatar"><Avatar name={draft.name} image={draft.avatar} large /><div><label className="secondary-button compact" htmlFor="profile-avatar-input">选择头像</label><input id="profile-avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => chooseAvatar(event.target.files?.[0])} />{draft.avatar && <button className="text-button" onClick={() => setDraft({ ...draft, avatar: null })}>移除头像</button>}<small>PNG、JPEG、WebP 或 GIF，最大 1 MB</small></div></div><label className="field"><span>展示昵称</span><input value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button compact" disabled={saving || reading} onClick={() => void saveProfile()}>保存个人资料</button></div></section>
}

function SettingsPage({ runtime, profile, busy, onProfileChange, onRuntimeChange }: {
  runtime: RuntimeStatus | null
  profile: UserProfile
  busy: boolean
  onProfileChange: (profile: UserProfile) => void
  onRuntimeChange: (runtime: RuntimeStatus) => void
}): React.JSX.Element {
  const [providers, setProviders] = useState<ModelProviderStatus[]>([])
  const [editing, setEditing] = useState<ModelProviderId | null>(null)
  const [form, setForm] = useState<SaveModelProviderInput>({ id: 'deepseek-official', apiKey: '' })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)

  useEffect(() => { void window.mindmesh.settings.modelProviders().then(setProviders) }, [])
  useEffect(() => { void window.mindmesh.settings.workspace().then(setWorkspace) }, [])

  async function chooseWorkspace(): Promise<void> {
    setChoosingWorkspace(true)
    setWorkspaceError('')
    try {
      setWorkspace(await window.mindmesh.settings.chooseWorkspace())
      onRuntimeChange(await window.mindmesh.runtime.status())
    } catch {
      setWorkspaceError('无法切换工作目录，请重试。')
    } finally {
      setChoosingWorkspace(false)
    }
  }

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
      <ProfileSettings profile={profile} onSaved={onProfileChange} />
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
      <section className="settings-section"><h2>本地文件</h2><div className="setting-row"><div className="data-icon"><HardDrive size={19} /></div><div><strong>Agent 工作目录</strong><p className="workspace-path">{workspace || '读取中…'}</p><small>在 Agent 编辑页启用“文件”工具后即可使用。文件写入限制在此目录；切换后模型会话重新开始，聊天消息仍保留。</small>{workspaceError && <p className="form-error" role="alert">{workspaceError}</p>}</div><button className="secondary-button compact" disabled={busy || choosingWorkspace} onClick={() => void chooseWorkspace()}>选择文件夹</button></div></section>
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
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const steps = ['身份', '模型', '技能', '工具']
  const options = step === 2 ? skills : tools
  useEffect(() => {
    void Promise.all([window.mindmesh.catalog.models(), window.mindmesh.catalog.skills(), window.mindmesh.catalog.tools()])
      .then(([nextModels, nextSkills, nextTools]) => { setModels(nextModels); setSkills(nextSkills); setTools(nextTools) })
  }, [])
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
          {(step === 2 || step === 3) && <><h3>{step === 2 ? '它会什么？' : '它可以使用哪些工具？'}</h3><div className="choice-list">{options.map((option) => { const checked = (step === 2 ? form.skills : form.tools).includes(option.name); return <button key={option.name} className={checked ? 'checked' : ''} onClick={() => toggle(option.name)}><i>{checked ? '✓' : '+'}</i><span><strong>{option.name}</strong><small>{option.description}</small></span></button> })}</div></>}
        </div>
        <footer>{error && <p className="form-error" role="alert">{error}</p>}<button className="secondary-button" disabled={saving} onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? '取消' : '上一步'}</button><button className="primary-button" disabled={saving || (step === 0 && (!form.name.trim() || !form.persona.trim()))} onClick={() => void next()}>{step === 3 ? (initialAgent ? '保存修改' : '创建智能体') : '下一步'} <ChevronRight size={16} /></button></footer>
      </div>
    </div>
  )
}

function SpaceWizard({ agents, initialSpace, onClose, onSaved }: { agents: Agent[]; initialSpace?: Space; onClose: () => void; onSaved: () => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(initialSpace?.name ?? '')
  const [description, setDescription] = useState(initialSpace?.description ?? '')
  const [context, setContext] = useState(initialSpace?.context ?? '')
  const [members, setMembers] = useState<string[]>(initialSpace?.memberIds ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function save(): Promise<void> {
    setSaving(true)
    setError('')
    try {
      const input = { name, description, context, memberIds: members }
      if (initialSpace) await window.mindmesh.spaces.update(initialSpace.id, input)
      else await window.mindmesh.spaces.create(input)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return <div className="modal-backdrop"><div className="wizard compact"><header><div><span className="eyebrow">{initialSpace ? 'EDIT SPACE' : 'NEW SPACE'}</span><h2>{initialSpace ? '编辑协作空间' : '创建协作空间'}</h2><p>让多个智能体共享背景并一起协作。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="wizard-body"><Field label="空间名称"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 AI Product Research" /></Field><Field label="简介"><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个空间用来做什么？" /></Field><Field label="背景信息"><textarea value={context} onChange={(event) => setContext(event.target.value)} placeholder="当前目标、项目背景、主要限制和关键规则" /></Field><label className="field"><span>添加智能体</span><div className="member-choices">{agents.map((agent) => <button key={agent.id} type="button" aria-label={agent.name} aria-pressed={members.includes(agent.id)} className={members.includes(agent.id) ? 'selected' : ''} onClick={() => setMembers((items) => items.includes(agent.id) ? items.filter((id) => id !== agent.id) : [...items, agent.id])}><Avatar name={agent.name} />{agent.name}</button>)}</div></label></div><footer>{error && <p className="form-error" role="alert">{error}</p>}<button className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !name.trim()} onClick={() => void save()}>{initialSpace ? '保存修改' : '创建空间'}</button></footer></div></div>
}

function AgentDrawer({ agent, onClose, onChat, onEdit, onRemove }: {
  agent?: Agent; onClose: () => void; onChat: (id: string) => void; onEdit: (id: string) => void; onRemove: (id: string) => Promise<void>
}): React.JSX.Element | null {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  if (!agent) return null
  async function remove(): Promise<void> {
    if (!agent || !window.confirm(`确定删除智能体「${agent.name}」吗？该操作会将其从协作空间移除。`)) return
    setRemoving(true)
    setError('')
    try { await onRemove(agent.id) }
    catch { setError('删除失败，请重试。'); setRemoving(false) }
  }
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="agent-drawer" onMouseDown={(event) => event.stopPropagation()}><header><Avatar name={agent.name} large /><div><h2>{agent.name}</h2><p>{agent.role}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><section><span className="eyebrow">身份设定</span><p>{agent.persona}</p></section><section><span className="eyebrow">模型</span><p><em>{agent.model}</em></p></section><section><span className="eyebrow">技能</span><div className="tags">{agent.skills.map((item) => <i key={item}>{item}</i>)}</div></section><section><span className="eyebrow">工具</span><div className="tags">{agent.tools.map((item) => <i key={item}>{item}</i>)}</div></section><footer>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={removing} onClick={() => onChat(agent.id)}>开始对话</button><button className="secondary-button" disabled={removing} onClick={() => onEdit(agent.id)}>编辑智能体</button><button className="danger-button" disabled={removing} onClick={() => void remove()}><Trash2 size={15} />删除智能体</button></footer></aside></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <label className="field"><span>{label}</span>{children}</label> }
function Avatar({ name, image, large = false }: { name: string; image?: string | null; large?: boolean }): React.JSX.Element { const initials = name.trim().slice(0, 2).toUpperCase() || 'M'; return <span className={large ? 'avatar large' : 'avatar'}>{image ? <img src={image} alt="" /> : initials}</span> }
