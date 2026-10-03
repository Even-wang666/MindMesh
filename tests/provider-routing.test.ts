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
    const previousCredential = process.env.MINDMESH_TEST_CREDENTIAL
    process.env.MINDMESH_TEST_CREDENTIAL = 'must-not-reach-harness'
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
      expect(launches[0].env).toMatchObject({ DEEPSEEK_API_KEY: 'deepseek-secret' })
      expect(launches[0].env).not.toHaveProperty('OPENAI_API_KEY')
      expect(launches[1].env).toMatchObject({ OPENAI_API_KEY: 'openai-secret' })
      expect(launches[1].env).not.toHaveProperty('DEEPSEEK_API_KEY')
      expect(launches[0].env).not.toHaveProperty('MINDMESH_TEST_CREDENTIAL')
      expect(launches[1].env).not.toHaveProperty('MINDMESH_TEST_CREDENTIAL')

      const webAgent = { ...base, provider: 'openai', model: 'gpt-4.1', tools: ['网页搜索'] }
      await adapter.run(webAgent, '搜索网页', undefined, undefined, [], adapter.prepareRun(webAgent, 'full'))
      expect(launches[2].env).toMatchObject({
        OPENAI_API_KEY: 'openai-secret',
        DEEPSEEK_API_KEY: 'deepseek-secret',
      })
      const selected = join(directory, 'selected')
      await adapter.shutdownAll()
      adapter.setWorkspace(selected)
      await adapter.run(base, '新目录')
      expect(launches[3]).toMatchObject({ cwd: selected, processCwd: selected })
      expect(launches[3].dshHome).not.toBe(launches[0].dshHome)
    } finally {
      await adapter.shutdownAll()
      if (previousCredential === undefined) delete process.env.MINDMESH_TEST_CREDENTIAL
      else process.env.MINDMESH_TEST_CREDENTIAL = previousCredential
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
