import type { WebContents } from 'electron'
import type {
  Agent, ChatImageAttachment, ChatRunOptions, CreateAgentInput, CreateSpaceInput, Message, ModelProviderId, ModelProviderStatus, RuntimeStatus, SaveModelProviderInput, UserProfile,
} from '../shared/contracts'
import { buildPrivatePrompt, buildSpacePrompt, parseMentions } from '../shared/domain'
import { getModelContextWindow, MODEL_CATALOG, supportsImageInput } from '../shared/model-providers'
import { MindMeshDatabase } from './database'
import { DeepSeekHarnessAdapter, getAgentCapabilityHash, SessionResumeUnsupportedError } from './harness-adapter'
import { ModelProviderSettings } from './model-provider-settings'

export class MindMeshServices {
  private runtimeFailed = false
  private deepSeekBalance: ModelProviderStatus['balance']
  private deepSeekBalanceError = false
  private balanceRequestGeneration = 0
  private readonly activeStops = new Map<string, () => Promise<void>>()
  private deepSeekModelIds = new Set([
    ...MODEL_CATALOG.filter((item) => item.provider === 'deepseek-official').map((item) => item.id),
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
  ])

  constructor(
    readonly db: MindMeshDatabase,
    readonly harness: DeepSeekHarnessAdapter,
    readonly providerSettings: ModelProviderSettings,
    private readonly renderer: () => WebContents | undefined,
    private readonly onRuntimeError: (scope: 'private' | 'space', agentId: string, error: unknown) => void = () => {},
  ) {}

  listAgents = () => this.db.listAgents()
  createAgent = (input: CreateAgentInput) => this.db.createAgent(input)
  updateAgent = (id: string, input: CreateAgentInput) => this.db.updateAgent(id, input)
  removeAgent = async (id: string): Promise<void> => {
    this.db.removeAgent(id)
    await this.resetRuntimesAndCleanupHomes()
  }
  listSpaces = () => this.db.listSpaces()
  createSpace = (input: CreateSpaceInput) => this.db.createSpace(input)
  updateSpace = (id: string, input: CreateSpaceInput) => this.db.updateSpace(id, input)
  removeSpace = async (id: string): Promise<void> => {
    this.db.removeSpace(id)
    await this.resetRuntimesAndCleanupHomes()
  }
  updateSpaceContext = (id: string, context: string) => this.db.updateSpaceContext(id, context)
  messages = (scope: Message['scope'], scopeId: string) => this.db.listMessages(scope, scopeId)
  async stop(scope: Message['scope'], scopeId: string): Promise<boolean> {
    if ((scope !== 'private' && scope !== 'space') || typeof scopeId !== 'string') return false
    const stop = this.activeStops.get(`${scope}:${scopeId}`)
    if (!stop) return false
    await stop()
    return true
  }
  modelProviders = () => this.providerSettings.statuses().map((provider) => provider.id === 'deepseek-official'
    ? { ...provider, balance: provider.configured ? this.deepSeekBalance : undefined,
        balanceError: provider.configured ? this.deepSeekBalanceError : undefined }
    : provider)
  refreshModelProviders = async () => {
    await this.refreshDeepSeekBalance()
    return this.modelProviders()
  }
  runtimeStatus = (): RuntimeStatus => {
    const status = this.harness.status()
    return this.runtimeFailed && status.state !== 'demo'
      ? { state: 'error', label: '运行异常', detail: '上次模型回复失败，请检查模型服务配置或网络。' }
      : status
  }
  resetRuntimeFailure = (): void => { this.runtimeFailed = false }
  userProfile = () => this.db.getUserProfile()
  saveUserProfile = (profile: UserProfile) => this.db.saveUserProfile(profile)

  async changeWorkspace(path: string): Promise<void> {
    await this.harness.shutdownAll()
    this.db.changeWorkspace(path)
    this.harness.setWorkspace(path)
    this.cleanupUnusedHomes()
    this.resetRuntimeFailure()
  }

  async saveModelProvider(input: SaveModelProviderInput) {
    this.providerSettings.save(input)
    await this.harness.shutdownAll()
    this.resetRuntimeFailure()
    await this.refreshDeepSeekBalance()
    return this.modelProviders()
  }

  async removeModelProvider(id: ModelProviderId) {
    this.providerSettings.remove(id)
    if (id === 'deepseek-official') {
      this.balanceRequestGeneration += 1
      this.deepSeekBalance = undefined
      this.deepSeekBalanceError = false
    }
    await this.harness.shutdownAll()
    this.resetRuntimeFailure()
    return this.modelProviders()
  }

  models = async () => {
    const custom = this.providerSettings.statuses().find((provider) => provider.id === 'custom')
    const fallback = custom?.model
      ? [...MODEL_CATALOG, { provider: 'custom', id: custom.model, name: custom.model }]
      : MODEL_CATALOG
    const provider = this.providerSettings.getProvider('deepseek-official')
    if (!provider) return fallback
    try {
      const response = await fetch('https://api.deepseek.com/models', {
        headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return fallback
      const payload = await response.json() as { data?: Array<{ id?: unknown }> }
      const live = payload.data?.flatMap((item) => {
        if (typeof item.id !== 'string' || !/^[\w.-]{1,100}$/.test(item.id)) return []
        const contextWindow = getModelContextWindow('deepseek-official', item.id)
        return [{ provider: 'deepseek-official', id: item.id, name: displayDeepSeekModel(item.id),
          ...(contextWindow ? { contextWindow } : {}) }]
      }) ?? []
      if (live.length > 0) this.deepSeekModelIds = new Set([
        ...live.map((item) => item.id), 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
      ])
      return live.length > 0 ? [...fallback.filter((item) => item.provider !== 'deepseek-official'), ...live] : fallback
    } catch { return fallback }
  }

  async sendPrivate(agentId: string, content: string, attachments: ChatImageAttachment[] = [], options?: ChatRunOptions): Promise<Message[]> {
    const agent = this.db.getAgent(agentId)
    if (!agent) throw new Error('智能体不存在')
    const runAgent = resolveRunAgent(agent, options, this.deepSeekModelIds)
    const images = validateImageAttachments(runAgent.provider, runAgent.model, attachments)
    const promptContent = content.trim() || '请分析附带的图片。'
    const contextKey = `private:${agentId}`
    let session = this.db.getOrCreateRuntimeSession(
      contextKey, runAgent, `private-${agentId}`, getAgentCapabilityHash(runAgent),
    )
    let restarted = false
    if ((options && getAgentCapabilityHash(session.agent) !== getAgentCapabilityHash(runAgent))
      || (images.length > 0 && !supportsImageInput(session.agent.provider, session.agent.model))) {
      session = this.db.restartRuntimeSession(
        contextKey, runAgent, `private-${agentId}-${crypto.randomUUID()}`, getAgentCapabilityHash(runAgent),
      )
      restarted = true
    }
    this.db.addMessage({ scope: 'private', scopeId: agentId, authorType: 'user', authorName: this.db.getUserProfile().name, content, attachments: images })
    const history = this.db.listMessages('private', agentId).slice(-31, -1)
    const requestId = crypto.randomUUID()
    this.emitProgress('private', agentId, session.agent.name)
    let result
    try {
      result = await this.runAgent(session.agent, buildPrivatePrompt(session.agent, promptContent, restarted ? history : []),
        session.harnessSessionId, 'private', agentId, requestId,
        () => buildPrivatePrompt(session.agent, promptContent, history), images)
    } catch (error) {
      if (error instanceof ChatStoppedError) {
        if (error.text || error.reasoning) {
          this.db.addMessage({
            scope: 'private', scopeId: agentId, authorType: 'agent', authorId: agent.id,
            authorName: session.agent.name, content: error.text, reasoning: error.reasoning || undefined,
          })
        }
        void this.refreshDeepSeekBalance()
        return this.db.listMessages('private', agentId)
      }
      this.recordRuntimeError('private', agent.id, error)
      this.db.addMessage({
        scope: 'private', scopeId: agentId, authorType: 'system', authorName: 'MindMesh',
        content: `${agent.name} 回复失败，请检查模型服务配置或网络后重试。`,
      })
      return this.db.listMessages('private', agentId)
    }
    this.db.addMessage({
      scope: 'private', scopeId: agentId, authorType: 'agent', authorId: agent.id,
      authorName: session.agent.name, content: result.text, reasoning: result.reasoning,
    })
    this.db.saveRuntimeSessionProgress(contextKey, result.sessionId ?? session.harnessSessionId, 0)
    void this.refreshDeepSeekBalance()
    return this.db.listMessages('private', agentId)
  }

  async sendSpace(spaceId: string, content: string, attachments: ChatImageAttachment[] = [], options?: ChatRunOptions): Promise<Message[]> {
    const space = this.db.getSpace(spaceId)
    if (!space) throw new Error('协作空间不存在')
    const members = space.memberIds.map((id) => this.db.getAgent(id)).filter((agent) => agent !== undefined)
    const mentioned = parseMentions(content, members)
    const runAgents = mentioned.map((agent) => resolveRunAgent(agent, options, this.deepSeekModelIds))
    const attachmentRoutes = runAgents.length > 0
      ? runAgents
      : members.filter((agent) => supportsImageInput(agent.provider, agent.model)).slice(0, 1)
    const images = attachmentRoutes.length > 0
      ? attachmentRoutes.reduce((current, agent) => validateImageAttachments(agent.provider, agent.model, current), attachments)
      : validateImageAttachments('', '', attachments)
    this.db.addMessage({ scope: 'space', scopeId: spaceId, authorType: 'user', authorName: this.db.getUserProfile().name, content, attachments: images })
    if (mentioned.length === 0) {
      this.db.addMessage({
        scope: 'space', scopeId: spaceId, authorType: 'system', authorName: 'MindMesh',
        content: '请使用 @智能体 指定参与本次讨论的成员。',
      })
      return this.db.listMessages('space', spaceId)
    }

    for (const runAgent of runAgents) {
      const agent = members.find((item) => item.id === runAgent.id)!
      const contextKey = `space:${spaceId}:${agent.id}`
      let session = this.db.getOrCreateRuntimeSession(
        contextKey, runAgent, `space-${spaceId}-${agent.id}`, getAgentCapabilityHash(runAgent),
        this.db.lastAgentMessageSequence(spaceId, agent.id),
      )
      if ((options && getAgentCapabilityHash(session.agent) !== getAgentCapabilityHash(runAgent))
        || (images.length > 0 && !supportsImageInput(session.agent.provider, session.agent.model))) {
        session = this.db.restartRuntimeSession(
          contextKey, runAgent, `space-${spaceId}-${agent.id}-${crypto.randomUUID()}`,
          getAgentCapabilityHash(runAgent), 0,
        )
      }
      const visibleMessages = this.db.listMessagesSince('space', spaceId,
        session.lastConsumedMessageSequence)
      const prompt = buildSpacePrompt(session.agent, space, visibleMessages)
      this.emitProgress('space', spaceId, session.agent.name)
      let result
      try {
        result = await this.runAgent(session.agent, prompt, session.harnessSessionId,
          'space', spaceId, crypto.randomUUID(),
          () => buildSpacePrompt(session.agent, space, this.db.listMessages('space', spaceId)), images)
      } catch (error) {
        if (error instanceof ChatStoppedError) {
          if (error.text || error.reasoning) {
            this.db.addMessage({
              scope: 'space', scopeId: spaceId, authorType: 'agent', authorId: agent.id,
              authorName: session.agent.name, content: error.text, reasoning: error.reasoning || undefined,
            })
          }
          void this.refreshDeepSeekBalance()
          break
        }
        this.recordRuntimeError('space', agent.id, error)
        this.db.addMessage({
          scope: 'space', scopeId: spaceId, authorType: 'system', authorName: 'MindMesh',
          content: `${agent.name} 回复失败，请检查模型服务配置或网络后重试。`,
        })
        continue
      }
      const reply = this.db.addMessage({
        scope: 'space', scopeId: spaceId, authorType: 'agent', authorId: agent.id,
        authorName: session.agent.name, content: result.text, reasoning: result.reasoning,
      })
      this.db.saveRuntimeSessionProgress(contextKey, result.sessionId ?? session.harnessSessionId, reply.sequence)
      void this.refreshDeepSeekBalance()
    }
    return this.db.listMessages('space', spaceId)
  }

  private async refreshDeepSeekBalance(): Promise<void> {
    if (typeof this.providerSettings.getProvider !== 'function') return
    const generation = ++this.balanceRequestGeneration
    const provider = this.providerSettings.getProvider('deepseek-official')
    if (!provider) {
      if (generation === this.balanceRequestGeneration) {
        this.deepSeekBalance = undefined
        this.deepSeekBalanceError = false
      }
      return
    }
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as { is_available?: unknown; balance_infos?: unknown }
      if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) throw new Error('Invalid balance payload')
      const items = payload.balance_infos.flatMap((value) => {
        if (!value || typeof value !== 'object') return []
        const item = value as Record<string, unknown>
        if ((item.currency !== 'CNY' && item.currency !== 'USD')
          || ![item.total_balance, item.granted_balance, item.topped_up_balance]
            .every((amount) => typeof amount === 'string' && /^\d+(?:\.\d+)?$/.test(amount))) return []
        return [{ currency: item.currency as 'CNY' | 'USD', total: item.total_balance as string,
          granted: item.granted_balance as string, toppedUp: item.topped_up_balance as string }]
      })
      if (generation === this.balanceRequestGeneration) {
        this.deepSeekBalance = { available: payload.is_available, updatedAt: new Date().toISOString(), items }
        this.deepSeekBalanceError = false
      }
    } catch {
      if (generation === this.balanceRequestGeneration) this.deepSeekBalanceError = true
    }
  }

  private recordRuntimeError(scope: 'private' | 'space', agentId: string, error: unknown): void {
    this.runtimeFailed = true
    try { this.onRuntimeError(scope, agentId, error) }
    catch { /* Logging must not replace the visible failure message. */ }
  }

  private async resetRuntimesAndCleanupHomes(): Promise<void> {
    await this.harness.shutdownAll()
    this.cleanupUnusedHomes()
  }

  private cleanupUnusedHomes(): void {
    try { this.harness.cleanupUnusedHomes(this.db.referencedCapabilityHashes()) }
    catch { /* Cache cleanup must not replace a successful data change. */ }
  }

  private async runAgent(
    agent: Parameters<DeepSeekHarnessAdapter['run']>[0], prompt: string, sessionId: string,
    scope: Message['scope'], scopeId: string, requestId: string, recoveryPrompt: () => string,
    attachments: ChatImageAttachment[] = [],
  ): ReturnType<DeepSeekHarnessAdapter['run']> {
    let streamed = ''
    let streamedReasoning = ''
    let stopped = false
    const stopKey = `${scope}:${scopeId}`
    const stop = async (): Promise<void> => {
      stopped = true
      await this.harness.stop(agent)
    }
    this.activeStops.set(stopKey, stop)
    const run = (input: string, id: string) => this.harness.run(agent, input, id, (text, kind) => {
      if (stopped) return
      if (kind === 'reasoning') streamedReasoning += text
      else streamed += text
      this.emitText(requestId, scope, scopeId, agent.id, text, kind)
    }, attachments)
    let result
    try {
      result = await run(prompt, sessionId)
    } catch (error) {
      if (stopped) throw new ChatStoppedError(streamed, streamedReasoning)
      if (!(error instanceof SessionResumeUnsupportedError)) throw error
      streamed = ''
      streamedReasoning = ''
      try {
        result = await run(recoveryPrompt(), `session-${crypto.randomUUID()}`)
      } catch (recoveryError) {
        if (stopped) throw new ChatStoppedError(streamed, streamedReasoning)
        throw recoveryError
      }
    } finally {
      if (this.activeStops.get(stopKey) === stop) this.activeStops.delete(stopKey)
    }
    if (stopped) throw new ChatStoppedError(streamed, streamedReasoning)
    if (result.text.startsWith(streamed) && result.text.length > streamed.length) {
      this.emitText(requestId, scope, scopeId, agent.id, result.text.slice(streamed.length))
    }
    this.runtimeFailed = false
    return result
  }

  private emitProgress(scope: Message['scope'], scopeId: string, agentName: string): void {
    this.renderer()?.send('chat:progress', { scope, scopeId, agentName })
  }

  private emitText(
    requestId: string,
    scope: Message['scope'],
    scopeId: string,
    agentId: string,
    text: string,
    kind: 'text' | 'reasoning' = 'text',
  ): void {
    this.renderer()?.send('chat:delta', { requestId, scope, scopeId, agentId, text, kind })
  }
}

class ChatStoppedError extends Error {
  constructor(readonly text: string, readonly reasoning: string) {
    super('模型生成已由用户停止')
  }
}

const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function validateImageAttachments(provider: string, model: string, attachments: unknown): ChatImageAttachment[] {
  if (!Array.isArray(attachments)) throw new Error('附件数据无效')
  if (attachments.length === 0) return []
  if (attachments.length > 600) throw new Error('单次最多上传 600 张图片')
  if (!supportsImageInput(provider, model)) throw new Error('仅 DeepSeek Flash 支持图片输入')
  let totalBytes = 0
  return attachments.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('附件数据无效')
    const attachment = value as Record<string, unknown>
    if (typeof attachment.name !== 'string' || typeof attachment.data !== 'string') throw new Error('附件数据无效')
    if (attachment.type !== 'image' || typeof attachment.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
      throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片')
    }
    if (attachment.data.length > Math.ceil(MAX_INLINE_IMAGE_BYTES * 4 / 3) + 4) throw new Error('单张图片不能超过 32 MiB')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data) || attachment.data.length % 4 !== 0) {
      throw new Error('图片数据无效')
    }
    const bytes = Buffer.from(attachment.data, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) throw new Error('单张图片不能超过 32 MiB')
    totalBytes += bytes.length
    if (totalBytes > MAX_INLINE_IMAGE_BYTES) throw new Error('图片总大小不能超过 32 MiB')
    if (!matchesImageSignature(bytes, attachment.mediaType as ChatImageAttachment['mediaType'])) throw new Error('图片内容与格式不匹配')
    return {
      type: 'image',
      name: attachment.name.replace(/^.*[\\/]/, '').slice(0, 200) || 'image',
      mediaType: attachment.mediaType as ChatImageAttachment['mediaType'],
      data: attachment.data,
      bytes: bytes.length,
    }
  })
}

function matchesImageSignature(bytes: Buffer, mediaType: ChatImageAttachment['mediaType']): boolean {
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mediaType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mediaType === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function resolveRunAgent(agent: Agent, options: ChatRunOptions | undefined, deepSeekModelIds: ReadonlySet<string>): Agent {
  if (options === undefined) return agent
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('对话选项无效')
  const permission = options.permission ?? 'full'
  if (!['chat', 'workspace', 'full'].includes(permission)) throw new Error('权限级别无效')
  const model = options.model ?? agent.model
  if (typeof model !== 'string' || !/^[\w.:-]{1,100}$/.test(model)) throw new Error('模型 ID 无效')
  if (options.model !== undefined) {
    if (agent.provider !== 'deepseek-official') throw new Error('目前仅支持切换 DeepSeek 模型')
    if (!deepSeekModelIds.has(model)) throw new Error('DeepSeek 模型不可用，请刷新模型列表')
  }
  const tools = permission === 'chat' ? [] : permission === 'workspace'
    ? agent.tools.filter((tool) => tool !== 'Shell')
    : agent.tools
  return { ...agent, model, tools }
}

function displayDeepSeekModel(model: string): string {
  if (model === 'deepseek-flash') return 'DeepSeek V4.1 Flash'
  if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro'
  return model
}
