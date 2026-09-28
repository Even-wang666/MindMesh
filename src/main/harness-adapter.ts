import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DeepSeekHarness, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, ChatImageAttachment, RuntimeStatus } from '../shared/contracts'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { ModelProviderSettings } from './model-provider-settings'
import { getModelProviderDefinition, MODEL_CATALOG } from '../shared/model-providers'
import { prepareAgentCapabilities } from './capabilities'
import { getAgentCapabilityHash } from './agent-capability'
import { selectedSkillsRevision } from './skills'

export { getAgentCapabilityHash } from './agent-capability'

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
}

export class SessionResumeUnsupportedError extends Error {
  constructor() {
    super('当前 Harness SDK 无法在新进程中恢复已有 Session')
  }
}

export class DeepSeekHarnessAdapter {
  private readonly runtimes = new Map<string, RuntimeEntry>()

  constructor(
    private workspace: string,
    private readonly dataDirectory: string,
    private readonly providerSettings: ModelProviderSettings,
  ) {}

  get workspacePath(): string { return this.workspace }

  setWorkspace(path: string): void { this.workspace = path }

  cleanupUnusedHomes(capabilityHashes: string[]): void {
    const root = join(this.dataDirectory, 'harness')
    if (!existsSync(root)) return
    const rootPath = realpathSync(root)
    const protectedNames = new Set([
      ...capabilityHashes.map((hash) => this.runtimeKey(hash).slice(0, 12)),
      ...[...this.runtimes.keys()].map((key) => key.slice(0, 12)),
    ])
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{12}$/.test(entry.name) || protectedNames.has(entry.name)) continue
      const target = resolve(rootPath, entry.name)
      try {
        if (dirname(target) !== rootPath || dirname(realpathSync(target)) !== rootPath) continue
        if (!existsSync(join(target, 'settings.yaml')) || !existsSync(join(target, 'capabilities.cordis.patch.yml'))) continue
        rmSync(target, { recursive: true, force: true })
      }
      catch { /* Failed cleanup must not prevent the app from starting. */ }
    }
  }

  private runtimeKey(agentKey: string): string {
    return this.workspace === process.cwd() && !agentKey.includes(':') ? agentKey
      : createHash('sha256').update(agentKey).update(this.workspace).digest('hex')
  }

  capabilityHash(agent: Agent): string {
    return getAgentCapabilityHash(agent, selectedSkillsRevision(agent.skills, this.dataDirectory))
  }

  status(): RuntimeStatus {
    if (this.providerSettings.configuredProviders().length === 0) {
      return {
        state: 'demo',
        label: '等待配置',
        detail: '连接模型服务后即可开始真实对话。',
      }
    }
    return {
      state: this.runtimes.size > 0 ? 'running' : 'ready',
      label: this.runtimes.size > 0 ? '正常运行' : '准备就绪',
      detail: this.runtimes.size > 0 ? '模型服务正在响应对话。' : '模型服务已连接，可以开始对话。',
    }
  }

  async run(agent: Agent, prompt: string, sessionId?: string, onText?: (text: string, kind: 'text' | 'reasoning') => void, attachments: ChatImageAttachment[] = []): Promise<{ text: string; reasoning?: string; sessionId?: string }> {
    const provider = this.providerSettings.getProvider(agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const agentKey = this.capabilityHash(agent)
    const key = this.runtimeKey(agentKey)
    let entry = this.runtimes.get(key)
    if (!entry) {
      const dshHome = join(this.dataDirectory, 'harness', key.slice(0, 12))
      mkdirSync(dshHome, { recursive: true })
      const configuredProviders = this.providerSettings.configuredProviders()
      writeFileSync(join(dshHome, 'settings.yaml'), buildProviderSettingsYaml(configuredProviders))
      const capabilityPatch = prepareAgentCapabilities(agent, this.dataDirectory, dshHome)
      const environmentProviders = [provider]
      if (agent.tools.includes('网页搜索') && provider.id !== 'deepseek-official') {
        const webProvider = this.providerSettings.getProvider('deepseek-official')
        if (webProvider) environmentProviders.push(webProvider)
      }
      entry = {
        harness: new DeepSeekHarness({
          ...this.packagedDshBin(),
          profile: 'sdk',
          patches: [capabilityPatch],
          provider: agent.provider,
          model: agent.model,
          cwd: this.workspace,
          processCwd: this.workspace,
          dshHome,
          env: {
            ...systemEnvironment(),
            ...providerEnvironment(environmentProviders),
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

  private packagedDshBin(): { dshBin?: string } {
    if (!process.resourcesPath) return {}
    const candidate = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    return existsSync(candidate) ? { dshBin: candidate } : {}
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

function providerEnvironment(providers: ModelProviderRuntimeConfig[]): Record<string, string> {
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

export function buildProviderSettingsYaml(providers: ModelProviderRuntimeConfig[]): string {
  const lines = ['llm-pi-ai:', '  providers:']
  for (const provider of providers) {
    if (provider.id === 'deepseek-official') continue
    if (provider.id === 'custom') {
      lines.push(
        '    custom:',
        `      displayName: ${JSON.stringify(provider.name)}`,
        '      apiKeyEnv: MINDMESH_CUSTOM_API_KEY',
        '      api: openai-completions',
        `      baseURL: ${JSON.stringify(provider.baseUrl)}`,
        '      models:',
        `        - id: ${JSON.stringify(provider.model)}`,
        `          name: ${JSON.stringify(provider.model)}`,
        '          contextWindow: 131072',
        '          maxTokens: 8192',
      )
      continue
    }
    const environmentKey = {
      'moonshotai-cn': 'MOONSHOT_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    }[provider.id as 'moonshotai-cn' | 'openai' | 'anthropic']
    if (environmentKey) {
      lines.push(`    ${provider.id}:`, `      apiKeyEnv: ${environmentKey}`)
      continue
    }
    const definition = getModelProviderDefinition(provider.id)
    const models = MODEL_CATALOG.filter((model) => model.provider === provider.id)
    lines.push(
      `    ${provider.id}:`,
      `      displayName: ${JSON.stringify(provider.name)}`,
      `      apiKeyEnv: ${definition?.environmentKey}`,
      '      api: openai-completions',
      `      baseURL: ${JSON.stringify(definition?.baseUrl)}`,
      '      models:',
      ...models.flatMap((model) => [
        `        - id: ${JSON.stringify(model.id)}`,
        `          name: ${JSON.stringify(model.name)}`,
        `          contextWindow: ${model.contextWindow ?? 131072}`,
        '          maxTokens: 8192',
      ]),
    )
  }
  if (lines.length === 2) return 'llm-pi-ai:\n  providers: {}\n'
  return `${lines.join('\n')}\n`
}
