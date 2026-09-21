import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { Agent, RuntimeStatus } from '../shared/contracts'

type RuntimeEntry = {
  harness: DeepSeekHarness
  lastUsed: number
}

export class DeepSeekHarnessAdapter {
  private readonly runtimes = new Map<string, RuntimeEntry>()

  constructor(
    private readonly workspace: string,
    private readonly dataDirectory: string,
  ) {}

  status(): RuntimeStatus {
    if (!process.env.DEEPSEEK_API_KEY) {
      return {
        state: 'demo',
        label: '演示模式',
        detail: '未检测到 DEEPSEEK_API_KEY，界面与协作流程可用，模型回复使用本地模拟。',
        version: 'DeepSeek Harness 0.1.6-alpha.2',
      }
    }
    return {
      state: this.runtimes.size > 0 ? 'running' : 'ready',
      label: this.runtimes.size > 0 ? '正常运行' : '就绪',
      detail: 'DeepSeek Harness SDK 已配置，将在首次对话时启动。',
      version: 'DeepSeek Harness 0.1.6-alpha.2',
    }
  }

  async run(agent: Agent, prompt: string, sessionId?: string): Promise<{ text: string; sessionId?: string }> {
    if (!process.env.DEEPSEEK_API_KEY) {
      return { text: this.demoResponse(agent, prompt), sessionId }
    }

    const key = createHash('sha256')
      .update(JSON.stringify([agent.provider, agent.model, agent.persona, agent.skills, agent.tools]))
      .digest('hex')
    let entry = this.runtimes.get(key)
    if (!entry) {
      const dshHome = join(this.dataDirectory, 'harness', key.slice(0, 12))
      mkdirSync(dshHome, { recursive: true })
      entry = {
        harness: new DeepSeekHarness({
          ...this.packagedDshBin(),
          profile: 'sdk',
          provider: agent.provider,
          model: agent.model,
          cwd: this.workspace,
          processCwd: this.workspace,
          dshHome,
          env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
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
    return `我是 ${agent.name}，当前处于本地演示模式。\n\n我已经收到：${lastLine}\n\n配置 DeepSeek API Key 后，这里会由 ${agent.model} 通过统一 Harness Runtime 返回真实结果。`
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(entries.map((entry) => entry.harness.close()))
  }
}
