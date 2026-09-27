import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot, Boxes, ChevronDown, ChevronRight, Command, Library, MessageCircle, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Search, Send, Settings, ShieldCheck, Sparkles, Square, Trash2, Wrench, X,
} from 'lucide-react'
import type {
  Agent, CatalogItem, ChatImageAttachment, ChatImageMediaType, ChatPermission, ChatRunOptions, Message, ModelOption, RuntimeStatus,
  SkillInstallProgress, Space, UserProfile,
} from '../../shared/contracts'
import {
  getModelContextWindow, reasoningEffortOptions, supportsImageInput,
} from '../../shared/model-providers'
import { parseMentions } from '../../shared/domain'
import { skillDisplayName } from '../../shared/skill-reference'
import { getChatContentError } from '../../shared/chat-content'
import { BrandLogo } from './BrandLogo'
import { PaneResizer, usePaneShares } from './PaneLayout'
import { Avatar, Field } from './Ui'
import { AgentWizard, SpaceWizard } from './Wizards'
import { ConfirmContext, ConfirmDialog, useConfirm, type ConfirmRequest } from './ConfirmDialog'
import { SettingsPage } from './SettingsPage'
import { getProviderLogo } from './ProviderLogos'
import { useChatController } from './useChatController'

type View = 'chats' | 'spaces' | 'agents' | 'skills' | 'tools' | 'settings'
const defaultProfile: UserProfile = { name: '你', avatar: null }

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chats')
  const [agents, setAgents] = useState<Agent[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [profile, setProfile] = useState<UserProfile>(defaultProfile)
  const [models, setModels] = useState<ModelOption[]>([])
  const [agentWizard, setAgentWizard] = useState(false)
  const [spaceWizard, setSpaceWizard] = useState(false)
  const [editingSpaceId, setEditingSpaceId] = useState('')
  const [detailAgentId, setDetailAgentId] = useState<string>('')
  const [editingAgentId, setEditingAgentId] = useState<string>('')
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const appRef = useRef<HTMLElement | null>(null)
  const [shares, setShares] = usePaneShares(appRef)

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId)
  const chatTarget = view === 'chats' && selectedAgentId
    ? { scope: 'private' as const, id: selectedAgentId, agent: selectedAgent }
    : view === 'spaces' && selectedSpaceId
      ? { scope: 'space' as const, id: selectedSpaceId }
      : null
  const { messages, busy, progress, streamingText, streamingReasoning, liveReplyIds, send, stop } = useChatController(
    chatTarget, profile.name, setRuntime,
  )

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

  async function refreshModels(): Promise<void> {
    try { setModels(await window.mindmesh.catalog.models()) }
    catch { setModels([]) }
  }

  useEffect(() => {
    void refresh()
    void refreshModels()
  }, [])
  /* 是否处于「导航 + 列表 + 内容」这个三栏形态。两栏形态（智能体/技能/工具/
     设置）下没有列表，分隔条也就少一条 —— 但导航那一条始终保留，
     所以两栏时拖的是「导航 ↔ 内容」，导航宽度在三栏/两栏之间仍然一致。 */
  const hasList = view === 'chats' || view === 'spaces'
  const resetShares = (): void => setShares(null)
  return (
    <ConfirmContext.Provider value={setConfirmRequest}>
    <main
      className={shares ? 'app-shell has-custom-pane-shares' : 'app-shell'}
      ref={appRef}
      /* 只在**用户拖过之后**才写行内变量；没拖过就让 styles.css 里的默认值生效，
         这样「默认比例」始终只有一份定义（在样式表里），两处不会分叉。 */
      style={shares ? ({
        '--nav-share': `${shares.nav}%`,
        '--list-share': `${shares.list}%`,
      } as React.CSSProperties) : undefined}
    >
      <PrimaryNav view={view} onView={setView} runtime={runtime} />
      <PaneResizer index={0} appRef={appRef} onShares={setShares} onReset={resetShares} />
      {hasList && (
        <ObjectList
          view={view}
          agents={agents}
          spaces={spaces}
          selectedId={view === 'chats' ? selectedAgentId : selectedSpaceId}
          onSelect={view === 'chats' ? setSelectedAgentId : setSelectedSpaceId}
          onCreate={() => view === 'chats' ? setAgentWizard(true) : setSpaceWizard(true)}
        />
      )}
      {hasList && <PaneResizer index={1} appRef={appRef} onShares={setShares} onReset={resetShares} />}
      <section className={hasList ? 'content has-list' : 'content'}>
        {view === 'chats' && (
          selectedAgent
            ? <ChatPanel key={selectedAgent.id} agent={selectedAgent} models={models} messages={messages} profile={profile} busy={busy} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds} progress={progress?.scope === 'private' && progress.scopeId === selectedAgent.id ? progress.agentName : undefined} onSend={send} onStop={stop} onDetail={() => setDetailAgentId(selectedAgent.id)} />
            : <EmptyState onCreate={() => setAgentWizard(true)} />
        )}
        {view === 'spaces' && (selectedSpace ? (
          <SpacePanel key={selectedSpace.id} space={selectedSpace} agents={agents} models={models} messages={messages} profile={profile} busy={busy} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds} progress={progress?.scope === 'space' && progress.scopeId === selectedSpace.id ? progress.agentName : undefined} onSend={send} onStop={stop} onEdit={() => setEditingSpaceId(selectedSpace.id)} onRemove={async (id) => { await window.mindmesh.spaces.remove(id); await refresh() }} onUpdateContext={async (id, context) => {
            const updated = await window.mindmesh.spaces.updateContext(id, context)
            setSpaces((current) => current.map((space) => space.id === id ? updated : space))
          }} onUpdateAgent={async (agent) => {
            const saved = await window.mindmesh.agents.update(agent.id, {
              name: agent.name, role: agent.role, persona: agent.persona, provider: agent.provider,
              model: agent.model, skills: agent.skills, tools: agent.tools, reasoningEffort: agent.reasoningEffort,
            })
            setAgents((current) => current.map((item) => item.id === saved.id ? saved : item))
          }} />
        ) : <div className="page center-page"><div className="empty-state"><span className="empty-mark"><BrandLogo size={38} /></span><h1>还没有协作空间</h1><p>创建空间，邀请智能体一起讨论。</p><button className="primary-button" onClick={() => setSpaceWizard(true)}><Plus size={17} />创建空间</button></div></div>)}
        {view === 'agents' && <AgentsPage agents={agents} onCreate={() => setAgentWizard(true)} onDetail={setDetailAgentId} />}
        {view === 'skills' && <CatalogPage kind="skills" />}
        {view === 'tools' && <CatalogPage kind="tools" />}
        {view === 'settings' && <SettingsPage runtime={runtime} profile={profile} busy={busy} onProfileChange={setProfile} onRuntimeChange={setRuntime} onProviderChange={refreshModels} />}
      </section>
      {agentWizard && <AgentWizard onClose={() => setAgentWizard(false)} onSaved={async () => { setAgentWizard(false); await refresh() }} />}
      {editingAgentId && <AgentWizard initialAgent={agents.find((item) => item.id === editingAgentId)} onClose={() => setEditingAgentId('')} onSaved={async () => { setEditingAgentId(''); await refresh() }} />}
      {spaceWizard && <SpaceWizard agents={agents} onClose={() => setSpaceWizard(false)} onSaved={async () => { setSpaceWizard(false); await refresh() }} />}
      {editingSpaceId && <SpaceWizard agents={agents} initialSpace={spaces.find((item) => item.id === editingSpaceId)} onClose={() => setEditingSpaceId('')} onSaved={async () => { setEditingSpaceId(''); await refresh() }} />}
      {detailAgentId && <AgentDrawer agent={agents.find((item) => item.id === detailAgentId)} onClose={() => setDetailAgentId('')} onChat={(id) => { setSelectedAgentId(id); setView('chats'); setDetailAgentId('') }} onEdit={(id) => { setDetailAgentId(''); setEditingAgentId(id) }} onRemove={async (id) => { await window.mindmesh.agents.remove(id); setDetailAgentId(''); await refresh() }} />}
      {confirmRequest && <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
    </main>
    </ConfirmContext.Provider>
  )
}

/**
 * 导航折叠状态：只由用户手动决定。
 *
 * 这里原先还有一条「窗口窄于 1080px 时自动折叠」的规则。窗口最小尺寸是
 * 1200×720（src/main/index.ts），1080 那条断点**永远不会命中** —— 是纯粹
 * 不可达的死逻辑，所以连同 matchMedia 监听一起删掉了。现在折叠的唯一触发者
 * 是导航底部那个开关，任何窗口尺寸下三栏都保持默认比例。
 *
 * 折叠后的样子全部定义在 styles.css 的 `.primary-nav.is-collapsed` 里，是
 * **唯一**一处定义（含折叠态列表/内容改按剩余空间比例分的那两条兄弟选择器）；
 * 不要在媒体查询里重复这组声明，否则两处一旦分叉就会出现
 * 「某个宽度下控件静默消失」那类事故。
 */
function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false)
  return [collapsed, () => setCollapsed((current) => !current)]
}

/**
 * 一级导航。
 *
 * 白底方案下，颜色只落在图标上：未选中是黑色线稿，选中才亮出该项的专属色
 * （见 styles.css 的 --p-nav-tone-*）。所以每个按钮必须带 `data-nav`，
 * 它既是 CSS 取色相的依据，也是预览生成器里深链/交互的锚点。
 * ⚠️ 新增导航项时，`data-nav` 的取值要同时在 styles.css 的
 *    `.nav-item[data-nav='…']` 里补一行，否则会静默落回品牌灰紫兜底色。
 */
function PrimaryNav({ view, onView, runtime }: { view: View; onView: (view: View) => void; runtime: RuntimeStatus | null }): React.JSX.Element {
  const [collapsed, toggleCollapsed] = useNavCollapsed()
  const groups: Array<{ label: string; items: Array<{ id: View; label: string; icon: React.ElementType }> }> = [
    { label: '工作区', items: [
      { id: 'chats', label: '对话', icon: MessageCircle },
      { id: 'spaces', label: '协作空间', icon: Boxes },
    ] },
    { label: '资源', items: [
      { id: 'agents', label: '智能体', icon: Bot },
      { id: 'skills', label: '技能', icon: Library },
      { id: 'tools', label: '工具', icon: Wrench },
    ] },
  ]
  const runtimeTone = runtime?.state === 'error' ? 'dot danger' : runtime?.state === 'demo' ? 'dot warn' : 'dot'
  return (
    <aside className={collapsed ? 'primary-nav is-collapsed' : 'primary-nav'}>
      <BrandLogo wordmark size={36} />
      {groups.map((group) => (
        <div className="nav-group" key={group.label}>
          <span className="nav-group-label">{group.label}</span>
          {group.items.map(({ id, label, icon: Icon }) => (
            <button key={id} data-nav={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => onView(id)}>
              <span className="nav-icon"><Icon size={18} /></span><span className="nav-label">{label}</span>
            </button>
          ))}
        </div>
      ))}
      <div className="nav-bottom">
        <div className="runtime-card">
          <div className="runtime-card-head"><i className={runtimeTone} /><span>{runtime?.label ?? '检查中'}</span></div>
          {runtime?.detail && <small>{runtime.detail}</small>}
        </div>
        {/* 折叠开关：底部区域内、**在「设置」之上** —— 设置是列表的最后一项，
            开关属于面板控制，压在它下面会把列表尾巴截断。
            图标走 .nav-icon 槽位与其它项同列对齐，但**不挂 data-nav** ——
            它是面板控制而非视图，所以永远只有墨色线稿，不取专属色。
            ⚠️ aria-label 不能与任何导航项的可访问名重名：现有测试用
               getByRole('button', { name: '设置' }) 定位导航项。 */}
        <button
          type="button"
          className="nav-collapse-btn"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开导航栏' : '折叠导航栏'}
          title={collapsed ? '展开导航栏' : '折叠导航栏'}
        >
          <span className="nav-icon">
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </span>
          <span className="nav-label">收起侧栏</span>
        </button>
        <button data-nav="settings" className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onView('settings')}>
          <span className="nav-icon"><Settings size={18} /></span><span className="nav-label">设置</span>
        </button>
      </div>
    </aside>
  )
}

function ObjectList(props: {
  view: 'chats' | 'spaces'; agents: Agent[]; spaces: Space[]; selectedId: string;
  onSelect: (id: string) => void; onCreate: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const rows = props.view === 'chats' ? props.agents : props.spaces
  const keyword = query.trim().toLowerCase()
  const visible = keyword
    ? rows.filter((row) => `${row.name} ${'role' in row ? row.role : row.description}`.toLowerCase().includes(keyword))
    : rows
  const isChats = props.view === 'chats'
  return (
    <aside className="object-list">
      <div className="list-heading">
        <div><span className="eyebrow">{isChats ? 'CHATS' : 'SPACES'}</span><h2>{isChats ? '对话' : '协作空间'}</h2></div>
        <button className="icon-button" onClick={props.onCreate} aria-label="新建"><Plus size={18} /></button>
      </div>
      <div className="search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索"
          aria-label={isChats ? '搜索智能体' : '搜索协作空间'}
        />
        {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}
      </div>
      <div className="list-rows">
        {visible.map((row) => (
          <button key={row.id} className={props.selectedId === row.id ? 'object-row selected' : 'object-row'} onClick={() => props.onSelect(row.id)}>
            <Avatar name={row.name} /><span><strong>{row.name}</strong><small>{'role' in row ? row.role : row.description}</small></span>
          </button>
        ))}
      </div>
      {!visible.length && (
        <p className="list-empty">没有匹配「{query.trim()}」的{isChats ? '智能体' : '空间'}。<button type="button" onClick={() => setQuery('')}>清除搜索</button></p>
      )}
      <button className="list-create" onClick={props.onCreate}><Plus size={16} />{isChats ? '创建智能体' : '新建空间'}</button>
    </aside>
  )
}

function ChatPanel({ agent, models, messages, profile, busy, progress, streamingText, streamingReasoning, liveReplyIds, onSend, onStop, onDetail }: {
  agent: Agent; models: ModelOption[]; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>
  onSend: (content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>; onStop: () => Promise<boolean>; onDetail: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState(agent.model)
  const availableModels = modelsForProvider(agent.provider, model, agent.model, models)
  return (
    <div className="page chat-page">
      <header className="chat-header">
        <div className="chat-header-main">
          <Avatar name={agent.name} />
          <div><h1>{agent.name}</h1><p>{agent.role}</p></div>
        </div>
        <button className="ghost-button" onClick={onDetail}>查看详情 <ChevronRight size={15} /></button>
      </header>
      <MessageList
        messages={messages}
        profile={profile}
        emptyText="开始一段新的对话"
        progress={progress}
        streamingText={streamingText}
        streamingReasoning={streamingReasoning}
        liveReplyIds={liveReplyIds}
        starters={['介绍一下你自己', '帮我梳理一个思路', '你能做些什么？']}
        onStarter={setDraft}
      />
      <Composer busy={busy} canAttach={supportsImageInput(agent.provider, model)} placeholder={`给 ${agent.name} 发送消息…`} value={draft} onChange={setDraft} onSend={onSend} onStop={onStop} messages={messages} provider={agent.provider} model={model} models={availableModels} onModelChange={agent.provider === 'deepseek-official' ? setModel : undefined} />
    </div>
  )
}

function SpacePanel({ space, agents, models, messages, profile, busy, progress, streamingText, streamingReasoning, liveReplyIds, onSend, onStop, onEdit, onRemove, onUpdateContext, onUpdateAgent }: {
  space: Space; agents: Agent[]; models: ModelOption[]; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>
  onSend: (content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>; onStop: () => Promise<boolean>; onEdit: () => void; onRemove: (id: string) => Promise<void>; onUpdateContext: (id: string, context: string) => Promise<void>
  onUpdateAgent: (agent: Agent) => Promise<void>
}): React.JSX.Element {
  const confirm = useConfirm()
  const members = agents.filter((agent) => space.memberIds.includes(agent.id))
  const [draft, setDraft] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingContext, setEditingContext] = useState(false)
  const [contextDraft, setContextDraft] = useState(space.context)
  const [savingContext, setSavingContext] = useState(false)
  const [contextError, setContextError] = useState('')
  const [effortSavingId, setEffortSavingId] = useState<string | null>(null)
  const [effortError, setEffortError] = useState('')
  const attachmentTargets = parseMentions(draft, members)
  const routeTargets = attachmentTargets.length > 0 ? attachmentTargets : members.slice(0, 1)
  const routeAgent = routeTargets[0]
  const [model, setModel] = useState(routeAgent?.model ?? '')
  useEffect(() => { setModel(routeAgent?.model ?? '') }, [routeAgent?.id])
  const canSelectModel = routeTargets.length > 0
    && routeTargets.every((agent) => agent.provider === 'deepseek-official')
  const availableModels = modelsForProvider(routeAgent?.provider, model, routeAgent?.model, models)
  const canAttach = attachmentTargets.length > 0
    ? attachmentTargets.every((agent) => supportsImageInput(agent.provider, canSelectModel ? model : agent.model))
    : members.some((agent) => supportsImageInput(agent.provider, agent.model))
  function requestRemove(): void {
    confirm({
      title: `确定删除协作空间「${space.name}」吗？`,
      description: '空间及其聊天消息会从应用中删除，且无法恢复。',
      confirmLabel: '确定删除',
      onConfirm: () => onRemove(space.id),
    })
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
  async function changeEffort(agent: Agent, effort: string): Promise<void> {
    setEffortSavingId(agent.id)
    setEffortError('')
    try {
      await onUpdateAgent({ ...agent, reasoningEffort: effort || undefined })
    } catch {
      setEffortError(`「${agent.name}」的思考强度保存失败，请重试。`)
    } finally {
      setEffortSavingId(null)
    }
  }
  return (
    <div className="page space-page">
      <header className="chat-header"><div className="chat-header-main"><div><h1>{space.name}</h1><p>{members.length} 个智能体 · {space.description}</p></div></div><div className="space-header-actions"><button className="ghost-button drawer-toggle" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((open) => !open)}>编辑空间 <ChevronRight size={15} /></button></div></header>
      <div className="space-layout">
        <div className="space-chat"><MessageList messages={messages} profile={profile} emptyText="使用 @智能体 开始协作" progress={progress} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds} starters={['先让每位成员给出一版方案', '统一背景信息后再开始讨论']} onStarter={setDraft} /><Composer busy={busy} canAttach={canAttach} placeholder="@智能体 输入消息…" members={members} value={draft} onChange={setDraft} onSend={onSend} onStop={onStop} messages={messages} provider={routeAgent?.provider} model={model} models={availableModels} onModelChange={canSelectModel ? setModel : undefined} /></div>
        {drawerOpen && <aside className="context-drawer">
          <button className="secondary-button drawer-edit" disabled={busy} onClick={onEdit}>编辑空间信息</button>
          <div className="drawer-section context-section">
            <span className="eyebrow">背景信息</span>
            {editingContext ? <div className="context-editor"><textarea aria-label="背景信息" autoFocus value={contextDraft} onChange={(event) => setContextDraft(event.target.value)} />{contextError && <p className="form-error" role="alert">{contextError}</p>}<div><button className="secondary-button compact" disabled={savingContext} onClick={() => setEditingContext(false)}>取消</button><button className="primary-button compact" disabled={savingContext} onClick={() => void saveContext()}>保存背景</button></div></div> : <>
              <p className={space.context ? 'context-text' : 'context-text muted'}>{space.context || '暂无背景信息。'}</p>
              <button className="text-button context-edit" onClick={() => { setContextDraft(space.context); setContextError(''); setEditingContext(true) }}>编辑背景</button>
            </>}
          </div>
          <div className="drawer-section">
            <div className="member-head"><span className="eyebrow">成员 · {members.length}</span><span className="member-effort-hint">思考强度</span></div>
            {members.length === 0 && <p className="form-error">这个空间还没有成员。</p>}
            {members.map((agent) => (
              <div className="member" key={agent.id}>
                <Avatar name={agent.name} />
                <span className="member-info"><strong>{agent.name}</strong><small>{agent.role}</small></span>
                <label className="member-effort">
                  <select
                    aria-label={`${agent.name} 的思考强度`}
                    value={agent.reasoningEffort ?? ''}
                    disabled={effortSavingId === agent.id}
                    onChange={(event) => void changeEffort(agent, event.target.value)}
                  >
                    <option value="">默认</option>
                    {reasoningEffortOptions(agent.provider).map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} />
                </label>
              </div>
            ))}
            {effortError && <p className="form-error" role="alert">{effortError}</p>}
          </div>
          <div className="drawer-danger"><button className="list-create drawer-delete" disabled={busy} onClick={requestRemove}><Trash2 size={15} />删除空间</button></div>
        </aside>}
      </div>
    </div>
  )
}

function MessageList({ messages, profile, emptyText, progress, streamingText, streamingReasoning, liveReplyIds, starters = [], onStarter }: { messages: Message[]; profile: UserProfile; emptyText: string; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>; starters?: string[]; onStarter?: (starter: string) => void }): React.JSX.Element {
  const end = useRef<HTMLDivElement>(null)
  const hasScrolled = useRef(false)
  useLayoutEffect(() => {
    if (!end.current) return
    end.current.scrollIntoView({ behavior: hasScrolled.current ? 'smooth' : 'auto' })
    hasScrolled.current = true
  }, [messages, progress, streamingText, streamingReasoning])
  if (!messages.length && !progress && !streamingText && !streamingReasoning) return (
    <div className="conversation-empty">
      <span className="empty-mark"><BrandLogo size={34} /></span>
      <h3>{emptyText}</h3>
      <p>消息仅保存在这台设备上，不会自动上传。</p>
      {starters.length > 0 && <div className="suggestion-row">{starters.map((starter) => <button key={starter} className="suggestion" onClick={() => onStarter?.(starter)}>{starter}</button>)}</div>}
    </div>
  )
  return <div className="messages">
    {messages.map((message) => <article key={message.id} className={`message ${message.authorType}`}>
      <Avatar name={message.authorType === 'user' ? profile.name : message.authorName} image={message.authorType === 'user' ? profile.avatar : null} />
      <div>
        <header><strong>{message.authorType === 'user' ? profile.name : message.authorName}</strong>{message.stopped && <span className="stopped-badge">已停止 · 回复可能不完整</span>}<time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>
        {message.reasoning && <ReasoningDetails content={message.reasoning} initiallyOpen={liveReplyIds.has(message.id)} />}
        {!!message.attachments?.length && <div className="message-attachments">{message.attachments.map((attachment, index) => <img key={`${attachment.name}-${index}`} src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} />)}</div>}
        {message.content && <MessageBody content={message.content} animated={liveReplyIds.has(message.id)} />}
      </div>
    </article>)}
    {(progress || streamingText || streamingReasoning) && <article className="message agent">
      <Avatar name={progress ?? '智能体'} />
      <div>
        <header><strong>{progress ?? '智能体'}</strong></header>
        {streamingReasoning && <ReasoningDetails content={streamingReasoning} initiallyOpen />}
        {streamingText ? <MessageBody content={streamingText} /> : !streamingReasoning && <div className="chat-progress" role="status"><span className="chat-progress-dot" />思考中…</div>}
      </div>
    </article>}
    <div ref={end} />
  </div>
}

function ReasoningDetails({ content, initiallyOpen = false, animated = false }: { content: string; initiallyOpen?: boolean; animated?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return <details className="reasoning-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>思考过程</summary><MessageBody content={content} animated={animated} /></details>
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

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const PERMISSION_LABELS: Record<ChatPermission, string> = {
  chat: '仅对话',
  workspace: '允许工作区访问',
  full: '允许完全访问',
}

function Composer({ busy, canAttach, placeholder, members = [], value, onChange, onSend, onStop, messages, provider, model, models = [], onModelChange }: {
  busy: boolean; canAttach: boolean; placeholder: string; members?: Agent[]; value: string
  onChange: React.Dispatch<React.SetStateAction<string>>
  onSend: (value: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>
  onStop: () => Promise<boolean>
  messages: Message[]; provider?: string; model?: string; models?: ModelOption[]; onModelChange?: (model: string) => void
}): React.JSX.Element {
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [stopError, setStopError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [stopAccepted, setStopAccepted] = useState(false)
  const stopCycle = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [permission, setPermission] = useState<ChatPermission>('chat')
  const [sendError, setSendError] = useState('')
  const [openMenu, setOpenMenu] = useState<'permission' | 'model' | 'context' | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectedModel = models.find((item) => item.id === model)
    ?? models.find((item) => item.name === displayModelName(model ?? ''))
  const contextWindow = selectedModel?.contextWindow ?? getModelContextWindow(provider ?? '', model ?? '')
  const estimatedTokens = estimateContextTokens(messages, value)
  const contextPercent = contextWindow ? Math.min(100, estimatedTokens / contextWindow * 100) : 0
  const mention = /@([\p{L}\p{N}_-]*)$/u.exec(value)
  const matchingMembers = mention ? members.filter((agent) => agent.name.toLowerCase().startsWith(mention[1].toLowerCase())) : []
  const addFiles = useCallback(async (files: FileList | File[]): Promise<void> => {
    if (!canAttach) { setAttachmentError('目前仅 DeepSeek Flash 支持图片输入'); return }
    setAttachmentError('')
    const next: ChatImageAttachment[] = []
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0)
    for (const file of Array.from(files)) {
      const mediaType = await detectImageMediaType(file)
      if (!mediaType) {
        setAttachmentError('仅支持 PNG、JPEG、WebP 或 GIF 图片')
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) { setAttachmentError('单张图片不能超过 32 MiB'); continue }
      totalBytes += file.size
      if (totalBytes > MAX_IMAGE_BYTES) { setAttachmentError('图片总大小不能超过 32 MiB'); break }
      try {
        const dataUrl = await readFileAsDataUrl(file)
        next.push({ type: 'image', name: file.name, mediaType, data: dataUrl.split(',')[1] ?? '', bytes: file.size })
      } catch {
        setAttachmentError(`无法读取 ${file.name}`)
      }
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next])
  }, [attachments, canAttach])
  useEffect(() => {
    let dragDepth = 0
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (!canAttach) return
      dragDepth += 1
      setDragging(true)
    }
    const over = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setDragging(false)
    }
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth = 0
      setDragging(false)
      if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [addFiles])
  useEffect(() => {
    if (!canAttach && attachments.length > 0) setAttachmentError('当前选择的智能体不支持图片输入')
  }, [attachments.length, canAttach])
  useEffect(() => {
    stopCycle.current += 1
    setStopAccepted(false)
    setStopping(false)
    setStopError('')
  }, [busy])
  async function submit(): Promise<void> {
    const current = value
    const currentAttachments = attachments
    if (busy || (!current.trim() && currentAttachments.length === 0) || (currentAttachments.length > 0 && !canAttach)) return
    const validationError = getChatContentError(current)
    if (validationError) { setSendError(validationError); return }
    setSendError('')
    setStopError('')
    onChange('')
    setAttachments([])
    if (!await onSend(current, currentAttachments, onModelChange && model ? { model, permission } : { permission })) {
      onChange((draft) => draft || current)
      setAttachments((draft) => draft.length > 0 ? draft : currentAttachments)
    }
  }
  async function stopGeneration(): Promise<void> {
    if (stopping || stopAccepted) return
    const cycle = stopCycle.current
    setStopping(true)
    setStopError('')
    try {
      const stopped = await onStop()
      if (stopCycle.current !== cycle) return
      if (stopped) setStopAccepted(true)
      else setStopError('未能停止生成，请重试。')
    } catch {
      if (stopCycle.current === cycle) setStopError('未能停止生成，请重试。')
    } finally {
      if (stopCycle.current === cycle) setStopping(false)
    }
  }
  return (
    <div className="composer-wrap">
      {dragging && <div className="drop-overlay" role="status">松开即可添加图片</div>}
      {matchingMembers.length > 0 && <div className="mention-menu"><span className="eyebrow">选择智能体</span>{matchingMembers.map((agent) => <button key={agent.id} onClick={() => onChange((draft) => draft.replace(/@[\p{L}\p{N}_-]*$/u, `@${agent.name} `))}><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></button>)}</div>}
      <div className="composer">
        {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment, index) => <figure key={`${attachment.name}-${index}`}><img src={`data:${attachment.mediaType};base64,${attachment.data}`} alt={attachment.name} /><figcaption>{attachment.name}</figcaption><button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></figure>)}</div>}
      <textarea value={value} onChange={(event) => { setSendError(''); onChange(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={placeholder} />
      {attachmentError && <p className="composer-error" role="alert">{attachmentError}</p>}
      {sendError && <p className="composer-error" role="alert">{sendError}</p>}
        {stopError && <p className="composer-error" role="alert">{stopError}</p>}
        <div className="composer-actions">
          <div className="composer-tools">
            <input ref={input} className="visually-hidden" aria-label="选择图片" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
            <button type="button" className="composer-add" aria-label="添加图片" title={canAttach ? '添加图片' : '目前仅 DeepSeek Flash 支持图片输入'} disabled={busy || !canAttach} onClick={() => input.current?.click()}><Plus size={19} /></button>
            <div className="composer-control-wrap">
              <button type="button" className={`composer-control permission ${permission !== 'full' ? 'limited' : ''}`} aria-label={`权限：${PERMISSION_LABELS[permission]}`} aria-expanded={openMenu === 'permission'} onClick={() => setOpenMenu((current) => current === 'permission' ? null : 'permission')}><ShieldCheck size={15} />{PERMISSION_LABELS[permission]}<ChevronRight size={13} /></button>
              {openMenu === 'permission' && <div className="composer-menu permission-menu">{(Object.keys(PERMISSION_LABELS) as ChatPermission[]).map((item) => <button type="button" key={item} aria-label={PERMISSION_LABELS[item]} className={item === permission ? 'selected' : ''} onClick={() => { setPermission(item); setOpenMenu(null) }}><strong>{PERMISSION_LABELS[item]}</strong><small>{item === 'chat' ? '不使用本地工具' : item === 'workspace' ? '允许文件和网页，不运行 Shell' : '使用智能体已配置的全部工具'}</small></button>)}</div>}
            </div>
          </div>
          <div className="composer-route-controls">
            <div className="composer-control-wrap">
              <button type="button" className="context-meter" aria-label={`上下文窗口：约 ${formatTokenCount(estimatedTokens)} / ${contextWindow ? formatTokenCount(contextWindow) : '未知'}`} aria-expanded={openMenu === 'context'} onClick={() => setOpenMenu((current) => current === 'context' ? null : 'context')}><span style={{ '--context-progress': `${contextWindow ? Math.max(2, contextPercent) : 2}%` } as React.CSSProperties} /></button>
              {openMenu === 'context' && <div className="composer-menu context-menu"><strong>上下文窗口</strong><span>约 {formatTokenCount(estimatedTokens)} / {contextWindow ? formatTokenCount(contextWindow) : '未知'}</span><small>{contextWindow ? '根据当前会话文本估算，实际用量以 API 计费为准。' : '该模型未公布上下文上限；当前用量按会话文本估算。'}</small></div>}
            </div>
            <div className="composer-control-wrap">
              <button type="button" className="composer-control model" aria-label={`选择模型，当前 ${selectedModel?.name ?? '成员模型'}`} aria-expanded={openMenu === 'model'} disabled={!onModelChange} onClick={() => setOpenMenu((current) => current === 'model' ? null : 'model')}>{provider && getProviderLogo(provider) && <img src={getProviderLogo(provider)} alt="" />}{selectedModel?.name ?? '成员模型'}<ChevronRight size={13} /></button>
              {openMenu === 'model' && <div className="composer-menu model-menu">{models.map((item) => <button type="button" key={item.id} className={item.id === model ? 'selected' : ''} onClick={() => { onModelChange?.(item.id); setOpenMenu(null) }}>{item.name}</button>)}</div>}
            </div>
            <button type="button" className="send-button" aria-label={busy ? stopAccepted ? '已停止' : stopping ? '正在停止' : '停止生成' : '发送'} disabled={busy ? stopping || stopAccepted : ((!value.trim() && attachments.length === 0) || (attachments.length > 0 && !canAttach))} onClick={() => busy ? void stopGeneration() : void submit()}>{busy ? <Square size={13} fill="currentColor" /> : <Send size={17} />}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function detectImageMediaType(file: File): Promise<ChatImageMediaType | null> {
  const signature = await readFileAsArrayBuffer(file.slice(0, 12)).catch(() => null)
  if (!signature) return null
  const bytes = new Uint8Array(signature)
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const ascii = String.fromCharCode(...bytes)
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function readFileAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function displayModelName(model: string): string {
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-flash-vision-exp') return 'DeepSeek V4.1 Flash'
  return model.split(/[-_]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ')
}

function modelsForProvider(provider: string | undefined, selectedModel: string, configuredModel: string | undefined, models: ModelOption[]): ModelOption[] {
  if (!provider) return []
  const available = models.filter((item) => item.provider === provider)
  for (const id of [configuredModel, selectedModel]) {
    if (id && !available.some((item) => item.id === id)) {
      available.push({ provider, id, name: displayModelName(id), contextWindow: getModelContextWindow(provider, id) })
    }
  }
  return available.filter((item, index) => available.findIndex((candidate) => candidate.name === item.name) === index)
}

function estimateContextTokens(messages: Message[], draft: string): number {
  const characters = [...messages.map((message) => `${message.content}\n${message.reasoning ?? ''}`).join('\n'), ...draft].length
  return Math.ceil(characters / 2)
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(value)
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return <div className="empty-state"><BrandLogo size={76} /><h1>还没有智能体</h1><p>创建第一个智能体，开始你的 Multi-Agent 工作空间。</p><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></div>
}

function AgentsPage({ agents, onCreate, onDetail }: { agents: Agent[]; onCreate: () => void; onDetail: (id: string) => void }): React.JSX.Element {
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">AGENTS</span><h1>智能体</h1><p>管理身份、模型、技能和工具。</p></div><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></header><div className="table-card"><div className="table-head"><span>智能体</span><span>模型</span><span>能力</span><span>状态</span><span /></div>{agents.map((agent) => <button className="agent-table-row" key={agent.id} onClick={() => onDetail(agent.id)}><span className="agent-cell"><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></span><span><em>{agent.model}</em></span><span className="tags">{agent.skills.slice(0, 2).map((skill) => <i key={skill}>{skillDisplayName(skill)}</i>)}</span><span className="online"><i className="dot" /> 可用</span><MoreHorizontal size={18} /></button>)}</div></div>
}

function CatalogPage({ kind }: { kind: 'skills' | 'tools' }): React.JSX.Element {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState<'local' | 'github' | null>(null)
  const [progress, setProgress] = useState<SkillInstallProgress | null>(null)
  const [notice, setNotice] = useState('')
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false)
  const [githubUrl, setGitHubUrl] = useState('')
  useEffect(() => { void window.mindmesh.catalog[kind]().then(setItems) }, [kind])
  useEffect(() => {
    if (kind !== 'skills') return undefined
    return window.mindmesh.catalog.onInstallProgress(setProgress)
  }, [kind])
  async function installSkill(): Promise<void> {
    if (installing) return
    setError('')
    setNotice('')
    setInstalling('local')
    try {
      const installedItems = await window.mindmesh.catalog.installSkill()
      if (!installedItems) return
      setItems(installedItems)
      setNotice('本地技能导入完成，技能库已刷新。')
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : '技能安装失败') }
    finally { setInstalling(null); setProgress(null) }
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
      setNotice('GitHub 技能安装完成，技能库已刷新。')
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'GitHub 技能安装失败') }
    finally { setInstalling(null); setProgress(null) }
  }
  const progressLabel = installing === 'local'
    ? '正在选择并导入本地技能…'
    : progress ? formatSkillInstallProgress(progress) : installing === 'github' ? '正在准备 GitHub 技能安装…' : ''
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">{kind.toUpperCase()}</span><h1>{kind === 'skills' ? '技能库' : '工具'}</h1><p>{kind === 'skills' ? '为智能体添加可复用的工作方法。' : '连接智能体可以使用的实际能力。'}</p></div>{kind === 'skills' && <div className="space-header-actions"><button className="secondary-button compact" disabled={installing !== null} onClick={() => void installSkill()}><Plus size={17} />{installing === 'local' ? '导入中…' : '本地导入'}</button><button className="primary-button compact" disabled={installing !== null} onClick={() => setGitHubDialogOpen(true)}>{installing === 'github' ? '导入中…' : 'GitHub 导入'}</button></div>}</header>{error && <p className="form-error" role="alert">{error}</p>}{progressLabel && <div className="skill-install-progress" role="status"><span>{progressLabel}</span>{progress?.phase === 'downloading' && progress.totalBytes !== undefined && <progress aria-label="GitHub 技能下载进度" value={progress.receivedBytes ?? 0} max={progress.totalBytes} />}</div>}{notice && <p className="form-success" role="status">{notice}</p>}{items.length === 0 ? <div className="empty-state"><span className="empty-mark">{kind === 'skills' ? <Sparkles size={19} /> : <Wrench size={19} />}</span><h1>{kind === 'skills' ? '还没有可用技能' : '还没有可用工具'}</h1><p>安装后会自动出现在这里，并可绑定到智能体。</p></div> : <div className="catalog-grid">{items.map((item) => <article key={item.id}><div className="catalog-icon">{kind === 'skills' ? <Sparkles size={20} /> : <Wrench size={20} />}</div><h3>{item.name}</h3><p>{item.description}</p>{item.diagnostic && <small>{item.diagnostic}</small>}{kind === 'skills' && item.source && <small>{item.integrity === 'untracked' ? '未托管来源' : '可信来源'}：{item.source}{item.license ? ` · ${item.license}${item.licenseSpdx === false ? '（非 SPDX）' : ''}` : ''}{item.integrity === 'modified' ? ' · 内容已变更' : ''}</small>}{item.limitations?.map((limitation) => <small key={limitation}>{limitation}</small>)}<span className="status-tag">{item.status}</span></article>)}</div>}{githubDialogOpen && <div className="modal-backdrop confirm-backdrop"><form className="confirm-dialog github-import-dialog" role="dialog" aria-modal="true" aria-labelledby="github-import-title" onSubmit={(event) => { event.preventDefault(); void installGitHubSkill(githubUrl) }}><header><div><h2 id="github-import-title">从 GitHub 导入技能</h2><p>粘贴公开 GitHub 仓库或其中的 skill 目录地址。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setGitHubDialogOpen(false)}><X size={18} /></button></header><Field label="GitHub 地址"><input autoFocus value={githubUrl} onChange={(event) => setGitHubUrl(event.target.value)} placeholder="https://github.com/owner/repo/tree/main/path/to/skill" /></Field><footer><button type="button" className="secondary-button" onClick={() => setGitHubDialogOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={!githubUrl.trim()}>导入</button></footer></form></div>}</div>
}

function formatSkillInstallProgress(progress: SkillInstallProgress): string {
  if (progress.phase === 'resolving') return '正在解析 GitHub 地址…'
  if (progress.phase === 'extracting') return '正在解压归档…'
  if (progress.phase === 'installing') return '正在安装技能…'
  if (progress.phase === 'done') return '安装完成'
  if (progress.receivedBytes === undefined) return '下载仓库归档…'
  const receivedKiB = Math.ceil(progress.receivedBytes / 1024)
  const size = progress.totalBytes === undefined
    ? `${receivedKiB} KiB`
    : `${receivedKiB} / ${Math.ceil(progress.totalBytes / 1024)} KiB`
  return `下载仓库归档… ${size}`
}

function AgentDrawer({ agent, onClose, onChat, onEdit, onRemove }: {
  agent?: Agent; onClose: () => void; onChat: (id: string) => void; onEdit: (id: string) => void; onRemove: (id: string) => Promise<void>
}): React.JSX.Element | null {
  const confirm = useConfirm()
  if (!agent) return null
  const target = agent
  function requestRemove(): void {
    confirm({
      title: `确定删除智能体「${target.name}」吗？`,
      description: '该操作会将其从协作空间移除。',
      confirmLabel: '确定删除',
      onConfirm: () => onRemove(target.id),
    })
  }
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="agent-drawer" onMouseDown={(event) => event.stopPropagation()}><header><Avatar name={agent.name} large /><div><h2>{agent.name}</h2><p>{agent.role}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><section><span className="eyebrow">身份设定</span><p>{agent.persona}</p></section><section><span className="eyebrow">模型</span><p><em>{agent.model}</em></p></section><section><span className="eyebrow">技能</span><div className="tags">{agent.skills.map((item) => <i key={item}>{skillDisplayName(item)}</i>)}</div></section><section><span className="eyebrow">工具</span><div className="tags">{agent.tools.map((item) => <i key={item}>{item}</i>)}</div></section><footer><button className="primary-button" onClick={() => onChat(agent.id)}>开始对话</button><button className="secondary-button" onClick={() => onEdit(agent.id)}>编辑智能体</button><button className="danger-button" onClick={requestRemove}><Trash2 size={15} />删除智能体</button></footer></aside></div>
}
