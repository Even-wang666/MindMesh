import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {
  Agent,
  ChatImageAttachment,
  ChatPermission,
  RunEndReason,
  RuntimeEvent,
  RuntimeStatus,
} from '../shared/contracts'
import type { ModelProviderSettings } from './model-provider-settings'
import { getAgentCapabilityHash } from './agent-capability'
import { resolveSelectedSkills, skillBundlesRevision } from './skills'
import { getDshRuntimeInfo } from './dsh-runtime'
import {
  getRuntimeIdentity,
  providerRuntimeRevision,
  type RuntimeRequest,
} from './runtime-revision'
import { RuntimeSupervisor, type RuntimeOwner } from './runtime-supervisor'
import { conversationRuntimeKeyPrefix } from './database'
import { redactPluginDiagnostic } from './plugins/plugin-diagnostics'
import { randomUUID } from 'node:crypto'
import { RuntimeFailure, runtimeFailureDetail } from './runtime-errors'
import type { PluginSetManager } from './plugins/plugin-set'

/**
 * A tool result can be arbitrarily large (a 100k-character file read is routine).
 * Streaming that raw into an IPC event would freeze the renderer, so the preview
 * is capped here and `truncated` flags the cut. The cap is a preview only — the
 * full output is still what the run persists to the tool_call row later.
 */
const MAX_TOOL_PREVIEW_CHARS = 4_000

/** Cap a tool result to a preview and mark whether anything was cut. */
export function toolPreview(value: string): { text: string; truncated: boolean } {
  const text = redactPluginDiagnostic(value)
  if (text.length <= MAX_TOOL_PREVIEW_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_TOOL_PREVIEW_CHARS), truncated: true }
}

/** Map a DSH turn-end reason onto the renderer-visible terminal state. */
export function mapTurnEndReason(reason: TurnEndReason): RunEndReason {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'stopped'
    case 'error':
      return 'error'
    case 'blocked':
      return 'blocked'
    case 'max-tokens':
      return 'max-tokens'
    case 'interrupted':
      return 'interrupted'
    case 'forked':
      // A fork boundary is not a failure; the source turn simply ends.
      return 'completed'
    default:
      return 'completed'
  }
}

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
    private readonly providerSettings: Pick<
      ModelProviderSettings,
      'getProvider' | 'configuredProviders'
    >,
    private readonly pluginSet?: PluginSetManager
  ) {
    this.supervisor = new RuntimeSupervisor(dataDirectory)
    this.unsubscribePlugins = pluginSet?.onChange(() => {
      void this.supervisor.invalidatePlugins().catch(() => {})
    })
  }

  get workspacePath(): string {
    return this.workspace
  }

  setWorkspace(path: string): void {
    this.workspace = path
  }

  cleanupUnusedHomes(capabilityHashes: string[]): void {
    this.supervisor.cleanupHomes(capabilityHashes)
  }

  prepareRun(agent: Agent, permission: ChatPermission): RuntimeRequest {
    const effective = {
      ...agent,
      skills: [...agent.skills],
      tools:
        permission === 'chat'
          ? []
          : permission === 'workspace'
            ? agent.tools.filter((tool) => tool !== 'Shell')
            : [...agent.tools],
    }
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
    const pluginRevision = plugins
      ? `${plugins.revision}:${plugins.artifact?.digest ?? 'missing'}`
      : 'none'
    if (permission === 'full') {
      if (
        this.observedPluginRevision !== undefined &&
        this.observedPluginRevision !== pluginRevision
      )
        void this.supervisor.invalidatePlugins().catch(() => {})
      this.observedPluginRevision = pluginRevision
    }
    const identity = getRuntimeIdentity({
      baseHash: getAgentCapabilityHash(effective),
      skillRevision: skillBundlesRevision(skills.map((skill) => skill.directory)),
      workspace: this.workspace,
      permission,
      providerRevision: providerRuntimeRevision(providers, this.dataDirectory),
      dshVersion: runtime.version,
      pluginRevision,
    })
    return Object.freeze({
      agent: Object.freeze(effective),
      workspace: this.workspace,
      identity,
      providers: Object.freeze(providers.map((value) => Object.freeze(value))),
      skillIds: Object.freeze(skills.map((skill) => skill.id)),
      dshBin: runtime.dshBin,
      ...(plugins ? { plugins } : {}),
    })
  }

  capabilityHash(agent: Agent, permission: ChatPermission = 'chat'): string {
    return this.prepareRun(agent, permission).identity.capabilityHash
  }

  status(): RuntimeStatus {
    const dshVersion = getDshRuntimeInfo().version
    const diagnostics = this.supervisor.listStatus()
    const failed = diagnostics.find((entry) => entry.state === 'failed')
    if (failed)
      return {
        state: 'error',
        dshVersion,
        label: '运行异常',
        detail: runtimeFailureDetail(failed.lastError?.kind ?? 'unknown'),
      }
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

  async run(
    agent: Agent,
    prompt: string,
    sessionId?: string,
    onText?: (text: string, kind: 'text' | 'reasoning') => void,
    attachments: ChatImageAttachment[] = [],
    request?: RuntimeRequest,
    freshSession = false,
    runOptions?: Omit<RuntimeOwner, 'agentId'> & {
      recoveryPrompt: () => string
      conversationId: string
    },
    onRuntimeEvent?: (event: RuntimeEvent) => void
  ): Promise<{
    text: string
    reasoning?: string
    sessionId?: string
    endReason?: RunEndReason
  }> {
    const snapshot = request ?? this.prepareRun(agent, 'chat')
    agent = snapshot.agent
    const provider = snapshot.providers.find((value) => value.id === agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const lease = await this.supervisor.acquire(snapshot, {
      agentId: agent.id,
      contextKey: runOptions?.contextKey ?? agent.id,
      requestId: runOptions?.requestId ?? randomUUID(),
    })
    // requestId is the run identity; conversationId must be the renderer-facing
    // `conversationIdFor` value (`private:<id>` / `space:<id>`), NOT the runtime
    // session `contextKey` (`conversation:<id>:<agentId>`). Using contextKey here
    // was the original bug: the renderer filters on conversationId and would drop
    // every event because the two never matched.
    const eventRequestId = runOptions?.requestId ?? ''
    const eventConversationId = runOptions?.conversationId ?? agent.id
    const emit = (event: RuntimeEvent): void => onRuntimeEvent?.(event)
    const reasoning: string[] = []
    const assistantTexts: string[] = []
    const trace: string[] = []
    // (sessionId, seq) dedup: the SDK subscribes a Session tree, so child
    // sessions deliver events with an independent seq space. The native
    // notification may also be re-delivered; only the first occurrence counts.
    const seen = new Set<string>()
    // Tool calls opened by tool/call but never closed by tool/result — an
    // interrupted run strands these, and they must surface as aborted.
    const openToolCalls = new Set<string>()
    let terminalReason: RunEndReason | undefined
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
        const input =
          attachments.length > 0
            ? [
                { type: 'text' as const, text },
                ...attachments.map((attachment) => ({
                  type: 'image' as const,
                  data: attachment.data,
                  mimeType: attachment.mediaType,
                })),
              ]
            : text
        return lease.harness.run(input, {
          sessionId: id,
          onNotification: (notification) => {
            if (notification.method !== 'session.event') return
            const event = notification.params.event as SessionEvent
            const eventSessionId = String(notification.params.sessionId ?? '')
            const seq = event.seq
            const time = event.time
            // Dedup on the authoritative (sessionId, seq) pair. seq is always
            // present on a real wire event, but guard against a missing one so
            // an untagged event is never silently dropped as a duplicate.
            const dedupKey = typeof seq === 'number' ? `${eventSessionId}:${seq}` : null
            if (dedupKey && seen.has(dedupKey)) return
            if (dedupKey) seen.add(dedupKey)

            // assistant/message: text + reasoning + per-request usage
            if (event.type === 'assistant/message') {
              const textParts: string[] = []
              for (const block of event.data.message.content) {
                if (block.type === 'reasoning' && block.text.trim()) {
                  const part = block.text.trim()
                  onText?.(`${reasoning.length ? '\n\n' : ''}${part}`, 'reasoning')
                  reasoning.push(part)
                  trace.push(part)
                  if (onRuntimeEvent) {
                    emit({
                      type: 'reasoning:delta',
                      requestId: eventRequestId,
                      sessionId: eventSessionId,
                      seq,
                      conversationId: eventConversationId,
                      agentId: agent.id,
                      time,
                      text: part,
                    })
                  }
                } else if (block.type === 'text' && block.text) textParts.push(block.text)
              }
              if (textParts.length) {
                const text = textParts.join('\n\n')
                onText?.(`${assistantTexts.length ? '\n\n' : ''}${text}`, 'text')
                assistantTexts.push(text)
                trace.push(text)
                if (onRuntimeEvent) {
                  emit({
                    type: 'text:delta',
                    requestId: eventRequestId,
                    sessionId: eventSessionId,
                    seq,
                    conversationId: eventConversationId,
                    agentId: agent.id,
                    time,
                    text,
                  })
                }
              }
              // usage is per-request (spike S0.2), not cumulative
              if (event.data.usage && onRuntimeEvent) {
                const usage = event.data.usage
                emit({
                  type: 'usage',
                  requestId: eventRequestId,
                  sessionId: eventSessionId,
                  seq,
                  conversationId: eventConversationId,
                  agentId: agent.id,
                  time,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                })
              }
            }

            // tool/call: a tool invocation starts
            if (event.type === 'tool/call' && onRuntimeEvent) {
              openToolCalls.add(event.data.callId)
              emit({
                type: 'tool:start',
                requestId: eventRequestId,
                sessionId: eventSessionId,
                seq,
                conversationId: eventConversationId,
                agentId: agent.id,
                time,
                callId: event.data.callId,
                toolName: event.data.name,
                // arguments is a JSON string (spike S0.1); the display name is
                // the tool name until a richer projection is available.
                displayName: event.data.name,
              })
            }

            // tool/result: a tool invocation completes
            if (event.type === 'tool/result' && onRuntimeEvent) {
              const message = event.data.message
              openToolCalls.delete(message.toolCallId)
              const raw =
                typeof message.content === 'string'
                  ? message.content
                  : Array.isArray(message.content)
                    ? message.content
                        .map((block: { type: string; text?: string }) =>
                          block.type === 'text' && block.text ? block.text : ''
                        )
                        .join('')
                    : ''
              // Redact secrets and cap the preview: a 100k-character file read
              // must never enter the event verbatim. The full value is still
              // what gets persisted to the tool_call row downstream.
              const { text: preview, truncated } = toolPreview(raw)
              emit({
                type: 'tool:output',
                requestId: eventRequestId,
                sessionId: eventSessionId,
                seq,
                conversationId: eventConversationId,
                agentId: agent.id,
                time,
                callId: message.toolCallId,
                text: preview,
                isError: Boolean(message.isError),
                truncated,
              })
              emit({
                type: 'tool:end',
                requestId: eventRequestId,
                sessionId: eventSessionId,
                seq,
                conversationId: eventConversationId,
                agentId: agent.id,
                time,
                callId: message.toolCallId,
                aborted: false,
              })
            }

            // turn/end: the only protocol-authoritative terminal state. Other
            // terminal outcomes (stop with no turn/end, harness rejection) are
            // asserted by the services layer, so this only records the reason
            // and lets services emit the single run:end.
            if (event.type === 'turn/end') {
              terminalReason = mapTurnEndReason(event.data.reason)
            }
          },
        })
      }
      try {
        result = await invoke(prompt, sessionId)
      } catch (error) {
        if (
          !runOptions ||
          !(error instanceof JsonRpcResponseError) ||
          !/^session ".+" already exists$/.test(error.message)
        )
          throw error
        reasoning.length = assistantTexts.length = trace.length = 0
        result = await invoke(runOptions.recoveryPrompt(), `session-${randomUUID()}`)
      }
      if (!(assistantTexts.at(-1) ?? result.finalResponse).trim())
        throw new RuntimeFailure('protocol')
      lease.sessions.add(result.sessionId)
    } catch (error) {
      if (!(error instanceof SessionResumeUnsupportedError)) failure = error
      if (
        error instanceof JsonRpcResponseError &&
        /^session ".+" already exists$/.test(error.message)
      ) {
        throw new SessionResumeUnsupportedError()
      }
      throw error
    } finally {
      // Stranded tool calls — interrupted before their tool/result — surface as
      // aborted so the renderer does not show them as running forever.
      if (onRuntimeEvent) {
        for (const callId of openToolCalls) {
          emit({
            type: 'tool:end',
            requestId: eventRequestId,
            sessionId: '',
            seq: -1,
            conversationId: eventConversationId,
            agentId: agent.id,
            time: Date.now(),
            callId,
            aborted: true,
          })
        }
      }
      await lease.release(failure)
    }
    // DSH may emit intermediate assistant text before the final reply. Persist the last text
    // segment as the answer and keep every earlier segment in the reasoning trace. This pairs
    // with services.ts, which streams callbacks first and only appends an unstreamed final suffix.
    const text = assistantTexts.at(-1) ?? result.finalResponse
    return {
      text,
      reasoning: (assistantTexts.length ? trace.slice(0, -1) : trace).join('\n\n') || undefined,
      sessionId: result.sessionId,
      endReason: terminalReason,
    }
  }

  runtimeDiagnostics() {
    return this.supervisor.listStatus()
  }
  invalidateProvider(id: string): Promise<void> {
    return this.supervisor.invalidateProvider(id)
  }
  invalidateWorkspace(): Promise<void> {
    return this.supervisor.invalidateWorkspace()
  }
  forgetAgent(id: string): Promise<void> {
    return this.supervisor.forgetOwner(id)
  }
  /**
   * Release the leases of the given conversations.
   *
   * Conversation ids are passed explicitly rather than derived from the space id:
   * Phase 2 gives a space several conversations whose ids no longer share the
   * `space:<id>` prefix, so a single-prefix match would leak the second one's
   * runtime instead of closing it.
   */
  forgetConversations(conversationIds: string[]): Promise<void> {
    return Promise.all(
      conversationIds.map((conversationId) =>
        this.supervisor.forgetOwner(undefined, conversationRuntimeKeyPrefix(conversationId))
      )
    ).then(() => undefined)
  }

  /** The SDK cannot cancel one shared turn; only close a sole matching lease. */
  stop(agent: Agent, requestId?: string): Promise<boolean> {
    return this.supervisor.stop(agent.id, requestId)
  }

  private demoResponse(agent: Agent, prompt: string): string {
    const lastLine =
      prompt
        .split('\n')
        .filter(Boolean)
        .at(-1)
        ?.replace(/^用户：/, '') ?? '你的问题'
    return `我是 ${agent.name}，当前处于本地演示模式。\n\n我已经收到：${lastLine}\n\n配置该智能体对应的模型服务后，这里会由 ${agent.model} 通过统一 Harness Runtime 返回真实结果。`
  }

  shutdownAll(): Promise<void> {
    this.unsubscribePlugins?.()
    return this.supervisor.shutdownAll()
  }
}
