import type { MarketplaceCatalog, MarketplaceKind } from './marketplace'
import type { PluginOperation, PluginRequest, PluginState } from './plugins'

export type AgentSource = {
  source: string
  sourceId: string
  revision: string
  repository: string
  content: string
  license: string
  licenseText: string
}

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
  source?: AgentSource
}

export type Space = {
  id: string
  name: string
  description: string
  context: string
  memberIds: string[]
  createdAt: string
  source?: { source: string; sourceId: string; revision: string; manifest: string }
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
  dshVersion?: string
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

export type CreateAgentInput = Omit<Agent, 'id' | 'createdAt' | 'source'>
export type CreateSpaceInput = Omit<Space, 'id' | 'createdAt' | 'source'>

export type ChatDelta = {
  requestId: string
  scope: Message['scope']
  scopeId: string
  agentId: string
  text: string
  kind?: 'text' | 'reasoning'
}

export type ChatProgress = Pick<Message, 'scope' | 'scopeId'> & { agentName: string }

/**
 * Why a run reached its terminal state.
 *
 * `completed` and `error` come from DSH `turn/end` `reason.kind`; `stopped` is
 * asserted by the services layer when `stop()` succeeds but no `turn/end`
 * arrives (closing the runtime cuts the event stream mid-flight). `blocked`,
 * `max-tokens` and `interrupted` map the remaining `TurnEndReason` kinds.
 */
export type RunEndReason =
  | 'completed'
  | 'stopped'
  | 'error'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'

/**
 * The runtime event vocabulary surfaced to the renderer.
 *
 * Identity fields, in descending order of authority (spike §6, v9 review):
 *   - `requestId`  = the run id. One MindMesh execution of one agent, and the
 *     value `runs.id` will hold. A session can host several runs.
 *   - `sessionId`  = the native `params.sessionId` from the DSH notification.
 *     This is the authoritative Session identity and is NOT interchangeable
 *     with `requestId` — the SDK subscribes a Session tree, so child sessions
 *     have their own `seq` space.
 *   - `seq`        = the native per-Session monotonic sequence. Dedup/sort key
 *     is `(sessionId, seq)`, never `seq` alone and never `runId`.
 *   - `conversationId` = the `conversationIdFor(scope, scopeId)` value such as
 *     `private:<agentId>` or `space:<spaceId>`. This is what the renderer's
 *     `conversationRef` holds, so it must match exactly — not the runtime
 *     session `contextKey` (`conversation:<conversationId>:<agentId>`).
 *   - `agentId`     = the agent that produced the event.
 *   - `time`        = native epoch-millis timestamp when available.
 *
 * `run:start` carries `executionId` and `triggerMessageId` (one level above the
 * run — an Execution fans out to several runs); `run:end` carries the terminal
 * `reason` and, once persisted, the `responseMessageId` that links a completed
 * run back to its stored assistant message.
 */
export type RuntimeEvent =
  | {
      type: 'run:start'
      requestId: string
      conversationId: string
      agentId: string
      agentName: string
      executionId: string
      triggerMessageId: string
      time: number
    }
  | {
      type: 'text:delta'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      text: string
    }
  | {
      type: 'reasoning:delta'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      text: string
    }
  | {
      type: 'tool:start'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      callId: string
      toolName: string
      displayName: string
    }
  | {
      type: 'tool:delta'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      callId: string
      text: string
    }
  | {
      type: 'tool:output'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      callId: string
      text: string
      isError: boolean
      truncated: boolean
    }
  | {
      type: 'tool:end'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      callId: string
      aborted: boolean
    }
  | {
      type: 'usage'
      requestId: string
      sessionId: string
      seq: number
      conversationId: string
      agentId: string
      time: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
  | {
      type: 'error'
      requestId: string
      conversationId: string
      agentId: string
      message: string
    }
  | {
      type: 'run:end'
      requestId: string
      conversationId: string
      agentId: string
      reason: RunEndReason
      responseMessageId?: string
    }

export type MindMeshApi = {
  plugins: {
    state(): Promise<PluginState>
    change(request: PluginRequest): Promise<PluginOperation>
    importGitHub(request: { requestId: string; url: string }): Promise<PluginOperation>
    cancel(requestId: string): Promise<boolean>
    onProgress(listener: (operation: PluginOperation) => void): () => void
  }
  marketplace: {
    list(kind: MarketplaceKind, refresh?: boolean): Promise<MarketplaceCatalog>
    installAgent(key: string, revision: string): Promise<Agent>
    installTeam(key: string, revision: string): Promise<Space>
  }
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
    sendPrivate(
      agentId: string,
      content: string,
      attachments?: ChatImageAttachment[],
      options?: ChatRunOptions
    ): Promise<Message[]>
    sendSpace(
      spaceId: string,
      content: string,
      attachments?: ChatImageAttachment[],
      options?: ChatRunOptions
    ): Promise<Message[]>
    stop(scope: Message['scope'], scopeId: string): Promise<boolean>
    onDelta(listener: (event: ChatDelta) => void): () => void
    onProgress(listener: (event: ChatProgress) => void): () => void
    onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void
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
