import { DeepSeekHarness, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, ChatImageAttachment, ChatPermission, RuntimeStatus } from '../shared/contracts'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { ModelProviderSettings } from './model-provider-settings'
import { getModelProviderDefinition } from '../shared/model-providers'
import { getAgentCapabilityHash } from './agent-capability'
import { resolveSelectedSkills, skillBundlesRevision } from './skills'
import { getDshRuntimeInfo } from './dsh-runtime'
import { getRuntimeIdentity, providerRuntimeRevision, type RuntimeRequest } from './runtime-revision'
import { RuntimeHomeMaterializer } from './runtime-home-materializer'

export { getAgentCapabilityHash } from './agent-capability'
export { buildProviderSettingsYaml } from './runtime-home-materializer'

const MAX_IDLE_RUNTIMES = 8
const IDLE_RUNTIME_TTL_MS = 10 * 60_000
const HARNESS_SYSTEM_ENVIRONMENT = new Set([
  'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'OS', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PSMODULEPATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
])

type RuntimeEntry = {
  harness: DeepSeekHarness
  active: number
  activeAgents: Map<string, number>
  lastUsed: number
  sessions: Set<string>
}

export class SessionResumeUnsupportedError extends Error {
  constructor() {
    super('当前 Harness SDK 无法在新进程中恢复已有 Session')
  }
}

export class DeepSeekHarnessAdapter {
  private readonly runtimes = new Map<string, RuntimeEntry>()
  private readonly homes: RuntimeHomeMaterializer

  constructor(
    private workspace: string,
    private readonly dataDirectory: string,
    private readonly providerSettings: ModelProviderSettings,
  ) { this.homes = new RuntimeHomeMaterializer(dataDirectory) }

  get workspacePath(): string { return this.workspace }

  setWorkspace(path: string): void { this.workspace = path }

  cleanupUnusedHomes(capabilityHashes: string[]): void {
    this.homes.cleanupExpired(capabilityHashes, [...this.runtimes.keys()])
  }

  prepareRun(agent: Agent, permission: ChatPermission): RuntimeRequest {
    const effective = { ...agent, skills: [...agent.skills], tools: permission === 'chat' ? []
      : permission === 'workspace' ? agent.tools.filter((tool) => tool !== 'Shell') : [...agent.tools] }
    Object.freeze(effective.skills)
    Object.freeze(effective.tools)
    const provider = this.providerSettings.getProvider(effective.provider)
    const providers = provider ? [{ ...provider }] : []
    if (effective.tools.includes('网页搜索') && effective.provider !== 'deepseek-official') {
      const web = this.providerSettings.getProvider('deepseek-official')
      if (web) providers.push({ ...web })
    }
    const skills = resolveSelectedSkills(effective.skills, this.dataDirectory)
    const runtime = getDshRuntimeInfo()
    const identity = getRuntimeIdentity({ baseHash: getAgentCapabilityHash(effective), skillRevision: skillBundlesRevision(skills.map((skill) => skill.directory)),
      workspace: this.workspace, permission, providerRevision: providerRuntimeRevision(providers, this.dataDirectory), dshVersion: runtime.version })
    return Object.freeze({ agent: Object.freeze(effective), workspace: this.workspace, identity,
      providers: Object.freeze(providers.map((value) => Object.freeze(value))),
      skillIds: Object.freeze(skills.map((skill) => skill.id)), dshBin: runtime.dshBin })
  }

  capabilityHash(agent: Agent, permission: ChatPermission = 'chat'): string {
    return this.prepareRun(agent, permission).identity.capabilityHash
  }

  status(): RuntimeStatus {
    const dshVersion = getDshRuntimeInfo().version
    if (this.providerSettings.configuredProviders().length === 0) {
      return {
        state: 'demo',
        dshVersion,
        label: '等待配置',
        detail: '连接模型服务后即可开始真实对话。',
      }
    }
    return {
      state: this.runtimes.size > 0 ? 'running' : 'ready',
      dshVersion,
      label: this.runtimes.size > 0 ? '正常运行' : '准备就绪',
      detail: this.runtimes.size > 0 ? '模型服务正在响应对话。' : '模型服务已连接，可以开始对话。',
    }
  }

  async run(agent: Agent, prompt: string, sessionId?: string, onText?: (text: string, kind: 'text' | 'reasoning') => void, attachments: ChatImageAttachment[] = [], request?: RuntimeRequest, freshSession = false): Promise<{ text: string; reasoning?: string; sessionId?: string }> {
    const snapshot = request ?? this.prepareRun(agent, 'chat')
    agent = snapshot.agent
    const provider = snapshot.providers.find((value) => value.id === agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const key = snapshot.identity.key
    let entry = this.runtimes.get(key)
    if (!entry) {
      const { dshHome, capabilityPatch } = this.homes.ensure(snapshot)
      entry = {
        harness: new DeepSeekHarness({
          dshBin: snapshot.dshBin,
          profile: 'sdk',
          patches: [capabilityPatch],
          provider: agent.provider,
          model: agent.model,
          cwd: snapshot.workspace,
          processCwd: snapshot.workspace,
          dshHome,
          env: {
            ...systemEnvironment(),
            ...providerEnvironment(snapshot.providers),
            DSH_HOME: dshHome,
            ELECTRON_RUN_AS_NODE: '1',
          },
          maxTokens: 8192,
          // 思考强度是 harness 实例级构造参数：档位变化会改变能力哈希，
          // 从而落到独立的运行池条目（新 dshHome/新会话），无需额外失效逻辑。
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort as ReasoningEffortId } : {}),
          initializeTimeoutMs: 30_000,
        }),
        active: 0,
        activeAgents: new Map(),
        lastUsed: Date.now(),
        sessions: new Set(),
      }
      this.runtimes.set(key, entry)
    }
    entry.active += 1
    entry.activeAgents.set(agent.id, (entry.activeAgents.get(agent.id) ?? 0) + 1)
    entry.lastUsed = Date.now()
    this.runtimes.delete(key)
    this.runtimes.set(key, entry)
    const reasoning: string[] = []
    const assistantTexts: string[] = []
    const trace: string[] = []
    let result
    try {
      // A new SDK process cannot reliably resume even an existing on-disk session.
      // Recover each context separately; unknown IDs otherwise create empty sessions.
      if (request && sessionId && !freshSession && !entry.sessions.has(sessionId)) throw new SessionResumeUnsupportedError()
      const input = attachments.length > 0
        ? [{ type: 'text' as const, text: prompt }, ...attachments.map((attachment) => ({
            type: 'image' as const,
            data: attachment.data,
            mimeType: attachment.mediaType,
          }))]
        : prompt
      result = await entry.harness.run(input, {
        sessionId,
        onNotification: (notification) => {
          if (notification.method !== 'session.event') return
          const event = notification.params.event as SessionEvent
          if (event.type !== 'assistant/message') return
          const textParts: string[] = []
          for (const block of event.data.message.content) {
            if (block.type === 'reasoning' && block.text.trim()) {
              const part = block.text.trim()
              onText?.(`${reasoning.length ? '\n\n' : ''}${part}`, 'reasoning')
              reasoning.push(part)
              trace.push(part)
            } else if (block.type === 'text' && block.text) textParts.push(block.text)
          }
          if (textParts.length) {
            const text = textParts.join('\n\n')
            onText?.(`${assistantTexts.length ? '\n\n' : ''}${text}`, 'text')
            assistantTexts.push(text)
            trace.push(text)
          }
        },
      })
      entry.sessions.add(result.sessionId)
    } catch (error) {
      if (error instanceof JsonRpcResponseError && /^session ".+" already exists$/.test(error.message)) {
        throw new SessionResumeUnsupportedError()
      }
      throw error
    } finally {
      entry.active -= 1
      const agentRuns = (entry.activeAgents.get(agent.id) ?? 1) - 1
      if (agentRuns === 0) entry.activeAgents.delete(agent.id)
      else entry.activeAgents.set(agent.id, agentRuns)
      entry.lastUsed = Date.now()
      try { this.homes.markLastUsed(key) }
      catch { /* Timestamp maintenance must not replace a completed reply. */ }
      await this.evictIdle()
    }
    // DSH may emit intermediate assistant text before the final reply. Persist the last text
    // segment as the answer and keep every earlier segment in the reasoning trace. This pairs
    // with services.ts, which streams callbacks first and only appends an unstreamed final suffix.
    const text = assistantTexts.at(-1) ?? result.finalResponse
    if (!text.trim()) throw new Error('模型未返回正文')
    return {
      text,
      reasoning: (assistantTexts.length ? trace.slice(0, -1) : trace).join('\n\n') || undefined,
      sessionId: result.sessionId,
    }
  }

  private async evictIdle(): Promise<void> {
    const now = Date.now()
    for (const [key, entry] of this.runtimes) {
      if (entry.active) continue
      if (this.runtimes.size <= MAX_IDLE_RUNTIMES && now - entry.lastUsed < IDLE_RUNTIME_TTL_MS) continue
      this.runtimes.delete(key)
      try { await entry.harness.close() }
      catch { /* Cleanup must not replace a completed reply. */ }
    }
  }

  /** The SDK has no per-turn cancel method, so stopping a turn closes its owned runtime. */
  async stop(agent: Agent): Promise<boolean> {
    const ownedRuntimes = [...this.runtimes.entries()].filter(([, candidate]) =>
      candidate.active === 1 && candidate.activeAgents.get(agent.id) === 1)
    /* A runtime can be pooled by capability. Closing it is safe only when this is its sole turn. */
    if (ownedRuntimes.length !== 1) return false
    const [key, entry] = ownedRuntimes[0]
    this.runtimes.delete(key)
    await entry.harness.close()
    return true
  }

  private demoResponse(agent: Agent, prompt: string): string {
    const lastLine = prompt.split('\n').filter(Boolean).at(-1)?.replace(/^用户：/, '') ?? '你的问题'
    return `我是 ${agent.name}，当前处于本地演示模式。\n\n我已经收到：${lastLine}\n\n配置该智能体对应的模型服务后，这里会由 ${agent.model} 通过统一 Harness Runtime 返回真实结果。`
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(entries.map((entry) => entry.harness.close()))
  }
}

function providerEnvironment(providers: readonly ModelProviderRuntimeConfig[]): Record<string, string> {
  return Object.fromEntries(providers.map((provider) => [
    provider.id === 'custom' ? 'MINDMESH_CUSTOM_API_KEY' : getModelProviderDefinition(provider.id)?.environmentKey,
    provider.apiKey,
  ]).filter((entry): entry is [string, string] => Boolean(entry[0])))
}

function systemEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
      && HARNESS_SYSTEM_ENVIRONMENT.has(entry[0].toUpperCase()),
  ))
}
