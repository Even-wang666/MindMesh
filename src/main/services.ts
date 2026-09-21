import type { WebContents } from 'electron'
import type {
  CreateAgentInput, CreateSpaceInput, Message, ModelProviderId, SaveModelProviderInput,
} from '../shared/contracts'
import { buildPrivatePrompt, buildSpacePrompt, parseMentions } from '../shared/domain'
import { MODEL_CATALOG } from '../shared/model-providers'
import { MindMeshDatabase } from './database'
import { DeepSeekHarnessAdapter } from './harness-adapter'
import { ModelProviderSettings } from './model-provider-settings'

export class MindMeshServices {
  constructor(
    readonly db: MindMeshDatabase,
    readonly harness: DeepSeekHarnessAdapter,
    readonly providerSettings: ModelProviderSettings,
    private readonly renderer: () => WebContents | undefined,
  ) {}

  listAgents = () => this.db.listAgents()
  createAgent = (input: CreateAgentInput) => this.db.createAgent(input)
  updateAgent = (id: string, input: CreateAgentInput) => this.db.updateAgent(id, input)
  removeAgent = (id: string) => this.db.removeAgent(id)
  listSpaces = () => this.db.listSpaces()
  createSpace = (input: CreateSpaceInput) => this.db.createSpace(input)
  messages = (scope: Message['scope'], scopeId: string) => this.db.listMessages(scope, scopeId)
  modelProviders = () => this.providerSettings.statuses()

  async saveModelProvider(input: SaveModelProviderInput) {
    const statuses = this.providerSettings.save(input)
    await this.harness.shutdownAll()
    return statuses
  }

  async removeModelProvider(id: ModelProviderId) {
    const statuses = this.providerSettings.remove(id)
    await this.harness.shutdownAll()
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
    this.db.addMessage({ scope: 'private', scopeId: agentId, authorType: 'user', authorName: '你', content })
    const requestId = crypto.randomUUID()
    const result = await this.harness.run(agent, buildPrivatePrompt(agent, content), `private-${agentId}`)
    this.emitText(requestId, 'private', agentId, agent.id, result.text)
    this.db.addMessage({
      scope: 'private', scopeId: agentId, authorType: 'agent', authorId: agent.id,
      authorName: agent.name, content: result.text,
    })
    return this.db.listMessages('private', agentId)
  }

  async sendSpace(spaceId: string, content: string): Promise<Message[]> {
    const space = this.db.getSpace(spaceId)
    if (!space) throw new Error('协作空间不存在')
    const members = space.memberIds.map((id) => this.db.getAgent(id)).filter((agent) => agent !== undefined)
    const mentioned = parseMentions(content, members)
    this.db.addMessage({ scope: 'space', scopeId: spaceId, authorType: 'user', authorName: '你', content })
    if (mentioned.length === 0) {
      this.db.addMessage({
        scope: 'space', scopeId: spaceId, authorType: 'system', authorName: 'MindMesh',
        content: '请使用 @智能体 指定参与本次讨论的成员。',
      })
      return this.db.listMessages('space', spaceId)
    }

    for (const agent of mentioned) {
      const visibleMessages = this.db.listMessages('space', spaceId).slice(-30)
      const prompt = buildSpacePrompt(agent, space, visibleMessages)
      const result = await this.harness.run(agent, prompt, `space-${spaceId}-${agent.id}`)
      const requestId = crypto.randomUUID()
      this.emitText(requestId, 'space', spaceId, agent.id, result.text)
      this.db.addMessage({
        scope: 'space', scopeId: spaceId, authorType: 'agent', authorId: agent.id,
        authorName: agent.name, content: result.text,
      })
    }
    return this.db.listMessages('space', spaceId)
  }

  private emitText(
    requestId: string,
    scope: Message['scope'],
    scopeId: string,
    agentId: string,
    text: string,
  ): void {
    this.renderer()?.send('chat:delta', { requestId, scope, scopeId, agentId, text })
  }
}
