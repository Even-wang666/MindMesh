import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, RuntimeStatus } from '../shared/contracts'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { ModelProviderSettings } from './model-provider-settings'
import { prepareAgentCapabilities } from './capabilities'

type RuntimeEntry = {
  harness: DeepSeekHarness
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

  async run(agent: Agent, prompt: string, sessionId?: string, onText?: (text: string, kind: 'text' | 'reasoning') => void): Promise<{ text: string; reasoning?: string; sessionId?: string }> {
    const provider = this.providerSettings.getProvider(agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const agentKey = getAgentCapabilityHash(agent)
    const key = this.workspace === process.cwd() ? agentKey
      : createHash('sha256').update(agentKey).update(this.workspace).digest('hex')
    let entry = this.runtimes.get(key)
    if (!entry) {
      const dshHome = join(this.dataDirectory, 'harness', key.slice(0, 12))
      mkdirSync(dshHome, { recursive: true })
      const configuredProviders = this.providerSettings.configuredProviders()
      writeFileSync(join(dshHome, 'settings.yaml'), buildProviderSettingsYaml(configuredProviders))
      const capabilityPatch = prepareAgentCapabilities(agent, this.dataDirectory, dshHome)
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
            ...process.env,
            ...providerEnvironment(configuredProviders),
            DSH_HOME: dshHome,
            ELECTRON_RUN_AS_NODE: '1',
          },
          maxTokens: 4096,
          initializeTimeoutMs: 30_000,
        }),
        lastUsed: Date.now(),
      }
      this.runtimes.set(key, entry)
    }
    entry.lastUsed = Date.now()
    const reasoning: string[] = []
    const assistantTexts: string[] = []
    const trace: string[] = []
    let result
    try {
      result = await entry.harness.run(prompt, {
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
    }
    return {
      text: assistantTexts.at(-1) ?? result.finalResponse,
      reasoning: (assistantTexts.length ? trace.slice(0, -1) : trace).join('\n\n') || undefined,
      sessionId: result.sessionId,
    }
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

export function getAgentCapabilityHash(agent: Agent): string {
  return createHash('sha256')
    .update(JSON.stringify([agent.provider, agent.model, agent.persona, agent.skills, agent.tools]))
    .digest('hex')
}

function providerEnvironment(providers: ModelProviderRuntimeConfig[]): Record<string, string> {
  const environmentKeys: Record<string, string> = {
    'deepseek-official': 'DEEPSEEK_API_KEY',
    'moonshotai-cn': 'MOONSHOT_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    custom: 'MINDMESH_CUSTOM_API_KEY',
  }
  return Object.fromEntries(providers.map((provider) => [environmentKeys[provider.id], provider.apiKey]))
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
    }[provider.id]
    lines.push(`    ${provider.id}:`, `      apiKeyEnv: ${environmentKey}`)
  }
  if (lines.length === 2) return 'llm-pi-ai:\n  providers: {}\n'
  return `${lines.join('\n')}\n`
}
