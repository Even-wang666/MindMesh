export type Agent = {
  id: string
  name: string
  role: string
  persona: string
  provider: string
  model: string
  skills: string[]
  tools: string[]
  createdAt: string
}

export type Space = {
  id: string
  name: string
  description: string
  context: string
  memberIds: string[]
  createdAt: string
}

export type Message = {
  id: string
  scope: 'private' | 'space'
  scopeId: string
  authorType: 'user' | 'agent' | 'system'
  authorId?: string
  authorName: string
  content: string
  sequence: number
  createdAt: string
}

export type RuntimeStatus = {
  state: 'demo' | 'ready' | 'running' | 'error'
  label: string
  detail: string
}

export type UserProfile = { name: string; avatar: string | null }

export type ModelProviderId = 'deepseek-official' | 'moonshotai-cn' | 'openai' | 'anthropic' | 'custom'

export type ModelProviderStatus = {
  id: ModelProviderId
  name: string
  description: string
  configured: boolean
  source: 'saved' | 'environment' | null
  baseUrl?: string
  model?: string
}

export type SaveModelProviderInput = {
  id: ModelProviderId
  apiKey: string
  name?: string
  baseUrl?: string
  model?: string
}

export type CreateAgentInput = Omit<Agent, 'id' | 'createdAt'>
export type CreateSpaceInput = Omit<Space, 'id' | 'createdAt'>

export type ChatDelta = {
  requestId: string
  scope: Message['scope']
  scopeId: string
  agentId: string
  text: string
}

export type ChatProgress = Pick<Message, 'scope' | 'scopeId'> & { agentName: string }

export type MindMeshApi = {
  agents: {
    list(): Promise<Agent[]>
    create(input: CreateAgentInput): Promise<Agent>
    update(id: string, input: CreateAgentInput): Promise<Agent>
    remove(id: string): Promise<void>
  }
  spaces: {
    list(): Promise<Space[]>
    create(input: CreateSpaceInput): Promise<Space>
    update(id: string, input: CreateSpaceInput): Promise<Space>
    updateContext(id: string, context: string): Promise<Space>
  }
  chat: {
    messages(scope: Message['scope'], scopeId: string): Promise<Message[]>
    sendPrivate(agentId: string, content: string): Promise<Message[]>
    sendSpace(spaceId: string, content: string): Promise<Message[]>
    onDelta(listener: (event: ChatDelta) => void): () => void
    onProgress(listener: (event: ChatProgress) => void): () => void
  }
  catalog: {
    skills(): Promise<Array<{ id: string; name: string; description: string; status: string }>>
    tools(): Promise<Array<{ id: string; name: string; description: string; status: string }>>
    models(): Promise<Array<{ provider: string; id: string; name: string }>>
  }
  runtime: {
    status(): Promise<RuntimeStatus>
  }
  settings: {
    profile(): Promise<UserProfile>
    saveProfile(profile: UserProfile): Promise<UserProfile>
    modelProviders(): Promise<ModelProviderStatus[]>
    saveModelProvider(input: SaveModelProviderInput): Promise<ModelProviderStatus[]>
    removeModelProvider(id: ModelProviderId): Promise<ModelProviderStatus[]>
  }
}
