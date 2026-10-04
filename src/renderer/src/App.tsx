import { modelsForProvider } from './model-options'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { CatalogPage } from './CatalogPage'
import { AgentDrawer } from './AgentDrawer'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot, Boxes, ChevronDown, ChevronRight, Command, Library, MessageCircle, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Search, Settings, Trash2, Wrench, X,
} from 'lucide-react'
import type {
  Agent, CatalogItem, ChatImageAttachment, ChatRunOptions, Message, ModelOption, RuntimeStatus,
  Space, UserProfile,
} from '../../shared/contracts'
import {
  reasoningEffortOptions, supportsImageInput,
} from '../../shared/model-providers'
import { parseMentions } from '../../shared/domain'
import { parseSkillReference, skillDisplayName } from '../../shared/skill-reference'
import { BrandLogo } from './BrandLogo'
import { PaneResizer, usePaneShares } from './PaneLayout'
import { Avatar } from './Ui'
import { AgentWizard, SpaceWizard } from './Wizards'
import { ConfirmContext, ConfirmDialog, useConfirm, type ConfirmRequest } from './ConfirmDialog'
import { SettingsPage } from './SettingsPage'
import { useChatController } from './useChatController'
import { MarketplacePage } from './MarketplacePage'

type View = 'chats' | 'spaces' | 'agents' | 'skills' | 'tools' | 'marketplace' | 'settings'
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
  const [invocableSkills, setInvocableSkills] = useState<CatalogItem[]>([])
  const [agentWizard, setAgentWizard] = useState(false)
  const [spaceWizard, setSpaceWizard] = useState(false)
  const [editingSpaceId, setEditingSpaceId] = useState('')
  const [detailAgentId, setDetailAgentId] = useState<string>('')
  const [editingAgentId, setEditingAgentId] = useState<string>('')
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [loadError, setLoadError] = useState('')
  const [modelLoadError, setModelLoadError] = useState('')
  const [skillLoadError, setSkillLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
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
    setRefreshing(true)
    setLoadError('')
    try {
      const [nextAgents, nextSpaces, status, nextProfile] = await Promise.all([
        window.mindmesh.agents.list(), window.mindmesh.spaces.list(), window.mindmesh.runtime.status(), window.mindmesh.settings.profile(),
      ])
      setAgents(nextAgents)
      setSpaces(nextSpaces)
      setRuntime(status)
      setProfile(nextProfile)
      setSelectedAgentId((current) => nextAgents.some((agent) => agent.id === current) ? current : nextAgents[0]?.id || '')
      setSelectedSpaceId((current) => nextSpaces.some((space) => space.id === current) ? current : nextSpaces[0]?.id || '')
      void refreshSkills()
    } catch (cause) {
      setLoadError(cause instanceof Error && cause.message ? cause.message : '应用数据加载失败，请重试。')
    } finally { setRefreshing(false) }
  }

  async function refreshSkills(): Promise<void> {
    setSkillLoadError('')
    try { setInvocableSkills((await window.mindmesh.catalog.skills()).filter((item) => item.status === '仅手动调用')) }
    catch (cause) { setSkillLoadError(cause instanceof Error && cause.message ? cause.message : '技能目录加载失败，请重试。') }
  }

  async function refreshModels(): Promise<void> {
    setModelLoadError('')
    try { setModels(await window.mindmesh.catalog.models()) }
    catch (cause) { setModelLoadError(cause instanceof Error && cause.message ? cause.message : '模型目录加载失败，请重试。') }
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
        {[
          { id: 'data', error: loadError, retry: refresh, label: '重新加载' },
          { id: 'models', error: modelLoadError, retry: refreshModels, label: '重试模型目录' },
          { id: 'skills', error: skillLoadError, retry: refreshSkills, label: '重试技能目录' },
        ].map((item) => item.error && <div key={item.id} className="form-error" role="alert">{item.error}<button className="secondary-button compact" disabled={item.id === 'data' && refreshing} onClick={() => void item.retry()}>{item.label}</button></div>)}
        {view === 'chats' && (
          selectedAgent
            ? <ChatPanel key={selectedAgent.id} agent={selectedAgent} models={models} messages={messages} profile={profile} busy={busy} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds} invocableSkills={invocableSkills} progress={progress?.scope === 'private' && progress.scopeId === selectedAgent.id ? progress.agentName : undefined} onSend={send} onStop={stop} onDetail={() => setDetailAgentId(selectedAgent.id)} />
            : loadError ? null : <EmptyState onCreate={() => setAgentWizard(true)} />
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
        {view === 'marketplace' && <MarketplacePage onOpenAgent={async (id) => {
          await refresh()
          setSelectedAgentId(id)
          setView('chats')
        }} />}
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
      { id: 'marketplace', label: '市场', icon: Boxes },
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

function ChatPanel({ agent, models, messages, profile, busy, progress, streamingText, streamingReasoning, liveReplyIds, invocableSkills, onSend, onStop, onDetail }: {
  agent: Agent; models: ModelOption[]; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>
  invocableSkills: CatalogItem[]
  onSend: (content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>; onStop: () => Promise<boolean>; onDetail: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [model, setModel] = useState(agent.model)
  const availableModels = modelsForProvider(agent.provider, model, agent.model, models)
  const selectedSkillIds = new Set(agent.skills.map((ref) => parseSkillReference(ref)?.id).filter((id): id is string => Boolean(id)))
  const invocableForAgent = invocableSkills.filter((skill) => selectedSkillIds.has(skill.id))
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
      <Composer busy={busy} canAttach={supportsImageInput(agent.provider, model)} placeholder={`给 ${agent.name} 发送消息…`} value={draft} onChange={setDraft} onSend={onSend} onStop={onStop} messages={messages} provider={agent.provider} model={model} models={availableModels} onModelChange={agent.provider === 'deepseek-official' ? setModel : undefined} invocableSkills={invocableForAgent} />
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
          <div className="drawer-actions"><button className="secondary-button drawer-edit" onClick={onEdit}>编辑空间信息</button><button className="danger-button drawer-delete" disabled={busy} onClick={requestRemove}><Trash2 size={15} />删除空间</button></div>
        </aside>}
      </div>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return <div className="empty-state"><BrandLogo size={76} /><h1>还没有智能体</h1><p>创建第一个智能体，开始你的 Multi-Agent 工作空间。</p><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></div>
}

function AgentsPage({ agents, onCreate, onDetail }: { agents: Agent[]; onCreate: () => void; onDetail: (id: string) => void }): React.JSX.Element {
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">AGENTS</span><h1>智能体</h1><p>管理身份、模型、技能和工具。</p></div><button className="primary-button" onClick={onCreate}><Plus size={17} />创建智能体</button></header><div className="table-card"><div className="table-head"><span>智能体</span><span>模型</span><span>能力</span><span>状态</span><span /></div>{agents.map((agent) => <button className="agent-table-row" key={agent.id} onClick={() => onDetail(agent.id)}><span className="agent-cell"><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></span><span><em>{agent.model}</em></span><span className="tags">{agent.skills.slice(0, 2).map((skill) => <i key={skill}>{skillDisplayName(skill)}</i>)}</span><span className="online"><i className="dot" /> 可用</span><MoreHorizontal size={18} /></button>)}</div></div>
}
