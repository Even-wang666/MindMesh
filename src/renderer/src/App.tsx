import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity, AlertTriangle, Bot, Boxes, Check, ChevronRight, CircleHelp, Command, Eye, EyeOff, HardDrive,
  KeyRound, Library, MessageCircle, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Search, Send, Settings, ShieldCheck, Sparkles, Square, Trash2, Wrench, X,
} from 'lucide-react'
import type {
  Agent, ChatImageAttachment, ChatImageMediaType, ChatPermission, ChatProgress, ChatRunOptions, CreateAgentInput, Message, ModelOption, ModelProviderId, ModelProviderStatus, RuntimeStatus,
  SaveModelProviderInput, Space, UserProfile,
} from '../../shared/contracts'
import {
  getModelContextWindow, getModelProviderApiKeyError, getModelProviderDefinition, MODEL_PROVIDER_DEFINITIONS, supportsImageInput,
} from '../../shared/model-providers'
import { parseMentions } from '../../shared/domain'
import { createSkillReference, skillDisplayName } from '../../shared/skill-reference'
import { BrandLogo } from './BrandLogo'
import anthropicLogo from './assets/providers/anthropic.svg'
import deepseekLogo from './assets/providers/deepseek.svg'
import kimiLogo from './assets/providers/kimi.png'
import minimaxLogo from './assets/providers/minimax.svg'
import openaiLogo from './assets/providers/openai.svg'
import qwenLogo from './assets/providers/qwen.svg'
import stepfunLogo from './assets/providers/stepfun.svg'
import zhipuLogo from './assets/providers/zhipu.svg'

type View = 'chats' | 'spaces' | 'agents' | 'skills' | 'tools' | 'settings'
const providerLogos: Partial<Record<ModelProviderId, string>> = {
  'deepseek-official': deepseekLogo,
  'moonshotai-cn': kimiLogo,
  openai: openaiLogo,
  anthropic: anthropicLogo,
  minimax: minimaxLogo,
  zhipu: zhipuLogo,
  qwen: qwenLogo,
  stepfun: stepfunLogo,
}

const defaultAgent: CreateAgentInput = {
  name: '', role: '', persona: '', provider: 'deepseek-official', model: 'deepseek-flash', skills: [], tools: [],
}
const defaultProfile: UserProfile = { name: '你', avatar: null }

type ConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void | Promise<void>
}

const ConfirmContext = createContext<((request: ConfirmRequest) => void) | null>(null)

function useConfirm(): (request: ConfirmRequest) => void {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmContext.Provider')
  return confirm
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function approve(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await request.onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请重试。')
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <header>
          <span className="confirm-mark" aria-hidden="true"><AlertTriangle size={19} /></span>
          <div><h2 id="confirm-title">{request.title}</h2><p id="confirm-description">{request.description}</p></div>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer>
          <button className="secondary-button" autoFocus disabled={busy} onClick={onClose}>取消</button>
          <button className="danger-button solid" disabled={busy} onClick={() => void approve()}>{busy && <span className="spinner" />}{request.confirmLabel}</button>
        </footer>
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('chats')
  const [agents, setAgents] = useState<Agent[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [profile, setProfile] = useState<UserProfile>(defaultProfile)
  const [models, setModels] = useState<ModelOption[]>([])
  const [agentWizard, setAgentWizard] = useState(false)
  const [spaceWizard, setSpaceWizard] = useState(false)
  const [editingSpaceId, setEditingSpaceId] = useState('')
  const [detailAgentId, setDetailAgentId] = useState<string>('')
  const [editingAgentId, setEditingAgentId] = useState<string>('')
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ChatProgress | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const liveReplyIds = useRef(new Set<string>())
  const activeRun = useRef<{ scope: Message['scope']; id: string; stopRequested: boolean } | null>(null)
  const appRef = useRef<HTMLElement | null>(null)
  const [shares, setShares] = usePaneShares(appRef)

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

  async function refreshModels(): Promise<void> {
    try { setModels(await window.mindmesh.catalog.models()) }
    catch { setModels([]) }
  }

  useEffect(() => {
    void refresh()
    void refreshModels()
  }, [])
  function showLiveMessages(next: Message[], animated = true): void {
    setMessages((current) => {
      const known = new Set(current.map((message) => message.id))
      for (const message of next) {
        if (animated && message.authorType === 'agent' && !known.has(message.id)) liveReplyIds.current.add(message.id)
      }
      return next
    })
  }
  useEffect(() => {
    const offProgress = window.mindmesh.chat.onProgress((event) => {
      setProgress(event)
      setStreamingText('')
      setStreamingReasoning('')
      if (event.scope === 'space') {
        void window.mindmesh.chat.messages(event.scope, event.scopeId).then((next) => {
          if (conversationRef.current === `${event.scope}:${event.scopeId}`) showLiveMessages(next)
        })
      }
    })
    const offDelta = window.mindmesh.chat.onDelta((event) => {
      if (conversationRef.current === `${event.scope}:${event.scopeId}`) {
        const request = activeRun.current
        if (request?.stopRequested && request.scope === event.scope && request.id === event.scopeId) return
        if (event.kind === 'reasoning') setStreamingReasoning((current) => current + event.text)
        else setStreamingText((current) => current + event.text)
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
    setStreamingReasoning('')
    liveReplyIds.current.clear()
    void window.mindmesh.chat.messages(scope, id).then((next) => { if (active) setMessages(next) })
    return () => { active = false }
  }, [view, selectedAgentId, selectedSpaceId])

  async function send(content: string, attachments: ChatImageAttachment[] = [], options: ChatRunOptions = {}): Promise<boolean> {
    if ((!content.trim() && attachments.length === 0) || busy) return true
    const scope: Message['scope'] = view === 'chats' ? 'private' : 'space'
    const id = view === 'chats' ? selectedAgentId : selectedSpaceId
    if (!id || (view !== 'chats' && view !== 'spaces')) return false
    const requestConversation = `${scope}:${id}`
    const requestRun = { scope, id, stopRequested: false }
    const knownIds = new Set(messages.map((message) => message.id))
    activeRun.current = requestRun
    setBusy(true)
    setStreamingText('')
    setStreamingReasoning('')
    setMessages((current) => [...current, {
      id: crypto.randomUUID(), scope, scopeId: id, authorType: 'user', authorName: profile.name,
      content: content.trim(), attachments, sequence: 0, createdAt: new Date().toISOString(),
    }])
    if (scope === 'private' && selectedAgent) {
      setProgress({ scope, scopeId: id, agentName: selectedAgent.name })
    }
    try {
      const runOptions = Object.keys(options).length > 0 ? options : undefined
      const result = scope === 'private'
        ? runOptions
          ? await window.mindmesh.chat.sendPrivate(id, content.trim(), attachments, runOptions)
          : attachments.length > 0
            ? await window.mindmesh.chat.sendPrivate(id, content.trim(), attachments)
            : await window.mindmesh.chat.sendPrivate(id, content.trim())
        : runOptions
          ? await window.mindmesh.chat.sendSpace(id, content.trim(), attachments, runOptions)
          : attachments.length > 0
            ? await window.mindmesh.chat.sendSpace(id, content.trim(), attachments)
            : await window.mindmesh.chat.sendSpace(id, content.trim())
      if (conversationRef.current === requestConversation) {
        showLiveMessages(result, !requestRun.stopRequested)
        setStreamingText('')
        setStreamingReasoning('')
      }
      try { setRuntime(await window.mindmesh.runtime.status()) }
      catch { /* A status refresh must not turn a completed send into a failure. */ }
      return true
    } catch {
      let saved = true
      let next: Message[] | null = null
      try {
        next = await window.mindmesh.chat.messages(scope, id)
        saved = next.some((message) => message.authorType === 'user' && !knownIds.has(message.id))
      } catch { /* Keep the pending message when persistence cannot be checked. */ }
      if (conversationRef.current === requestConversation) {
        const error = next
          ? saved ? '发送未完成，请检查会话后再重试。' : '发送失败，消息未保存。请重试。'
          : '发送状态未确认，请检查会话后再重试。'
        const notice: Message = { id: crypto.randomUUID(), scope, scopeId: id, authorType: 'system',
          authorName: 'MindMesh', content: error, sequence: 0, createdAt: new Date().toISOString() }
        setMessages((current) => [...(next ?? current), notice])
        setStreamingText('')
        setStreamingReasoning('')
      }
      return saved || conversationRef.current !== requestConversation
    } finally {
      if (activeRun.current === requestRun) activeRun.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  async function stop(): Promise<boolean> {
    const request = activeRun.current
    if (!request) return false
    request.stopRequested = true
    try {
      const stopped = await window.mindmesh.chat.stop(request.scope, request.id)
      if (!stopped) request.stopRequested = false
      return stopped
    } catch (error) {
      request.stopRequested = false
      throw error
    }
  }

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
            ? <ChatPanel key={selectedAgent.id} agent={selectedAgent} models={models} messages={messages} profile={profile} busy={busy} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds.current} progress={progress?.scope === 'private' && progress.scopeId === selectedAgent.id ? progress.agentName : undefined} onSend={send} onStop={stop} onDetail={() => setDetailAgentId(selectedAgent.id)} />
            : <EmptyState onCreate={() => setAgentWizard(true)} />
        )}
        {view === 'spaces' && (selectedSpace ? (
          <SpacePanel key={selectedSpace.id} space={selectedSpace} agents={agents} models={models} messages={messages} profile={profile} busy={busy} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds.current} progress={progress?.scope === 'space' && progress.scopeId === selectedSpace.id ? progress.agentName : undefined} onSend={send} onStop={stop} onEdit={() => setEditingSpaceId(selectedSpace.id)} onRemove={async (id) => { await window.mindmesh.spaces.remove(id); await refresh() }} onUpdateContext={async (id, context) => {
            const updated = await window.mindmesh.spaces.updateContext(id, context)
            setSpaces((current) => current.map((space) => space.id === id ? updated : space))
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

/* ── 分区拖拽 ────────────────────────────────────────────────────────────── */

/** 分区份额，单位是「占窗口宽的百分比」。null = 用样式表里的默认比例。 */
export type PaneShares = { nav: number; list: number }

/**
 * 三栏各自的可用下限（px）。低于这个宽度，最长的内容就开始贴边：
 *   导航 200 —— 「MindMesh」字标那一行（36px 标志 + 字标 + 两侧内距）；
 *              与 styles.css 里 .primary-nav 的 min-width 保持同值
 *   列表 220 —— 40px 头像 + 两行标题
 *   内容 380 —— 一条消息气泡仍然读得舒服的宽度
 * ⚠️ 下限是 px，而份额是百分比，所以要按**当前窗宽**换算 —— 这意味着同一个
 *    百分比在大窗口合法、到小窗口可能就不合法了。resize 时必须在再夹一次
 *    （见 usePaneShares 里的 resize 监听），否则在大窗口拖出的窄栏，
 *    到最小窗口会挤成一条。
 */
const PANE_LIMITS = { nav: 200, list: 220, content: 380 }
const PANE_STORE_KEY = 'mindmesh.pane-shares'

/** 把份额夹进「三栏都还能用」的区间。先夹导航，再让列表在剩下的空间里夹。 */
export function clampShares(shares: PaneShares, width: number): PaneShares {
  if (!(width > 0)) return shares
  const asPct = (px: number): number => (px / width) * 100
  const minNav = asPct(PANE_LIMITS.nav)
  const minList = asPct(PANE_LIMITS.list)
  const minContent = asPct(PANE_LIMITS.content)
  const nav = Math.min(Math.max(shares.nav, minNav), 100 - minList - minContent)
  const list = Math.min(Math.max(shares.list, minList), 100 - nav - minContent)
  return { nav, list }
}

/**
 * 拖动一条分隔条之后的原始份额（尚未做下限夹取）。
 *
 * 「拖动只影响相邻两栏」这条约定就落在这里：index=0 是导航与列表此消彼长，
 * 两者之和不变 —— 所以**内容栏纹丝不动**；index=1 只动列表，导航不动。
 * 抽成纯函数是为了能被单元测试直接覆盖：这条语义里有「什么都没发生」的断言
 * （内容栏不该动 / 导航不该动），光靠手动拖是验不出来的。
 */
export function resizeShares(index: number, start: PaneShares, deltaPct: number): PaneShares {
  return index === 0
    ? { nav: start.nav + deltaPct, list: start.list - deltaPct }
    : { nav: start.nav, list: start.list + deltaPct }
}

/** 从 DOM 实测三栏宽度，换算成份额 —— 拖拽起点优先信布局，不在 JS 里另存一份。 */
function measureShares(shell: HTMLElement): PaneShares & { width: number } {
  const width = shell.getBoundingClientRect().width
  const shareOf = (selector: string): number => {
    const el = shell.querySelector(selector)
    return width > 0 && el ? (el.getBoundingClientRect().width / width) * 100 : 0
  }
  const nav = shell.querySelector('.primary-nav')
  const measuredNav = shareOf('.primary-nav')
  /* 折叠态的导航是固定图标条，但存储模型仍使用展开态的逻辑份额。
     拖右侧分隔条时保留这个逻辑值，重新展开后导航不会突然缩成图标条宽度。 */
  const logicalNav = nav?.classList.contains('is-collapsed')
    ? Number.parseFloat(getComputedStyle(shell).getPropertyValue('--nav-share'))
    : measuredNav
  return {
    width,
    nav: Number.isFinite(logicalNav) ? logicalNav : measuredNav,
    list: shareOf('.object-list'),
  }
}

/**
 * 分区份额状态。
 *
 * 存储的是**百分比**而不是像素，与默认比例是同一套模型 ——
 * 所以用户拖过的比例同样跟着窗口缩放走，不会出现「窗口一放大，用户设的那栏
 * 又变回固定宽度」这种与默认行为不一致的割裂感。
 *
 * null 表示「没有覆盖，用样式表里的默认值」，双击分隔条即可清回 null；
 * 这也让「默认值」保持在 styles.css 一处定义，JS 不再抄一遍数字。
 */
function usePaneShares(appRef: React.RefObject<HTMLElement | null>): [PaneShares | null, (next: PaneShares | null) => void] {
  const [shares, setShares] = useState<PaneShares | null>(() => {
    try {
      const raw = window.localStorage.getItem(PANE_STORE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PaneShares>
      return typeof parsed.nav === 'number' && typeof parsed.list === 'number'
        ? { nav: parsed.nav, list: parsed.list } : null
    } catch {
      /* 隐私模式、或本地存了坏数据：静默回落到默认比例，不影响启动 */
      return null
    }
  })

  useEffect(() => {
    try {
      if (shares) window.localStorage.setItem(PANE_STORE_KEY, JSON.stringify(shares))
      else window.localStorage.removeItem(PANE_STORE_KEY)
    } catch { /* 写不进去只影响下次启动的记忆，不影响本次调整 */ }
  }, [shares])

  /* 窗口变小后，原来合法的百分比可能已经低于某一栏的下限了（下限是 px）。
     这里在每次 resize 后重新夹一遍 —— 不这么做，用户在大窗口拖窄的栏
     到小窗口就会挤成一条。只在确有覆盖时监听，默认态交给 CSS 比例。 */
  useEffect(() => {
    if (!shares) return
    const onResize = (): void => {
      const shell = appRef.current
      if (!shell) return
      const width = shell.getBoundingClientRect().width
      setShares((current) => {
        if (!current) return current
        const next = clampShares(current, width)
        return next.nav === current.nav && next.list === current.list ? current : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [shares, appRef])

  return [shares, setShares]
}

/**
 * 分区拖拽条。
 *
 * index=0 在导航与列表之间（没有列表时即导航与内容之间），index=1 在列表与内容之间。
 * 拖动只影响**相邻两栏**，这是垂直分隔条的通用约定（编辑器、文件管理器都这样）：
 * 所以 index=0 是「导航 ↔ 列表」此消彼长、内容不动；index=1 是「列表 ↔ 内容」。
 *
 * 用 pointer 事件 + setPointerCapture：鼠标移出这条 6px 的细条（甚至移出窗口）
 * 也不会丢拖动，不需要在 window 上挂一堆监听再拆。
 */
function PaneResizer({ index, appRef, onShares, onReset }: {
  index: number; appRef: React.RefObject<HTMLElement | null>
  onShares: (next: PaneShares | null) => void; onReset: () => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; start: PaneShares & { width: number } } | null>(null)
  const [active, setActive] = useState(false)

  function applyFrom(start: PaneShares & { width: number }, deltaPct: number): void {
    onShares(clampShares(resizeShares(index, start, deltaPct), start.width))
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const shell = appRef.current
    if (!shell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, start: measureShares(shell) }
    /* 直接改 class 而不是走 state：拖动是每帧触发的高频路径，没必要让整棵树重渲染 */
    shell.classList.add('is-resizing')
    setActive(true)
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (!current) return
    applyFrom(current.start, ((event.clientX - current.x) / current.start.width) * 100)
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return
    drag.current = null
    appRef.current?.classList.remove('is-resizing')
    setActive(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const shell = appRef.current
    if (!shell) return
    event.preventDefault()
    const step = event.shiftKey ? 2 : 0.5
    applyFrom(measureShares(shell), event.key === 'ArrowRight' ? step : -step)
  }

  const label = index === 0 ? '导航' : '列表'
  return (
    <div
      className={active ? 'pane-resizer is-active' : 'pane-resizer'}
      data-pane={index === 0 ? 'nav-list' : 'list-content'}
      role="separator"
      aria-orientation="vertical"
      aria-label={`拖动调整${label}栏宽度，双击恢复默认比例`}
      tabIndex={0}
      title={`拖动调整${label}栏宽度 · 双击恢复默认比例`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  )
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

function SpacePanel({ space, agents, models, messages, profile, busy, progress, streamingText, streamingReasoning, liveReplyIds, onSend, onStop, onEdit, onRemove, onUpdateContext }: {
  space: Space; agents: Agent[]; models: ModelOption[]; messages: Message[]; profile: UserProfile; busy: boolean; progress?: string; streamingText: string; streamingReasoning: string; liveReplyIds: Set<string>
  onSend: (content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions) => Promise<boolean>; onStop: () => Promise<boolean>; onEdit: () => void; onRemove: (id: string) => Promise<void>; onUpdateContext: (id: string, context: string) => Promise<void>
}): React.JSX.Element {
  const confirm = useConfirm()
  const members = agents.filter((agent) => space.memberIds.includes(agent.id))
  const [draft, setDraft] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingContext, setEditingContext] = useState(false)
  const [contextDraft, setContextDraft] = useState(space.context)
  const [savingContext, setSavingContext] = useState(false)
  const [contextError, setContextError] = useState('')
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
  return (
    <div className="page space-page">
      <header className="chat-header"><div className="chat-header-main"><div><h1>{space.name}</h1><p>{members.length} 个智能体 · {space.description}</p></div></div><div className="space-header-actions"><button className="ghost-button drawer-toggle" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((open) => !open)}>编辑空间 <ChevronRight size={15} /></button></div></header>
      <div className="space-layout">
        <div className="space-chat"><MessageList messages={messages} profile={profile} emptyText="使用 @智能体 开始协作" progress={progress} streamingText={streamingText} streamingReasoning={streamingReasoning} liveReplyIds={liveReplyIds} starters={['先让每位成员给出一版方案', '统一背景信息后再开始讨论']} onStarter={setDraft} /><Composer busy={busy} canAttach={canAttach} placeholder="@智能体 输入消息…" members={members} value={draft} onChange={setDraft} onSend={onSend} onStop={onStop} messages={messages} provider={routeAgent?.provider} model={model} models={availableModels} onModelChange={canSelectModel ? setModel : undefined} /></div>
        {drawerOpen && <aside className="context-drawer">
          <button className="secondary-button drawer-edit" disabled={busy} onClick={onEdit}>编辑空间信息</button>
          <div className="drawer-section">
            <span className="eyebrow">成员 · {members.length}</span>
            {members.length === 0 && <p className="form-error">这个空间还没有成员。</p>}
            {members.map((agent) => <div className="member" key={agent.id}><Avatar name={agent.name} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span><i className="dot" /></div>)}
          </div>
          <div className="drawer-section">
            <span className="eyebrow">背景信息</span>
            {editingContext ? <div className="context-editor"><textarea aria-label="背景信息" autoFocus value={contextDraft} onChange={(event) => setContextDraft(event.target.value)} />{contextError && <p className="form-error" role="alert">{contextError}</p>}<div><button className="secondary-button compact" disabled={savingContext} onClick={() => setEditingContext(false)}>取消</button><button className="primary-button compact" disabled={savingContext} onClick={() => void saveContext()}>保存背景</button></div></div> : <div className={space.context ? 'panel-card' : 'panel-card muted'}><p>{space.context || '暂无背景信息。'}</p><button className="text-button" onClick={() => { setContextDraft(space.context); setContextError(''); setEditingContext(true) }}>编辑背景</button></div>}
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
  const [permission, setPermission] = useState<ChatPermission>('full')
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
        <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder={placeholder} />
        {attachmentError && <p className="composer-error" role="alert">{attachmentError}</p>}
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
              <button type="button" className="composer-control model" aria-label={`选择模型，当前 ${selectedModel?.name ?? '成员模型'}`} aria-expanded={openMenu === 'model'} disabled={!onModelChange} onClick={() => setOpenMenu((current) => current === 'model' ? null : 'model')}>{provider && providerLogos[provider as ModelProviderId] && <img src={providerLogos[provider as ModelProviderId]} alt="" />}{selectedModel?.name ?? '成员模型'}<ChevronRight size={13} /></button>
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
  const [items, setItems] = useState<Array<{ id: string; name: string; description: string; status: string }>>([])
  useEffect(() => { void window.mindmesh.catalog[kind]().then(setItems) }, [kind])
  return <div className="page management-page"><header className="page-header"><div><span className="eyebrow">{kind.toUpperCase()}</span><h1>{kind === 'skills' ? '技能库' : '工具'}</h1><p>{kind === 'skills' ? '为智能体添加可复用的工作方法。' : '连接智能体可以使用的实际能力。'}</p></div></header>{items.length === 0 ? <div className="empty-state"><span className="empty-mark">{kind === 'skills' ? <Sparkles size={19} /> : <Wrench size={19} />}</span><h1>{kind === 'skills' ? '还没有可用技能' : '还没有可用工具'}</h1><p>安装后会自动出现在这里，并可绑定到智能体。</p></div> : <div className="catalog-grid">{items.map((item) => <article key={item.id}><div className="catalog-icon">{kind === 'skills' ? <Sparkles size={20} /> : <Wrench size={20} />}</div><h3>{item.name}</h3><p>{item.description}</p><span className="status-tag">{item.status}</span></article>)}</div>}</div>
}

function ProfileSettings({ profile, onSaved }: { profile: UserProfile; onSaved: (profile: UserProfile) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(profile)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
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
      if (typeof image === 'string') { editDraft((current) => ({ ...current, avatar: image })); setError('') }
      else setError('无法读取图片，请重试')
      setReading(false)
    }
    reader.onerror = () => { setError('无法读取图片，请重试'); setReading(false) }
    reader.readAsDataURL(file)
  }

  async function saveProfile(): Promise<void> {
    if (!draft.name.trim()) { setError('请输入昵称'); return }
    if (!changed) { setEditing(false); return }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await window.mindmesh.settings.saveProfile({ name: draft.name.trim(), avatar: draft.avatar })
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

  return <section className="settings-section profile-section"><h2>个人资料</h2>{editing
    ? <div className="profile-form">
        <div className="profile-avatar"><Avatar name={draft.name} image={draft.avatar} large /><div><label className="secondary-button compact" htmlFor="profile-avatar-input">选择头像</label><input id="profile-avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => chooseAvatar(event.target.files?.[0])} />{draft.avatar && <button className="text-button" onClick={() => editDraft((current) => ({ ...current, avatar: null }))}>移除头像</button>}<small>PNG、JPEG、WebP 或 GIF，最大 1 MB</small></div></div>
        <div className="field"><label htmlFor="profile-name-input">你希望智能体怎么称呼你</label><input id="profile-name-input" autoFocus aria-describedby="profile-name-hint" value={draft.name} maxLength={40} placeholder="例如：小明、王工、老板" onChange={(event) => editDraft((current) => ({ ...current, name: event.target.value }))} /><small className="field-hint" id="profile-name-hint">这个名字会显示在对话里，智能体也会用它称呼你</small></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="profile-actions"><button className="primary-button compact" disabled={saving || reading || !changed} onClick={() => void saveProfile()}>保存个人资料</button><button className="secondary-button compact" disabled={saving} onClick={cancelEditing}>取消</button></div>
      </div>
    : <div className="setting-row profile-row"><Avatar name={profile.name} image={profile.avatar} large /><div><strong className="profile-name">{profile.name}</strong><p>智能体在对话中会这样称呼你</p></div>{notice && <span className="form-success" role="status"><Check size={15} />{notice}</span>}<button className="secondary-button compact" onClick={startEditing}>编辑资料</button></div>}</section>
}

function SettingsPage({ runtime, profile, busy, onProfileChange, onRuntimeChange, onProviderChange }: {
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
              <div><strong>{provider.name}</strong><p>{provider.configured ? `${provider.description} 已连接，可以用于智能体对话。` : provider.description}</p>{provider.id === 'deepseek-official' && provider.configured && <ProviderBalance status={provider} />}</div>
              <span className={`state-badge ${provider.configured ? '' : 'warn'}`}>{provider.configured ? '已配置' : '需要配置'}</span>
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
      <section className="settings-section"><h2>运行状态</h2><div className="setting-row"><div className="runtime-icon"><Activity size={19} /></div><div><strong>{runtime?.label ?? '检查中'}</strong><p>{runtime?.detail}</p></div><span className={`state-badge ${runtime?.state === 'demo' ? 'warn' : ''}`}>{runtime?.state === 'demo' ? '等待连接' : '正常'}</span></div></section>
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
          {provider?.source === 'saved' && <button className="danger-button" disabled={saving} onClick={() => requestRemove(provider)}><Trash2 size={15} />移除</button>}
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

function ProviderBalance({ status }: { status: ModelProviderStatus }): React.JSX.Element {
  if (status.balanceError) return <div className="provider-balance unavailable"><span>余额暂时无法获取</span></div>
  if (!status.balance) return <div className="provider-balance"><span>余额查询中…</span></div>
  return <div className="provider-balance"><span className={status.balance.available ? 'balance-dot' : 'balance-dot unavailable'} />{status.balance.items.length > 0
    ? status.balance.items.map((item) => <strong key={item.currency}>{item.currency === 'CNY' ? '¥' : '$'}{item.total} <small>{item.currency}</small></strong>)
    : <strong>{status.balance.available ? '可用' : '余额不足'}</strong>}<small>更新于 {new Date(status.balance.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div>
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
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; status: string }>>([])
  const [tools, setTools] = useState<Array<{ id: string; name: string; description: string; status: string }>>([])
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
  function toggle(value: string, legacyValue = value, acceptLegacy = true): void { const key = step === 2 ? 'skills' : 'tools'; setForm((current) => { const checked = current[key].includes(value) || (acceptLegacy && current[key].includes(legacyValue)); const remaining = current[key].filter((item) => item !== value && item !== legacyValue); return { ...current, [key]: checked ? remaining : [...remaining, value] } }) }
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
          {(step === 2 || step === 3) && <><h3>{step === 2 ? '它会什么？' : '它可以使用哪些工具？'}</h3><div className="choice-list">{options.map((option) => { const value = step === 2 ? createSkillReference(option.id, option.name) : option.name; const selected = step === 2 ? form.skills : form.tools; const uniqueLegacy = step !== 2 || skills.filter((item) => item.name === option.name).length === 1; const checked = selected.includes(value) || (uniqueLegacy && selected.includes(option.name)); const unavailable = step === 3 && option.status !== '可用'; return <button key={value} className={checked ? 'checked' : ''} disabled={unavailable && !checked} onClick={() => toggle(value, option.name, uniqueLegacy)}><i>{checked ? '✓' : '+'}</i><span><strong>{option.name}</strong><small>{option.description}{unavailable ? ` · ${option.status}` : ''}</small></span></button> })}</div></>}
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

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <label className="field"><span>{label}</span>{children}</label> }

/** 头像首字：拉丁名取各词首字母（Product Manager → PM），中文名取前两字。 */
function avatarInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'M'
  if (/^[\p{Script=Latin}\p{N}]/u.test(trimmed)) {
    const words = trimmed.split(/[\s._-]+/).filter(Boolean)
    const initials = words.length > 1 ? words[0][0] + words[1][0] : trimmed.slice(0, 2)
    return initials.toUpperCase()
  }
  return Array.from(trimmed).slice(0, 2).join('')
}

/**
 * 由姓名派生稳定的归一化色位（0–1，同一个人永远同色）。
 * 只输出 0–1，具体色相区间交给样式表的调色板（--p-avatar-h0 / -dh / -s），
 * 这样换配色时头像色带会整体跟随，不会遗留在某个过时的色相范围里。
 */
function avatarTone(name: string): number {
  let hash = 0
  for (const character of name.trim()) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100003
  return Number(((hash % 1000) / 1000).toFixed(3))
}

function Avatar({ name, image, large = false }: { name: string; image?: string | null; large?: boolean }): React.JSX.Element {
  return (
    <span className={large ? 'avatar large' : 'avatar'} style={{ '--avatar-t': avatarTone(name) } as React.CSSProperties} aria-hidden="true">
      {image ? <img src={image} alt="" /> : avatarInitials(name)}
    </span>
  )
}
