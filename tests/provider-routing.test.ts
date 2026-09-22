import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/contracts'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'

const launches = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    constructor(options: Record<string, unknown>) { launches.push(options) }
    async run() { return { finalResponse: '完成', sessionId: 'session' } }
    async close() {}
  },
  JsonRpcResponseError: class extends Error {},
}))

import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'

describe('provider routing', () => {
  it('launches separate Harness processes with each Agent provider and model', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-route-'))
    const providers = [
      { id: 'deepseek-official', name: 'DeepSeek', apiKey: 'deepseek-secret' },
      { id: 'openai', name: 'OpenAI', apiKey: 'openai-secret' },
    ]
    const settings = {
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      configuredProviders: () => providers,
    } as unknown as ModelProviderSettings
    const base: Agent = { id: 'agent', name: 'Agent', role: '', persona: '', provider: 'deepseek-official',
      model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '' }
    const adapter = new DeepSeekHarnessAdapter(directory, directory, settings)
    try {
      launches.length = 0
      await adapter.run(base, '第一条')
      await adapter.run({ ...base, provider: 'openai', model: 'gpt-4.1' }, '第二条')
      expect(launches.map(({ provider, model }) => [provider, model])).toEqual([
        ['deepseek-official', 'deepseek-v4-flash'], ['openai', 'gpt-4.1'],
      ])
      expect(launches[0].dshHome).not.toBe(launches[1].dshHome)
      expect(launches.every((launch) => Array.isArray(launch.patches) && launch.patches.length === 1)).toBe(true)
    } finally {
      await adapter.shutdownAll()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
