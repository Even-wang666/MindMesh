import type { WebContents } from 'electron'
import type {
  CreateAgentInput, CreateSpaceInput, Message, ModelProviderId, RuntimeStatus, SaveModelProviderInput, UserProfile,
} from '../shared/contracts'
import { buildPrivatePrompt, buildSpacePrompt, parseMentions } from '../shared/domain'
import { MODEL_CATALOG } from '../shared/model-providers'
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
  removeAgent = (id: string) => this.db.removeAgent(id)
  listSpaces = () => this.db.listSpaces()
  createSpace = (input: CreateSpaceInput) => this.db.createSpace(input)
  updateSpace = (id: string, input: CreateSpaceInput) => this.db.updateSpace(id, input)
  removeSpace = (id: string) => this.db.removeSpace(id)
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

  async sendPrivate(agentId: string, content: string): Promise<Message[]> {
    const agent = this.db.getAgent(agentId)
    if (!agent) throw new Error('智能体不存在')
    const contextKey = `private:${agentId}`
    const session = this.db.getOrCreateRuntimeSession(
      contextKey, agent, `private-${agentId}`, getAgentCapabilityHash(agent),
    )
    this.db.addMessage({ scope: 'private', scopeId: agentId, authorType: 'user', authorName: this.db.getUserProfile().name, content })
    const requestId = crypto.randomUUID()
    this.emitProgress('private', agentId, session.agent.name)
    let result
    try {
      result = await this.runAgent(session.agent, buildPrivatePrompt(session.agent, content),
        session.harnessSessionId, 'private', agentId, requestId,
        () => buildPrivatePrompt(session.agent, content,
          this.db.listMessages('private', agentId).slice(-31, -1)))
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

  async sendSpace(spaceId: string, content: string): Promise<Message[]> {
    const space = this.db.getSpace(spaceId)
    if (!space) throw new Error('协作空间不存在')
    const members = space.memberIds.map((id) => this.db.getAgent(id)).filter((agent) => agent !== undefined)
    const mentioned = parseMentions(content, members)
    this.db.addMessage({ scope: 'space', scopeId: spaceId, authorType: 'user', authorName: this.db.getUserProfile().name, content })
    if (mentioned.length === 0) {
      this.db.addMessage({
        scope: 'space', scopeId: spaceId, authorType: 'system', authorName: 'MindMesh',
        content: '请使用 @智能体 指定参与本次讨论的成员。',
      })
      return this.db.listMessages('space', spaceId)
    }

    for (const agent of mentioned) {
      const contextKey = `space:${spaceId}:${agent.id}`
      const session = this.db.getOrCreateRuntimeSession(
        contextKey, agent, `space-${spaceId}-${agent.id}`, getAgentCapabilityHash(agent),
        this.db.lastAgentMessageSequence(spaceId, agent.id),
      )
      const visibleMessages = this.db.listMessagesSince('space', spaceId,
        session.lastConsumedMessageSequence)
      const prompt = buildSpacePrompt(session.agent, space, visibleMessages)
      this.emitProgress('space', spaceId, session.agent.name)
      let result
      try {
        result = await this.runAgent(session.agent, prompt, session.harnessSessionId,
          'space', spaceId, crypto.randomUUID(),
          () => buildSpacePrompt(session.agent, space, this.db.listMessages('space', spaceId)))
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

  private async runAgent(
    agent: Parameters<DeepSeekHarnessAdapter['run']>[0], prompt: string, sessionId: string,
    scope: Message['scope'], scopeId: string, requestId: string, recoveryPrompt: () => string,
  ): ReturnType<DeepSeekHarnessAdapter['run']> {
    let streamed = ''
    const run = (input: string, id: string) => this.harness.run(agent, input, id, (text, kind) => {
      if (kind !== 'reasoning') streamed += text
      this.emitText(requestId, scope, scopeId, agent.id, text, kind)
    })
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
