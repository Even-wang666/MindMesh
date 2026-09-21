import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { Agent, RuntimeStatus } from '../shared/contracts'
import type { ModelProviderRuntimeConfig } from './model-provider-settings'
import { ModelProviderSettings } from './model-provider-settings'

type RuntimeEntry = {
  harness: DeepSeekHarness
  lastUsed: number
}

export class DeepSeekHarnessAdapter {
  private readonly runtimes = new Map<string, RuntimeEntry>()

  constructor(
    private readonly workspace: string,
    private readonly dataDirectory: string,
    private readonly providerSettings: ModelProviderSettings,
  ) {}

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

  async run(agent: Agent, prompt: string, sessionId?: string): Promise<{ text: string; sessionId?: string }> {
    const provider = this.providerSettings.getProvider(agent.provider)
    if (!provider) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const key = createHash('sha256')
      .update(JSON.stringify([agent.provider, agent.model, agent.persona, agent.skills, agent.tools]))
      .digest('hex')
    let entry = this.runtimes.get(key)
    if (!entry) {
      const dshHome = join(this.dataDirectory, 'harness', key.slice(0, 12))
      mkdirSync(dshHome, { recursive: true })
      const configuredProviders = this.providerSettings.configuredProviders()
      writeFileSync(join(dshHome, 'settings.yaml'), buildProviderSettingsYaml(configuredProviders))
      entry = {
        harness: new DeepSeekHarness({
          ...this.packagedDshBin(),
          profile: 'sdk',
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
    const result = await entry.harness.run(prompt, sessionId ? { sessionId } : undefined)
    return { text: result.finalResponse, sessionId: result.sessionId }
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
