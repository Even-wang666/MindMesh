import type { WebContents } from 'electron'
import type {
  ChatImageAttachment, CreateAgentInput, CreateSpaceInput, Message, ModelProviderId, RuntimeStatus, SaveModelProviderInput, UserProfile,
} from '../shared/contracts'
import { buildPrivatePrompt, buildSpacePrompt, parseMentions } from '../shared/domain'
import { MODEL_CATALOG, supportsImageInput } from '../shared/model-providers'
import { MindMeshDatabase } from './database'
import { DeepSeekHarnessAdapter, getAgentCapabilityHash, SessionResumeUnsupportedError } from './harness-adapter'
import { ModelProviderSettings } from './model-provider-settings'

export class MindMeshServices {
  private runtimeFailed = false

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
  modelProviders = () => this.providerSettings.statuses()
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
    const statuses = this.providerSettings.save(input)
    await this.harness.shutdownAll()
    this.resetRuntimeFailure()
    return statuses
  }

  async removeModelProvider(id: ModelProviderId) {
    const statuses = this.providerSettings.remove(id)
    await this.harness.shutdownAll()
    this.resetRuntimeFailure()
    return statuses
  }

  models = () => {
    const custom = this.providerSettings.statuses().find((provider) => provider.id === 'custom')
    return custom?.model
      ? [...MODEL_CATALOG, { provider: 'custom', id: custom.model, name: custom.model }]
      : MODEL_CATALOG
  }

  async sendPrivate(agentId: string, content: string, attachments: ChatImageAttachment[] = []): Promise<Message[]> {
    const agent = this.db.getAgent(agentId)
    if (!agent) throw new Error('智能体不存在')
    const images = validateImageAttachments(agent.provider, agent.model, attachments)
    const promptContent = content.trim() || '请分析附带的图片。'
    const contextKey = `private:${agentId}`
    let session = this.db.getOrCreateRuntimeSession(
      contextKey, agent, `private-${agentId}`, getAgentCapabilityHash(agent),
    )
    if (images.length > 0 && !supportsImageInput(session.agent.provider, session.agent.model)) {
      session = this.db.restartRuntimeSession(
        contextKey, agent, `private-${agentId}-${crypto.randomUUID()}`, getAgentCapabilityHash(agent),
      )
    }
    this.db.addMessage({ scope: 'private', scopeId: agentId, authorType: 'user', authorName: this.db.getUserProfile().name, content, attachments: images })
    const requestId = crypto.randomUUID()
    this.emitProgress('private', agentId, session.agent.name)
    let result
    try {
      result = await this.runAgent(session.agent, buildPrivatePrompt(session.agent, promptContent),
        session.harnessSessionId, 'private', agentId, requestId,
        () => buildPrivatePrompt(session.agent, promptContent,
          this.db.listMessages('private', agentId).slice(-31, -1)), images)
    } catch (error) {
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
    return this.db.listMessages('private', agentId)
  }

  async sendSpace(spaceId: string, content: string, attachments: ChatImageAttachment[] = []): Promise<Message[]> {
    const space = this.db.getSpace(spaceId)
    if (!space) throw new Error('协作空间不存在')
    const members = space.memberIds.map((id) => this.db.getAgent(id)).filter((agent) => agent !== undefined)
    const mentioned = parseMentions(content, members)
    const attachmentRoutes = mentioned.length > 0
      ? mentioned
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

    for (const agent of mentioned) {
      const contextKey = `space:${spaceId}:${agent.id}`
      let session = this.db.getOrCreateRuntimeSession(
        contextKey, agent, `space-${spaceId}-${agent.id}`, getAgentCapabilityHash(agent),
        this.db.lastAgentMessageSequence(spaceId, agent.id),
      )
      if (images.length > 0 && !supportsImageInput(session.agent.provider, session.agent.model)) {
        session = this.db.restartRuntimeSession(
          contextKey, agent, `space-${spaceId}-${agent.id}-${crypto.randomUUID()}`,
          getAgentCapabilityHash(agent), 0,
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
    }
    return this.db.listMessages('space', spaceId)
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
    const run = (input: string, id: string) => this.harness.run(agent, input, id, (text, kind) => {
      if (kind !== 'reasoning') streamed += text
      this.emitText(requestId, scope, scopeId, agent.id, text, kind)
    }, attachments)
    let result
    try {
      result = await run(prompt, sessionId)
    } catch (error) {
      if (!(error instanceof SessionResumeUnsupportedError)) throw error
      streamed = ''
      result = await run(recoveryPrompt(), `session-${crypto.randomUUID()}`)
    }
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
