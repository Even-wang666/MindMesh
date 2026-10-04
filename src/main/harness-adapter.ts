import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, ChatImageAttachment, ChatPermission, RuntimeStatus } from '../shared/contracts'
import { ModelProviderSettings } from './model-provider-settings'
import { getAgentCapabilityHash } from './agent-capability'
import { resolveSelectedSkills, skillBundlesRevision } from './skills'
import { getDshRuntimeInfo } from './dsh-runtime'
import { getRuntimeIdentity, providerRuntimeRevision, type RuntimeRequest } from './runtime-revision'
import { RuntimeSupervisor, type RuntimeOwner } from './runtime-supervisor'
import { randomUUID } from 'node:crypto'
import { runtimeFailureDetail } from './runtime-errors'
import type { PluginSetManager } from './plugins/plugin-set'

export { getAgentCapabilityHash } from './agent-capability'
export { buildProviderSettingsYaml } from './runtime-home-materializer'

export class SessionResumeUnsupportedError extends Error {
  constructor() {
    super('当前 Harness SDK 无法在新进程中恢复已有 Session')
  }
}

export class DeepSeekHarnessAdapter {
  private readonly supervisor: RuntimeSupervisor
  private readonly unsubscribePlugins?: () => void
  private observedPluginRevision?: string

  constructor(
    private workspace: string,
    private readonly dataDirectory: string,
    private readonly providerSettings: ModelProviderSettings,
    private readonly pluginSet?: PluginSetManager,
  ) {
    this.supervisor = new RuntimeSupervisor(dataDirectory)
    this.unsubscribePlugins = pluginSet?.onChange(() => { void this.supervisor.invalidatePlugins().catch(() => {}) })
  }

  get workspacePath(): string { return this.workspace }

  setWorkspace(path: string): void { this.workspace = path }

  cleanupUnusedHomes(capabilityHashes: string[]): void {
    this.supervisor.cleanupHomes(capabilityHashes)
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
    const plugins = permission === 'full' ? this.pluginSet?.runtimeSnapshot() : undefined
    const pluginRevision = plugins ? `${plugins.revision}:${plugins.artifact?.digest ?? 'missing'}` : 'none'
    if (permission === 'full') {
      if (this.observedPluginRevision !== undefined && this.observedPluginRevision !== pluginRevision) void this.supervisor.invalidatePlugins().catch(() => {})
      this.observedPluginRevision = pluginRevision
    }
    const identity = getRuntimeIdentity({ baseHash: getAgentCapabilityHash(effective), skillRevision: skillBundlesRevision(skills.map((skill) => skill.directory)),
      workspace: this.workspace, permission, providerRevision: providerRuntimeRevision(providers, this.dataDirectory), dshVersion: runtime.version, pluginRevision })
    return Object.freeze({ agent: Object.freeze(effective), workspace: this.workspace, identity,
      providers: Object.freeze(providers.map((value) => Object.freeze(value))),
      skillIds: Object.freeze(skills.map((skill) => skill.id)), dshBin: runtime.dshBin, ...(plugins ? { plugins } : {}) })
  }

  capabilityHash(agent: Agent, permission: ChatPermission = 'chat'): string {
    return this.prepareRun(agent, permission).identity.capabilityHash
  }

  status(): RuntimeStatus {
    const dshVersion = getDshRuntimeInfo().version
    const diagnostics = this.supervisor.listStatus()
    const failed = diagnostics.find((entry) => entry.state === 'failed')
    if (failed) return { state: 'error', dshVersion, label: '运行异常',
      detail: runtimeFailureDetail(failed.lastError?.kind ?? 'unknown') }
    if (this.providerSettings.configuredProviders().length === 0) {
      return {
        state: 'demo',
        dshVersion,
        label: '等待配置',
        detail: '连接模型服务后即可开始真实对话。',
      }
    }
    return {
      state: diagnostics.length > 0 ? 'running' : 'ready',
      dshVersion,
      label: diagnostics.length > 0 ? '正常运行' : '准备就绪',
      detail: diagnostics.length > 0 ? '模型服务正在响应对话。' : '模型服务已连接，可以开始对话。',
    }
  }

  async run(agent: Agent, prompt: string, sessionId?: string, onText?: (text: string, kind: 'text' | 'reasoning') => void, attachments: ChatImageAttachment[] = [], request?: RuntimeRequest, freshSession = false, runOptions?: Omit<RuntimeOwner, 'agentId'> & { recoveryPrompt: () => string }): Promise<{ text: string; reasoning?: string; sessionId?: string }> {
    const snapshot = request ?? this.prepareRun(agent, 'chat')
    agent = snapshot.agent
    const provider = snapshot.providers.find((value) => value.id === agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const lease = await this.supervisor.acquire(snapshot, { agentId: agent.id,
      contextKey: runOptions?.contextKey ?? agent.id, requestId: runOptions?.requestId ?? randomUUID() })
    const reasoning: string[] = []
    const assistantTexts: string[] = []
    const trace: string[] = []
    let result
    let failure: unknown
    try {
      // A new SDK process cannot reliably resume even an existing on-disk session.
      // Recover each context separately; unknown IDs otherwise create empty sessions.
      if (request && sessionId && !freshSession && !lease.sessions.has(sessionId)) {
        if (!runOptions) throw new SessionResumeUnsupportedError()
        prompt = runOptions.recoveryPrompt()
        sessionId = `session-${randomUUID()}`
      }
      const invoke = (text: string, id?: string) => {
        const input = attachments.length > 0
        ? [{ type: 'text' as const, text }, ...attachments.map((attachment) => ({
            type: 'image' as const,
            data: attachment.data,
            mimeType: attachment.mediaType,
          }))]
        : text
        return lease.harness.run(input, {
        sessionId: id,
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
      }
      try { result = await invoke(prompt, sessionId) }
      catch (error) {
        if (!runOptions || !(error instanceof JsonRpcResponseError) || !/^session ".+" already exists$/.test(error.message)) throw error
        reasoning.length = assistantTexts.length = trace.length = 0
        result = await invoke(runOptions.recoveryPrompt(), `session-${randomUUID()}`)
      }
      lease.sessions.add(result.sessionId)
    } catch (error) {
      if (!(error instanceof SessionResumeUnsupportedError)) failure = error
      if (error instanceof JsonRpcResponseError && /^session ".+" already exists$/.test(error.message)) {
        throw new SessionResumeUnsupportedError()
      }
      throw error
    } finally {
      await lease.release(failure)
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

  runtimeDiagnostics() { return this.supervisor.listStatus() }
  invalidateProvider(id: string): Promise<void> { return this.supervisor.invalidateProvider(id) }
  invalidateWorkspace(): Promise<void> { return this.supervisor.invalidateWorkspace() }
  forgetAgent(id: string): Promise<void> { return this.supervisor.forgetOwner(id) }
  forgetSpace(id: string): Promise<void> { return this.supervisor.forgetOwner(undefined, `space:${id}:`) }

  /** The SDK cannot cancel one shared turn; only close a sole matching lease. */
  stop(agent: Agent, requestId?: string): Promise<boolean> { return this.supervisor.stop(agent.id, requestId) }

  private demoResponse(agent: Agent, prompt: string): string {
    const lastLine = prompt.split('\n').filter(Boolean).at(-1)?.replace(/^用户：/, '') ?? '你的问题'
    return `我是 ${agent.name}，当前处于本地演示模式。\n\n我已经收到：${lastLine}\n\n配置该智能体对应的模型服务后，这里会由 ${agent.model} 通过统一 Harness Runtime 返回真实结果。`
  }

  shutdownAll(): Promise<void> { this.unsubscribePlugins?.(); return this.supervisor.shutdownAll() }
}
