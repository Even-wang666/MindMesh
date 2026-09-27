export type Agent = {
  id: string
  name: string
  role: string
  persona: string
  provider: string
  model: string
  skills: string[]
  tools: string[]
  /** 思考强度档位（如 off/low/medium/high/max），缺省表示跟随模型服务商默认值 */
  reasoningEffort?: string
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

export type ChatImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type ChatImageAttachment = {
  type: 'image'
  name: string
  mediaType: ChatImageMediaType
  data: string
  bytes: number
}

export type ChatPermission = 'chat' | 'workspace' | 'full'

export type ChatRunOptions = {
  model?: string
  permission?: ChatPermission
}

export type ModelOption = { provider: string; id: string; name: string; contextWindow?: number }

export type CatalogItem = {
  id: string
  name: string
  description: string
  status: string
  available?: boolean
  diagnostic?: string
  source?: string
  integrity?: 'verified' | 'modified' | 'untracked'
  license?: string
  licenseSpdx?: boolean
  limitations?: string[]
}

export type SkillInstallProgress = {
  phase: 'resolving' | 'downloading' | 'extracting' | 'installing' | 'done'
  receivedBytes?: number
  totalBytes?: number
}

export type Message = {
  id: string
  scope: 'private' | 'space'
  scopeId: string
  authorType: 'user' | 'agent' | 'system'
  authorId?: string
  authorName: string
  content: string
  reasoning?: string | null
  attachments?: ChatImageAttachment[]
  stopped?: boolean
  sequence: number
  createdAt: string
}

export type RuntimeStatus = {
  state: 'demo' | 'ready' | 'running' | 'error'
  label: string
  detail: string
}

export type UserProfile = { name: string; avatar: string | null }

export type ModelProviderId =
  | 'deepseek-official'
  | 'moonshotai-cn'
  | 'openai'
  | 'anthropic'
  | 'minimax'
  | 'zhipu'
  | 'qwen'
  | 'stepfun'
  | 'custom'

export type ModelProviderStatus = {
  id: ModelProviderId
  name: string
  description: string
  configured: boolean
  source: 'saved' | 'environment' | null
  baseUrl?: string
  model?: string
  balance?: {
    available: boolean
    updatedAt: string
    items: Array<{ currency: 'CNY' | 'USD'; total: string; granted: string; toppedUp: string }>
  }
  balanceError?: boolean
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
  kind?: 'text' | 'reasoning'
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
    remove(id: string): Promise<void>
    updateContext(id: string, context: string): Promise<Space>
  }
  chat: {
    messages(scope: Message['scope'], scopeId: string): Promise<Message[]>
    sendPrivate(agentId: string, content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions): Promise<Message[]>
    sendSpace(spaceId: string, content: string, attachments?: ChatImageAttachment[], options?: ChatRunOptions): Promise<Message[]>
    stop(scope: Message['scope'], scopeId: string): Promise<boolean>
    onDelta(listener: (event: ChatDelta) => void): () => void
    onProgress(listener: (event: ChatProgress) => void): () => void
  }
  catalog: {
    skills(): Promise<CatalogItem[]>
    pickSkillDir(): Promise<string | null>
    installSkill(path: string): Promise<CatalogItem[]>
    installSkillFromGitHub(url: string): Promise<CatalogItem[]>
    onInstallProgress(listener: (event: SkillInstallProgress) => void): () => void
    tools(): Promise<CatalogItem[]>
    models(): Promise<ModelOption[]>
  }
  runtime: {
    status(): Promise<RuntimeStatus>
  }
  settings: {
    workspace(): Promise<string>
    pickWorkspace(): Promise<string | null>
    chooseWorkspace(path: string): Promise<string>
    profile(): Promise<UserProfile>
    saveProfile(profile: UserProfile): Promise<UserProfile>
    modelProviders(): Promise<ModelProviderStatus[]>
    saveModelProvider(input: SaveModelProviderInput): Promise<ModelProviderStatus[]>
    removeModelProvider(id: ModelProviderId): Promise<ModelProviderStatus[]>
  }
}
